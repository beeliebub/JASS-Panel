// Files, backups and schedules over HTTP. The server rows are inserted directly, so these tests need no systemd; the process-level
// behaviour is covered by the lifecycle and backup suites.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/api/app.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { createSessionGate, type FetchLike } from "../../src/server/gate/session.js";
import type { FastifyInstance } from "fastify";

const OWNER = { id: "owner-feat", email: "owner@example.net", name: "Owner", role: "OWNER" };
const ADMIN = { id: "admin-feat", email: "admin@example.net", name: "Admin", role: "ADMIN" };
const USERS: Record<string, typeof OWNER | typeof ADMIN> = { owner: OWNER, admin: ADMIN };
const PANEL = { host: "example.net", origin: "https://example.net", "x-panel-request": "1", "content-type": "application/json" };

let root: string;
let directory: string;
let config: PanelConfig;
let db: PanelDatabase;
let app: FastifyInstance;

const website: FetchLike = (_url, init) => {
  const user = USERS[((init.headers as Record<string, string>).cookie ?? "").replace(/^session=/, "")];
  return Promise.resolve(
    user === undefined ? new Response(null, { status: 401 }) : new Response(JSON.stringify({ data: { user } }), { status: 200, headers: { "content-type": "application/json" } }),
  );
};

function call(method: string, url: string, who: "owner" | "admin", payload?: unknown) {
  // A JSON content type is only sent with a body, as the browser client does; Fastify refuses an empty JSON body.
  const { "content-type": _contentType, ...withoutType } = PANEL;
  return app.inject({
    method: method as "GET" | "POST" | "PUT" | "DELETE",
    url: `/panel/api/v1${url}`,
    headers: payload === undefined ? { ...withoutType, cookie: `session=${who}` } : { ...PANEL, cookie: `session=${who}` },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function body<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-features-"));
  directory = join(root, "alpha");
  mkdirSync(join(directory, "config"), { recursive: true });
  writeFileSync(join(directory, "config", "server.yml"), "motd: hello\n");
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  db.prepare("INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES ('alpha', 'Alpha', ?, ?, 'logs/latest.log', 'now', 'now')").run(directory, JSON.stringify(["/bin/true"]));
  app = createApp({ config, db, sessionGate: createSessionGate({ siteOrigin: config.siteOrigin, fetch: website, positiveTtlMs: 0, negativeTtlMs: 0 }) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("files", () => {
  it("refuses an admin without files.read, and lets one with it list and read", async () => {
    expect((await call("GET", "/servers/alpha/files?path=", "admin")).statusCode).toBe(403);
    db.prepare("INSERT INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, 'alpha', 'files.read', 'test', 'now')").run(ADMIN.id);
    const listing = await call("GET", "/servers/alpha/files?path=config", "admin");
    expect(listing.statusCode).toBe(200);
    expect(body<{ data: { entries: { name: string }[] } }>(listing).data.entries.map((entry) => entry.name)).toEqual(["server.yml"]);
    const read = await call("GET", "/servers/alpha/file?path=config/server.yml", "admin");
    expect(body<{ data: { text: string } }>(read).data.text).toBe("motd: hello\n");
  });

  it("refuses a traversal path with the jail's fixed message, without echoing the path", async () => {
    const response = await call("GET", "/servers/alpha/file?path=..%2F..%2Fetc%2Fpasswd", "owner");
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("etc/passwd");
  });

  it("writes a file, keeps the previous content in history, and audits the write", async () => {
    const write = await call("PUT", "/servers/alpha/file", "owner", { path: "config/server.yml", content: "motd: changed\n" });
    expect(write.statusCode).toBe(200);
    expect(readFileSync(join(directory, "config", "server.yml"), "utf8")).toBe("motd: changed\n");
    expect(readdirSync(join(config.paths.fileHistory, "alpha"))).toHaveLength(1);
    const audit = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'file.write' AND outcome = 'ok'").get() as { n: number };
    expect(audit.n).toBeGreaterThan(0);
  });
});

describe("backups", () => {
  it("lists an empty set, and refuses a restore of a backup that does not exist", async () => {
    const list = await call("GET", "/servers/alpha/backups", "owner");
    expect(body<{ data: { backups: unknown[] } }>(list).data.backups).toEqual([]);
    expect((await call("POST", "/servers/alpha/backups/99/restore", "owner")).statusCode).toBe(404);
  });

  it("removes a leftover folder only when the name is typed exactly", async () => {
    mkdirSync(join(root, "alpha.before-restore-20260101T000000000Z"));
    const wrong = await call("DELETE", "/servers/alpha/leftovers/alpha.before-restore-20260101T000000000Z", "owner", { confirm: "alpha" });
    expect(wrong.statusCode).toBe(409);
    expect((JSON.parse(wrong.body) as { error: { code: string } }).error.code).toBe("confirmation_required");
    const right = await call("DELETE", "/servers/alpha/leftovers/alpha.before-restore-20260101T000000000Z", "owner", { confirm: "alpha.before-restore-20260101T000000000Z" });
    expect(right.statusCode).toBe(200);
    expect(readdirSync(root)).not.toContain("alpha.before-restore-20260101T000000000Z");
  });
});

describe("player actions", () => {
  it("answers an inherited object name such as constructor with not found, never a console command", async () => {
    db.prepare("INSERT INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, 'alpha', 'players', 'test', 'now')").run(ADMIN.id);
    const response = await call("POST", "/servers/alpha/players/constructor", "admin", { name: "stop" });
    expect(response.statusCode).toBe(404);
    const toString = await call("POST", "/servers/alpha/players/toString", "admin", { name: "stop" });
    expect(toString.statusCode).toBe(404);
  });
});

describe("schedules", () => {
  it("refuses an invalid cron expression and an unknown kind, and accepts a valid one", async () => {
    expect((await call("POST", "/servers/alpha/schedules", "owner", { kind: "start", cron: "every tuesday", timezone: "UTC" })).statusCode).toBe(400);
    expect((await call("POST", "/servers/alpha/schedules", "owner", { kind: "explode", cron: "0 4 * * *", timezone: "UTC" })).statusCode).toBe(400);
    const created = await call("POST", "/servers/alpha/schedules", "owner", { kind: "start", cron: "0 4 * * *", timezone: "America/Chicago" });
    if (created.statusCode !== 201) throw new Error(`schedule not created: ${created.body}`);
    expect(created.statusCode).toBe(201);
    const id = body<{ data: { schedule: { id: number } } }>(created).data.schedule.id;
    expect(body<{ data: { schedules: unknown[] } }>(await call("GET", "/servers/alpha/schedules", "owner")).data.schedules).toHaveLength(1);
    expect((await call("DELETE", `/servers/alpha/schedules/${id}`, "owner")).statusCode).toBe(200);
  });

  it("refuses a command schedule whose text cannot be sent, and one without text", async () => {
    expect((await call("POST", "/servers/alpha/schedules", "owner", { kind: "command", cron: "0 4 * * *", timezone: "UTC" })).statusCode).toBe(400);
    expect((await call("POST", "/servers/alpha/schedules", "owner", { kind: "command", cron: "0 4 * * *", timezone: "UTC", payload: "say a\nstop" })).statusCode).toBe(400);
  });

  it("refuses a schedule from an admin who does not hold the action's capability", async () => {
    const response = await call("POST", "/servers/alpha/schedules", "admin", { kind: "start", cron: "0 4 * * *", timezone: "UTC" });
    expect([403]).toContain(response.statusCode);
  });
});

describe("scheduled warnings", () => {
  it("stores a stop's or restart's warning as its payload, and refuses a length the form does not offer or a payload on a stop", async () => {
    const stop = await call("POST", "/servers/alpha/schedules", "owner", { kind: "stop", cron: "0 4 * * *", timezone: "UTC", countdownSeconds: 60 });
    expect(stop.statusCode).toBe(201);
    const schedule = body<{ data: { schedule: { id: number; payload: string | null } } }>(stop).data.schedule;
    expect(schedule.payload).toBe('{"countdownSeconds":60}');
    expect((await call("POST", "/servers/alpha/schedules", "owner", { kind: "restart", cron: "0 5 * * *", timezone: "UTC", countdownSeconds: 45 })).statusCode).toBe(400);
    expect((await call("POST", "/servers/alpha/schedules", "owner", { kind: "stop", cron: "0 6 * * *", timezone: "UTC", payload: "say hi" })).statusCode).toBe(400);
    expect((await call("POST", "/servers/alpha/schedules", "owner", { kind: "backup", cron: "0 6 * * *", timezone: "UTC", countdownSeconds: 30 })).statusCode).toBe(400);
    expect((await call("DELETE", `/servers/alpha/schedules/${schedule.id}`, "owner")).statusCode).toBe(200);
  });
});

describe("restore records", () => {
  it("lists an unsettled restore with the folders it names, and clears it only when the server's name is typed, leaving the folders alone", async () => {
    const aside = join(root, "alpha.before-restore-clear");
    const staging = join(root, ".alpha-staging-clear");
    const record = join(config.paths.markers, "alpha.restore");
    mkdirSync(aside, { recursive: true });
    writeFileSync(join(aside, "world.dat"), "world");
    mkdirSync(config.paths.markers, { recursive: true, mode: 0o700 });
    writeFileSync(record, `${JSON.stringify({ directory, staging, aside, startedAt: "2026-10-11T00:00:00.000Z" })}\n`);
    try {
      const listed = body<{ data: { restoreRecord: { folders: { role: string; present: boolean }[] } | null } }>(await call("GET", "/servers/alpha/backups", "owner"));
      expect(listed.data.restoreRecord?.folders.map((folder) => [folder.role, folder.present])).toEqual([
        ["server", true],
        ["staging", false],
        ["aside", true],
      ]);
      const typoed = await call("POST", "/servers/alpha/backups/restore-record/clear", "owner", { confirm: "Not the name" });
      expect((JSON.parse(typoed.body) as { error: { code: string } }).error.code).toBe("confirmation_required");
      expect(existsSync(record)).toBe(true);
      expect((await call("POST", "/servers/alpha/backups/restore-record/clear", "owner", { confirm: "Alpha" })).statusCode).toBe(200);
      expect(existsSync(record)).toBe(false);
      expect(readFileSync(join(aside, "world.dat"), "utf8")).toBe("world");
      expect((await call("POST", "/servers/alpha/backups/restore-record/clear", "owner", { confirm: "Alpha" })).statusCode).toBe(404);
      const outcomes = db.prepare("SELECT outcome FROM audit WHERE action = 'backup.restore-record.clear' ORDER BY id").all() as { outcome: string }[];
      expect(outcomes.map((row) => row.outcome)).toEqual(["started", "ok"]);
    } finally {
      rmSync(record, { force: true });
      rmSync(aside, { recursive: true, force: true });
    }
  });

  it("refuses to clear a record while the server folder is missing and folders from the restore are beside it, even when the record cannot be read", async () => {
    // A second server whose folder is not there: the refusal is about the folder on disk, whatever the record says.
    db.prepare("INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES ('beta', 'Beta', ?, ?, 'logs/latest.log', 'now', 'now')").run(
      join(root, "beta"),
      JSON.stringify(["/bin/true"]),
    );
    const aside = join(root, "beta.before-restore-20261011T120000000Z");
    const record = join(config.paths.markers, "beta.restore");
    mkdirSync(aside, { recursive: true });
    mkdirSync(config.paths.markers, { recursive: true, mode: 0o700 });
    try {
      const readable = `${JSON.stringify({ directory: join(root, "beta"), staging: join(root, ".beta-staging"), aside, startedAt: "2026-10-11T00:00:00.000Z" })}\n`;
      for (const text of [readable, "{ not json"]) {
        writeFileSync(record, text);
        const listed = body<{ data: { restoreRecord: { clearable: boolean } | null } }>(await call("GET", "/servers/beta/backups", "owner"));
        expect(listed.data.restoreRecord?.clearable).toBe(false);
        const refused = await call("POST", "/servers/beta/backups/restore-record/clear", "owner", { confirm: "Beta" });
        expect(refused.statusCode).toBe(409);
        expect(existsSync(record)).toBe(true);
      }
    } finally {
      rmSync(record, { force: true });
      rmSync(aside, { recursive: true, force: true });
      db.prepare("DELETE FROM servers WHERE id = 'beta'").run();
    }
  });
});
