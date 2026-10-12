// The servers API driven over HTTP against the real systemd user manager, with a fake Paper. Identity comes from a stub website
// that answers by cookie, so every grant boundary is exercised with the same guard the production app uses. Units carry the
// jass-test- prefix and are removed in finally.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/api/app.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { createSessionGate, type FetchLike } from "../../src/server/gate/session.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { runProcess } from "../../src/server/systemd/run.js";
import { serviceFile } from "../../src/server/servers/files.js";
import { grantRows } from "./grants.js";

const FAKE_PAPER = fileURLToPath(new URL("../support/fake-paper.mjs", import.meta.url));
const ORIGIN = "https://example.net";
const PANEL = { host: "example.net", origin: ORIGIN, "x-panel-request": "1" };
const OWNER = { id: "owner-api", email: "owner@example.net", name: "Owner", role: "OWNER" as const };
const ADMIN = { id: "admin-api", email: "admin@example.net", name: "Admin", role: "ADMIN" as const };
const COOKIES: Record<string, typeof OWNER | typeof ADMIN> = { owner: OWNER, admin: ADMIN };

const AVAILABLE = (() => {
  const out = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" }).stdout.trim();
  return out === "running" || out === "degraded";
})();

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let app: Awaited<ReturnType<typeof createApp>>;
const created: string[] = [];

const stubWebsite: FetchLike = (_url, init) => {
  const cookie = (init.headers as Record<string, string>).cookie ?? "";
  const user = COOKIES[cookie.replace(/^session=/, "")];
  return Promise.resolve(
    user === undefined
      ? new Response(null, { status: 401 })
      : new Response(JSON.stringify({ data: { user } }), { status: 200, headers: { "content-type": "application/json" } }),
  );
};

/** The parsed body, typed by the caller. The shape is the one the route documents; a mismatch fails the assertion that uses it. */
function bodyOf<T>(response: { readonly body: string }): T {
  return JSON.parse(response.body) as T;
}

interface Envelope {
  readonly data?: { readonly state?: unknown; readonly servers?: { readonly id: string }[]; readonly lines?: { readonly text: string; readonly kind: string }[] };
  readonly error?: { readonly code: string; readonly details?: { readonly issues: { readonly path: string }[] } };
}

function inject(method: string, url: string, cookie: string, payload?: unknown) {
  return app.inject({
    method: method as "GET" | "POST" | "DELETE",
    url: `/panel/api/v1${url}`,
    headers: { ...PANEL, cookie: `session=${cookie}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function addBody(id: string) {
  const directory = join(root, id);
  mkdirSync(join(directory, "logs"), { recursive: true });
  return {
    id,
    displayName: `Test ${id}`,
    directory,
    command: { kind: "custom", argv: [process.execPath, FAKE_PAPER] },
  };
}

function freshId(): string {
  const id = `jass-test-api${Math.random().toString(36).slice(2, 7)}`;
  created.push(id);
  return id;
}

beforeAll(async () => {
  if (!AVAILABLE) return;
  root = mkdtempSync(join(tmpdir(), "jass-panel-api-"));
  config = loadConfig(
    {
      PANEL_PUBLIC_ORIGIN: ORIGIN,
      PANEL_DATA_DIR: join(root, "data"),
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "/tmp", ".config"),
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`,
    },
    { uid: process.getuid?.() ?? 0 },
  );
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  app = createApp({
    config,
    db,
    sessionGate: createSessionGate({ siteOrigin: config.siteOrigin, fetch: stubWebsite, positiveTtlMs: 0, negativeTtlMs: 0 }),
    run: runProcess,
    locks: new OperationLocks(),
  });
  await app.ready();
  mkdirSync(config.unitDir, { recursive: true });
});

afterAll(async () => {
  if (!AVAILABLE) return;
  for (const id of created) {
    await runProcess(["systemctl", "--user", "stop", "--", `jass-mc-${id}.service`], { timeoutMs: 130_000 });
    await runProcess(["systemctl", "--user", "disable", "--", `jass-mc-${id}.service`]);
    await runProcess(["systemctl", "--user", "reset-failed", "--", `jass-mc-${id}.service`]);
    rmSync(serviceFile(config.unitDir, id), { force: true });
    rmSync(join(config.unitDir, `jass-mc-${id}.socket`), { force: true });
    db.prepare("DELETE FROM servers WHERE id = ?").run(id);
  }
  await runProcess(["systemctl", "--user", "daemon-reload"]);
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
}, 180_000);

describe.skipIf(!AVAILABLE)("servers API", () => {
  it("refuses an ADMIN with no grants at the panel, so no list or add is ever answered for them", async () => {
    const list = await inject("GET", "/servers", "admin");
    expect(list.statusCode).toBe(403);
    expect(bodyOf<Envelope>(list).error?.code).toBe("no_access");
    const add = await inject("POST", "/servers", "admin", addBody(freshId()));
    expect(add.statusCode).toBe(403);
    expect(bodyOf<Envelope>(add).error?.code).toBe("no_access");
  });

  it("refuses an invalid body with the paths of the problems and without echoing the value sent", async () => {
    const response = await inject("POST", "/servers", "owner", { ...addBody("jass-test-bad"), id: "../escape", secret: "hunter2" });
    expect(response.statusCode).toBe(400);
    const body = bodyOf<Envelope>(response);
    expect(body.error?.code).toBe("invalid_request");
    expect(body.error?.details?.issues.length ?? 0).toBeGreaterThan(0);
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("../escape");
  });

  it("refuses a Paper preset whose minimum memory is more than its maximum, and creates nothing", async () => {
    const id = `jass-test-api${Math.random().toString(36).slice(2, 7)}`;
    const body = { ...addBody(id), command: { kind: "paper", javaPath: process.execPath, minMb: 2048, maxMb: 1024, jarFile: "paper.jar", extraFlags: [] } };
    const response = await inject("POST", "/servers", "owner", body);
    expect(response.statusCode).toBe(400);
    expect(bodyOf<Envelope>(response).error?.code).toBe("invalid_request");
    expect((await inject("GET", `/servers/${id}`, "owner")).statusCode).toBe(404);
  });

  it("runs a server through its lifecycle, with the console, and removes it", async () => {
    const id = freshId();
    const added = await inject("POST", "/servers", "owner", addBody(id));
    expect(added.statusCode).toBe(201);

    const started = await inject("POST", `/servers/${id}/power`, "owner", { action: "start" });
    expect(started.statusCode).toBe(200);
    expect(bodyOf<Envelope>(started).data?.state).toMatchObject({ known: true, activeState: "active" });

    const sent = await inject("POST", `/servers/${id}/console`, "owner", { line: "list" });
    expect(sent.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const history = await inject("GET", `/servers/${id}/console`, "owner");
    const lines = bodyOf<Envelope>(history).data?.lines ?? [];
    expect(lines.some((line) => line.text.includes("There are 0 of a max of 2 players online") && line.kind === "system")).toBe(true);

    const stopped = await inject("POST", `/servers/${id}/power`, "owner", { action: "stop" });
    expect(bodyOf<Envelope>(stopped).data?.state).toMatchObject({ known: true, activeState: "inactive" });

    const removed = await inject("DELETE", `/servers/${id}`, "owner");
    expect(removed.statusCode).toBe(200);
    const gone = await inject("GET", `/servers/${id}`, "owner");
    expect(gone.statusCode).toBe(404);
  }, 180_000);

  it("shows a server to an ADMIN who holds server.view, and refuses power without the power grant", async () => {
    const id = freshId();
    expect((await inject("POST", "/servers", "owner", addBody(id))).statusCode).toBe(201);
    grantRows(db, ADMIN.id, id, ["server.view"]);
    const list = bodyOf<Envelope>(await inject("GET", "/servers", "admin"));
    expect(list.data?.servers?.map((server) => server.id)).toContain(id);
    const power = await inject("POST", `/servers/${id}/power`, "admin", { action: "start" });
    expect(power.statusCode).toBe(403);
    expect(bodyOf<Envelope>(power).error?.code).toBe("forbidden");
    expect((await inject("DELETE", `/servers/${id}`, "admin")).statusCode).toBe(403);
  }, 60_000);

  it("refuses a state-changing request without the panel's header, whatever the grant", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/panel/api/v1/servers",
      headers: { host: "example.net", origin: ORIGIN, cookie: "session=owner", "content-type": "application/json" },
      payload: JSON.stringify(addBody(freshId())),
    });
    expect(response.statusCode).toBe(403);
    expect(bodyOf<Envelope>(response).error?.code).toBe("csrf_refused");
  });

  it("records the audit trail for the change in the same database", () => {
    const rows = db.prepare("SELECT action, outcome FROM audit ORDER BY id").all() as { action: string; outcome: string }[];
    expect(rows.some((row) => row.action === "server.add" && row.outcome === "ok")).toBe(true);
    expect(rows.some((row) => row.action === "power.start" && row.outcome === "ok")).toBe(true);
  });

  it("streams console lines over Server-Sent Events to the person who opened the stream, and ends it on request", async () => {
    const id = freshId();
    expect((await inject("POST", "/servers", "owner", addBody(id))).statusCode).toBe(201);
    expect((await inject("POST", `/servers/${id}/power`, "owner", { action: "start" })).statusCode).toBe(200);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/panel/api/v1/servers/${id}/console/stream`, {
      headers: { host: "example.net", cookie: "session=owner" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    await inject("POST", `/servers/${id}/console`, "owner", { line: "say streamed hello" });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("the stream has no body");
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 15_000;
    while (!text.includes("streamed hello") && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value as Uint8Array);
    }
    expect(text).toContain("event: line");
    expect(text).toContain("streamed hello");
    controller.abort();
    await inject("POST", `/servers/${id}/power`, "owner", { action: "stop" });
    await app.close();
    app = createApp({
      config,
      db,
      sessionGate: createSessionGate({ siteOrigin: config.siteOrigin, fetch: stubWebsite, positiveTtlMs: 0, negativeTtlMs: 0 }),
      run: runProcess,
      locks: new OperationLocks(),
    });
    await app.ready();
  }, 120_000);
});
