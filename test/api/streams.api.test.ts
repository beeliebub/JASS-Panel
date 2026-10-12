// An open stream ends at once when the grant it was opened under is removed, rather than at its next scheduled check. The app listens on a
// real socket here, because a stream held open cannot be read through the in-process injector.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/api/app.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { createSessionGate, type FetchLike } from "../../src/server/gate/session.js";

const OWNER = { id: "owner-streams", email: "owner@example.net", name: "Owner", role: "OWNER" };
const ADMIN = { id: "admin-streams", email: "admin@example.net", name: "Admin", role: "ADMIN" };
const USERS: Record<string, typeof OWNER | typeof ADMIN> = { owner: OWNER, admin: ADMIN };
const PANEL = { host: "example.net", origin: "https://example.net", "x-panel-request": "1", "content-type": "application/json" };

let root: string;
let db: PanelDatabase;
let app: FastifyInstance;
let base: string;

const website: FetchLike = (_url, init) => {
  const user = USERS[((init.headers as Record<string, string>).cookie ?? "").replace(/^session=/, "")];
  return Promise.resolve(
    user === undefined
      ? new Response(null, { status: 401 })
      : new Response(JSON.stringify({ data: { user } }), { status: 200, headers: { "content-type": "application/json" } }),
  );
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-streams-"));
  const config: PanelConfig = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  db.prepare("INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES ('alpha', 'alpha', ?, ?, 'logs/latest.log', 'now', 'now')").run(join(root, "alpha"), JSON.stringify(["/bin/true"]));
  app = createApp({ config, db, sessionGate: createSessionGate({ siteOrigin: config.siteOrigin, fetch: website, positiveTtlMs: 0, negativeTtlMs: 0 }) });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** Reads a stream to its end. */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<"ended"> {
  for (;;) {
    const next = await reader.read();
    if (next.done) return "ended";
  }
}

describe("a grant change closes open streams", () => {
  it("ends an open console stream at once when the grant it was opened under is removed", async () => {
    db.prepare("INSERT INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, 'alpha', 'console.read', 'test', 'now')").run(ADMIN.id);
    const response = await fetch(`${base}/panel/api/v1/servers/alpha/console/stream`, { headers: { cookie: "session=admin" } });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
    if (reader === undefined) throw new Error("the stream has no body");
    const opened = await reader.read();
    expect(new TextDecoder().decode(opened.value)).toContain("event: ready");
    const removed = await app.inject({
      method: "DELETE",
      url: "/panel/api/v1/access/grants",
      headers: { ...PANEL, cookie: "session=owner" },
      payload: JSON.stringify({ userId: ADMIN.id, serverId: "alpha", capability: "console.read" }),
    });
    expect(removed.statusCode).toBe(200);
    const outcome = await Promise.race([drain(reader), new Promise<"still open">((resolve) => setTimeout(() => resolve("still open"), 3000))]);
    expect(outcome).toBe("ended");
  });
});
