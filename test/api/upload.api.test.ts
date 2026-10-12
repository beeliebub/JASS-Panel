// Uploads, leftover folders under the server lock, and the power body, over HTTP. Server rows are inserted directly, so these tests need
// no systemd. The lock map is passed in so a test can hold a server's lock the way a running restore would.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/api/app.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { createSessionGate, type FetchLike } from "../../src/server/gate/session.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { checkDirectory } from "../../src/server/servers/service.js";
import { runProcess } from "../../src/server/systemd/run.js";
import { UPLOAD_MAX_BYTES } from "../../src/shared/features.js";
import { PassThrough } from "node:stream";

const OWNER = { id: "owner-upload", email: "owner@example.net", name: "Owner", role: "OWNER" };
const ADMIN = { id: "admin-upload", email: "admin@example.net", name: "Admin", role: "ADMIN" };
const USERS: Record<string, typeof OWNER | typeof ADMIN> = { owner: OWNER, admin: ADMIN };
const PANEL_HEADERS = { host: "example.net", origin: "https://example.net", "x-panel-request": "1" };

let root: string;
let directory: string;
let config: PanelConfig;
let db: PanelDatabase;
let locks: OperationLocks;
let app: FastifyInstance;

const website: FetchLike = (_url, init) => {
  const user = USERS[((init.headers as Record<string, string>).cookie ?? "").replace(/^session=/, "")];
  return Promise.resolve(
    user === undefined ? new Response(null, { status: 401 }) : new Response(JSON.stringify({ data: { user } }), { status: 200, headers: { "content-type": "application/json" } }),
  );
};

/** Sends one request with the given body bytes and content type. A null caller sends no cookie, as an anonymous browser would. */
function raw(method: "PUT" | "POST" | "DELETE", url: string, who: "owner" | "admin" | null, payload: Buffer | string, contentType: string) {
  return app.inject({
    method,
    url: `/panel/api/v1${url}`,
    headers: { ...PANEL_HEADERS, "content-type": contentType, ...(who === null ? {} : { cookie: `session=${who}` }) },
    payload,
  });
}

function json(method: "PUT" | "POST" | "DELETE", url: string, who: "owner" | "admin", payload: unknown) {
  return raw(method, url, who, JSON.stringify(payload), "application/json");
}

function errorCode(response: { body: string }): string {
  return (JSON.parse(response.body) as { error: { code: string } }).error.code;
}

function errorMessage(response: { body: string }): string {
  return (JSON.parse(response.body) as { error: { message: string } }).error.message;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-upload-"));
  directory = join(root, "alpha");
  mkdirSync(join(directory, "config"), { recursive: true });
  mkdirSync(join(directory, "uploads"), { recursive: true });
  writeFileSync(join(directory, "config", "server.yml"), "motd: hello\n");
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  db.prepare("INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES ('alpha', 'Alpha', ?, ?, 'logs/latest.log', 'now', 'now')").run(directory, JSON.stringify(["/bin/true"]));
  locks = new OperationLocks();
  app = createApp({ config, db, locks, sessionGate: createSessionGate({ siteOrigin: config.siteOrigin, fetch: website, positiveTtlMs: 0, negativeTtlMs: 0 }) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function historyCount(): number {
  try {
    return readdirSync(join(config.paths.fileHistory, "alpha")).length;
  } catch {
    return 0;
  }
}

describe("uploads", () => {
  it("stores the bytes exactly as sent, including bytes that are not UTF-8, and keeps the previous version when replaced", async () => {
    const first = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x7f]);
    const created = await raw("PUT", "/servers/alpha/upload?path=uploads%2Fblob.bin", "owner", first, "application/octet-stream");
    expect(created.statusCode).toBe(200);
    expect(readFileSync(join(directory, "uploads", "blob.bin"))).toEqual(first);

    const before = historyCount();
    const second = Buffer.from("replacement\n");
    const replaced = await raw("PUT", "/servers/alpha/upload?path=uploads%2Fblob.bin", "owner", second, "application/octet-stream");
    expect(replaced.statusCode).toBe(200);
    expect(readFileSync(join(directory, "uploads", "blob.bin"))).toEqual(second);
    expect(historyCount()).toBe(before + 1);
    const audit = db.prepare("SELECT details FROM audit WHERE action = 'file.upload' AND outcome = 'ok' ORDER BY id DESC LIMIT 1").get() as { details: string };
    expect(JSON.parse(audit.details)).toEqual({ path: "uploads/blob.bin", bytes: second.length });
  });

  it("refuses a traversal path, a missing folder, and a folder as the target, with the jail's messages", async () => {
    const traversal = await raw("PUT", "/servers/alpha/upload?path=..%2Fescape.bin", "owner", Buffer.from("x"), "application/octet-stream");
    expect(traversal.statusCode).toBe(400);
    expect(traversal.body).not.toContain("escape.bin");
    const missing = await raw("PUT", "/servers/alpha/upload?path=nowhere%2Fx.bin", "owner", Buffer.from("x"), "application/octet-stream");
    expect(missing.statusCode).toBe(400);
    const folder = await raw("PUT", "/servers/alpha/upload?path=config", "owner", Buffer.from("x"), "application/octet-stream");
    expect(folder.statusCode).toBe(400);
    expect(readFileSync(join(directory, "config", "server.yml"), "utf8")).toBe("motd: hello\n");
  });

  it("answers 415 to any other content type, and stores nothing", async () => {
    const response = await json("PUT", "/servers/alpha/upload?path=uploads%2Fjson.bin", "owner", { path: "uploads/json.bin", content: "x" });
    expect(response.statusCode).toBe(415);
    expect(errorCode(response)).toBe("unsupported_media_type");
    expect(readdirSync(join(directory, "uploads"))).not.toContain("json.bin");
  });

  it("answers 413 to a file over the limit, and stores nothing", async () => {
    const response = await raw("PUT", "/servers/alpha/upload?path=uploads%2Fbig.bin", "owner", Buffer.alloc(UPLOAD_MAX_BYTES + 1), "application/octet-stream");
    expect(response.statusCode).toBe(413);
    expect(errorCode(response)).toBe("payload_too_large");
    expect(readdirSync(join(directory, "uploads"))).not.toContain("big.bin");
  });

  it("refuses an anonymous oversized upload as unauthenticated, before the body is read", async () => {
    const response = await raw("PUT", "/servers/alpha/upload?path=uploads%2Fanon.bin", null, Buffer.alloc(UPLOAD_MAX_BYTES + 1), "application/octet-stream");
    expect(response.statusCode).toBe(401);
    expect(errorCode(response)).toBe("unauthenticated");
  });

  it("refuses an admin without files.write", async () => {
    const response = await raw("PUT", "/servers/alpha/upload?path=uploads%2Fadmin.bin", "admin", Buffer.from("x"), "application/octet-stream");
    expect(response.statusCode).toBe(403);
    expect(readdirSync(join(directory, "uploads"))).not.toContain("admin.bin");
  });
});

describe("leftover folders", () => {
  const staging = ".alpha.restore-20260102T000000000Z";
  const aside = "alpha.before-restore-20260102T000000000Z";

  it("lists a staging folder a restore left behind, as well as one moved aside", async () => {
    mkdirSync(join(root, staging));
    mkdirSync(join(root, aside));
    const response = await app.inject({ method: "GET", url: "/panel/api/v1/servers/alpha/leftovers", headers: { ...PANEL_HEADERS, cookie: "session=owner" } });
    const names = (JSON.parse(response.body) as { data: { leftovers: string[] } }).data.leftovers;
    expect(names).toEqual([aside, staging].sort());
  });

  it("refuses removal while the server's lock is held, and removes the folder once it is free", async () => {
    const release = locks.tryAcquire("alpha", "restore");
    const refused = await json("DELETE", `/servers/alpha/leftovers/${staging}`, "owner", { confirm: staging });
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe("conflict");
    expect(readdirSync(root)).toContain(staging);
    release?.();

    const removed = await json("DELETE", `/servers/alpha/leftovers/${staging}`, "owner", { confirm: staging });
    expect(removed.statusCode).toBe(200);
    expect(readdirSync(root)).not.toContain(staging);
  });
});

describe("the power body", () => {
  it("refuses a countdown on a start, and a countdown outside the allowed range", async () => {
    const onStart = await json("POST", "/servers/alpha/power", "owner", { action: "start", countdownSeconds: 30 });
    expect(onStart.statusCode).toBe(400);
    expect(errorCode(onStart)).toBe("invalid_request");
    expect((await json("POST", "/servers/alpha/power", "owner", { action: "stop", countdownSeconds: 301 })).statusCode).toBe(400);
    expect((await json("POST", "/servers/alpha/power", "owner", { action: "stop", countdownSeconds: -1 })).statusCode).toBe(400);
  });

  it("refuses a countdown from an account without the power capability", async () => {
    const response = await json("POST", "/servers/alpha/power", "admin", { action: "stop", countdownSeconds: 30 });
    expect(response.statusCode).toBe(403);
  });
});

describe("the guards around uploads and leftovers", () => {
  it("refuses an upload while a restore holds the server", async () => {
    const release = locks.tryAcquire("alpha", "restore");
    const response = await raw("PUT", "/servers/alpha/upload?path=uploads%2Fduring.bin", "owner", Buffer.from("x"), "application/octet-stream");
    expect(response.statusCode).toBe(409);
    release?.();
    expect(readdirSync(join(directory, "uploads"))).not.toContain("during.bin");
  });

  it("refuses a raw body on any route other than the upload, without reading it", async () => {
    const response = await raw("POST", "/servers/alpha/console", "owner", Buffer.alloc(1024 * 1024), "application/octet-stream");
    expect(response.statusCode).toBe(415);
    expect(errorCode(response)).toBe("unsupported_media_type");
  });

  it("never removes a server's own folder, even when its name has the shape of a leftover", async () => {
    const adopted = "alpha.before-restore-20260102T000000000Z";
    db.prepare("INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES ('beta', 'Beta', ?, ?, 'logs/latest.log', 'now', 'now')").run(join(root, adopted), JSON.stringify(["/bin/true"]));
    const refused = await json("DELETE", `/servers/alpha/leftovers/${adopted}`, "owner", { confirm: adopted });
    expect(refused.statusCode).toBe(409);
    expect(readdirSync(root)).toContain(adopted);
    db.prepare("DELETE FROM servers WHERE id = 'beta'").run();
  });

  it("refuses a folder inside another server's folder, and a folder whose name only begins with two dots", () => {
    mkdirSync(join(root, "alpha", "child"), { recursive: true });
    expect(() => checkDirectory({ db, config, run: runProcess }, join(root, "alpha", "child"))).toThrow(/overlaps server alpha/);
    const dotted = join(root, "..x");
    mkdirSync(join(dotted, "data"), { recursive: true });
    const holding = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(dotted, "data") }, { uid: 1000 });
    expect(() => checkDirectory({ db, config: holding, run: runProcess }, dotted)).toThrow(/cannot be inside a server directory/);
  });

  it("refuses a server folder that holds the panel's data directory", () => {
    const parent = join(root, "holder");
    mkdirSync(join(parent, "data"), { recursive: true });
    const dataAt = join(parent, "data");
    const holding = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: dataAt }, { uid: 1000 });
    expect(() => checkDirectory({ db, config: holding, run: runProcess }, parent)).toThrow(/cannot be inside a server directory/);
    mkdirSync(join(root, "elsewhere"));
    expect(checkDirectory({ db, config: holding, run: runProcess }, join(root, "elsewhere"))).toBe(join(root, "elsewhere"));
  });
});

describe("text saves and leftover guards, second round", () => {
  it("saves a text file of 100 KiB, which the editor allows", async () => {
    const response = await json("PUT", "/servers/alpha/file", "owner", { path: "config/big.yml", content: "x".repeat(100 * 1024) });
    expect(response.statusCode).toBe(200);
    expect(readFileSync(join(directory, "config", "big.yml"), "utf8")).toHaveLength(100 * 1024);
  });

  it("refuses to remove a leftover while an unsettled restore record exists", async () => {
    const leftover = "alpha.before-restore-20260104T000000000Z";
    mkdirSync(join(root, leftover));
    const record = join(config.paths.markers, "alpha.restore");
    mkdirSync(config.paths.markers, { recursive: true });
    writeFileSync(record, JSON.stringify({ directory, staging: join(root, ".alpha.restore-20260104T000000000Z"), aside: join(root, leftover), startedAt: "2026-01-04T00:00:00.000Z" }));
    const refused = await json("DELETE", `/servers/alpha/leftovers/${leftover}`, "owner", { confirm: leftover });
    expect(refused.statusCode).toBe(409);
    expect(readdirSync(root)).toContain(leftover);
    rmSync(record, { force: true });
    const removed = await json("DELETE", `/servers/alpha/leftovers/${leftover}`, "owner", { confirm: leftover });
    expect(removed.statusCode).toBe(200);
  });
});

describe("removing a server with an unsettled restore record", () => {
  it("refuses removal until the record is gone, and keeps the server row", async () => {
    mkdirSync(config.paths.markers, { recursive: true });
    const record = join(config.paths.markers, "alpha.restore");
    writeFileSync(record, JSON.stringify({ directory, staging: join(root, ".alpha.restore-20260105T000000000Z"), aside: join(root, "alpha.before-restore-20260105T000000000Z"), startedAt: "2026-01-05T00:00:00.000Z" }));
    const refused = await app.inject({ method: "DELETE", url: "/panel/api/v1/servers/alpha", headers: { ...PANEL_HEADERS, cookie: "session=owner" } });
    expect(refused.statusCode).toBe(409);
    expect(errorMessage(refused)).toMatch(/has not settled/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM servers WHERE id = ?").get("alpha")).toEqual({ n: 1 });
    rmSync(record, { force: true });
  });
});

/**
 * A request whose body is a stream the test ends itself, so the upload is still arriving while the test does other things. The length it
 * declares is sent as its Content-Length, which an upload must carry.
 */
function streamed(who: "owner" | "admin", url: string, body: PassThrough, declared: number) {
  return app.inject({
    method: "PUT",
    url: `/panel/api/v1${url}`,
    headers: { ...PANEL_HEADERS, "content-type": "application/octet-stream", "content-length": String(declared), cookie: `session=${who}` },
    payload: body,
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Polls until a condition holds, for up to two seconds: a refusal is recorded a moment after the response is decided. */
async function until(check: () => boolean): Promise<void> {
  for (let waited = 0; !check() && waited < 2000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
}

function failedUploadRecorded(path: string): boolean {
  const rows = db.prepare("SELECT details FROM audit WHERE action = 'file.upload' AND outcome = 'failed'").all() as { details: string }[];
  return rows.some((row) => row.details.includes(path));
}

describe("the length an upload declares", () => {
  it("refuses an upload that does not say how long it is, and stores nothing", async () => {
    const body = new PassThrough();
    const sent = app.inject({
      method: "PUT",
      url: "/panel/api/v1/servers/alpha/upload?path=uploads/unsized.bin",
      headers: { ...PANEL_HEADERS, "content-type": "application/octet-stream", cookie: "session=owner" },
      payload: body,
    });
    body.end("x");
    const response = await sent;
    expect(response.statusCode).toBe(400);
    expect(errorMessage(response)).toMatch(/say how long/);
    expect(existsSync(join(directory, "uploads", "unsized.bin"))).toBe(false);
  });

  it("answers 413 to a declared length over the limit before any byte is read", async () => {
    const body = new PassThrough();
    const response = await streamed("owner", "/servers/alpha/upload?path=uploads/declared-big.bin", body, UPLOAD_MAX_BYTES + 1);
    body.destroy();
    expect(response.statusCode).toBe(413);
    expect(errorCode(response)).toBe("payload_too_large");
  });

  it("refuses a body that runs past the length it declared, and leaves the file out", async () => {
    const body = new PassThrough();
    const sent = streamed("owner", "/servers/alpha/upload?path=uploads/overrun.bin", body, 4);
    await settle();
    body.end("too long");
    // The refusal ends the request in the middle of its body, so the client may see the connection close rather than the answer. What must
    // hold is that nothing is stored and that the attempt is recorded, and the test waits for that record before it looks.
    await sent.catch(() => undefined);
    await until(() => failedUploadRecorded("uploads/overrun.bin"));
    expect(failedUploadRecorded("uploads/overrun.bin")).toBe(true);
    expect(existsSync(join(directory, "uploads", "overrun.bin"))).toBe(false);
    expect(readdirSync(join(directory, "uploads")).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });
});

describe("uploads that are still arriving", () => {
  it("refuses a third upload while two are being received, and finishes the two once their bytes arrive", async () => {
    const first = new PassThrough();
    const second = new PassThrough();
    const pending = [
      streamed("owner", "/servers/alpha/upload?path=uploads/first.bin", first, "first".length),
      streamed("owner", "/servers/alpha/upload?path=uploads/second.bin", second, "second".length),
    ];
    await settle();
    const third = await raw("PUT", "/servers/alpha/upload?path=uploads/third.bin", "owner", Buffer.from("third"), "application/octet-stream");
    expect(third.statusCode).toBe(409);
    expect(errorCode(third)).toBe("conflict");
    first.end("first");
    second.end("second");
    const [a, b] = await Promise.all(pending);
    expect(a?.statusCode).toBe(200);
    expect(b?.statusCode).toBe(200);
    expect(readFileSync(join(directory, "uploads", "first.bin"), "utf8")).toBe("first");
    expect(existsSync(join(directory, "uploads", "third.bin"))).toBe(false);
  });

  it("refuses to replace a file once the person's permission has gone, even though the upload was allowed when it began", async () => {
    db.prepare("INSERT INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, 'alpha', 'files.write', 'test', 'now')").run(ADMIN.id);
    try {
      const body = new PassThrough();
      const sent = streamed("admin", "/servers/alpha/upload?path=uploads/revoked.bin", body, "late bytes".length);
      await settle();
      db.prepare("DELETE FROM grants WHERE user_id = ?").run(ADMIN.id);
      body.end("late bytes");
      const response = await sent;
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe("forbidden");
      expect(existsSync(join(directory, "uploads", "revoked.bin"))).toBe(false);
    } finally {
      db.prepare("DELETE FROM grants WHERE user_id = ?").run(ADMIN.id);
    }
  });
});
