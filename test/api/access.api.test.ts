// The grants editor, the audit view and the denial record, over HTTP. Identity comes from a stub website by cookie, so the same
// guard the production app uses decides every case.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/api/app.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { createSessionGate, type FetchLike } from "../../src/server/gate/session.js";
import type { AccountsAnswer } from "../../src/server/gate/accounts.js";
import type { FastifyInstance } from "fastify";

const OWNER = { id: "owner-acc", email: "owner@example.net", name: "Owner", role: "OWNER" };
const ADMIN = { id: "admin-acc", email: "admin@example.net", name: "Admin", role: "ADMIN" };
const OTHER = { id: "other-acc", email: "other@example.net", name: "Other", role: "ADMIN" };
const USERS: Record<string, typeof OWNER | typeof ADMIN> = { owner: OWNER, admin: ADMIN, other: OTHER };
const PANEL = { host: "example.net", origin: "https://example.net", "x-panel-request": "1", "content-type": "application/json" };

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let app: FastifyInstance;

const website: FetchLike = (_url, init) => {
  const cookie = ((init.headers as Record<string, string>).cookie ?? "").replace(/^session=/, "");
  const user = USERS[cookie];
  return Promise.resolve(
    user === undefined
      ? new Response(null, { status: 401 })
      : new Response(JSON.stringify({ data: { user } }), { status: 200, headers: { "content-type": "application/json" } }),
  );
};

function call(method: string, url: string, who: "owner" | "admin", payload?: unknown) {
  return app.inject({
    method: method as "GET" | "POST" | "DELETE",
    url: `/panel/api/v1${url}`,
    headers: { ...PANEL, cookie: `session=${who}` },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function insertServer(id: string): void {
  db.prepare(
    "INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES (?, ?, ?, ?, 'logs/latest.log', 'now', 'now')",
  ).run(id, id, join(root, id), JSON.stringify(["/bin/true"]));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-access-"));
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  insertServer("alpha");
  insertServer("beta");
  app = createApp({
    config,
    db,
    sessionGate: createSessionGate({ siteOrigin: config.siteOrigin, fetch: website, positiveTtlMs: 0, negativeTtlMs: 0 }),
    accounts: { list: () => Promise.resolve({ kind: "unavailable" as const }) },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the accounts the access screen lists", () => {
  let answer: AccountsAnswer = { kind: "unavailable" };
  // The cookie each request to the website's account list was made with, in order.
  let asked: (string | undefined)[] = [];
  let listed: FastifyInstance;

  beforeAll(async () => {
    listed = createApp({
      config,
      db,
      sessionGate: createSessionGate({ siteOrigin: config.siteOrigin, fetch: website, positiveTtlMs: 0, negativeTtlMs: 0 }),
      accounts: {
        list: (cookie) => {
          asked.push(cookie);
          return Promise.resolve(answer);
        },
      },
    });
    await listed.ready();
  });

  afterAll(async () => {
    await listed.close();
  });

  function access(who: "owner" | "admin") {
    return listed.inject({ method: "GET", url: "/panel/api/v1/access", headers: { host: "example.net", cookie: `session=${who}` } });
  }

  it("lists the website's accounts for an owner, including one that has never opened the panel, asked with the owner's cookie", async () => {
    asked = [];
    answer = {
      kind: "ok",
      accounts: [
        { id: OWNER.id, email: OWNER.email, name: OWNER.name, role: "OWNER" },
        { id: "fresh-admin", email: "fresh@example.net", name: null, role: "ADMIN" },
      ],
    };
    const response = await access("owner");
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: { usersFrom: string; users: { id: string; lastSeen: string | null }[] } };
    expect(body.data.usersFrom).toBe("website");
    expect(asked).toEqual(["session=owner"]);
    expect(body.data.users.map((user) => user.id)).toEqual([OWNER.id, "fresh-admin"]);
    expect(body.data.users.find((user) => user.id === "fresh-admin")?.lastSeen).toBeNull();
  });

  it("falls back to the people this panel has seen, and says so, when the website cannot be asked", async () => {
    // The owner's first request in this file records them as seen, which is what the fallback lists.
    await listed.inject({ method: "GET", url: "/panel/api/v1/me", headers: { host: "example.net", cookie: "session=owner" } });
    answer = { kind: "unavailable" };
    const response = await access("owner");
    const body = JSON.parse(response.body) as { data: { usersFrom: string; users: { id: string }[] } };
    expect(body.data.usersFrom).toBe("website-unavailable");
    expect(body.data.users.map((user) => user.id)).toContain(OWNER.id);
    expect(body.data.users.map((user) => user.id)).not.toContain("fresh-admin");
  });

  it("shows an ADMIN who holds access.manage only the people this panel has seen, and does not ask the website on their behalf", async () => {
    db.prepare("INSERT OR IGNORE INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, '*', 'access.manage', 'test', 'now')").run(OTHER.id);
    try {
      asked = [];
      answer = { kind: "ok", accounts: [{ id: OWNER.id, email: OWNER.email, name: OWNER.name, role: "OWNER" }] };
      const response = await listed.inject({ method: "GET", url: "/panel/api/v1/access", headers: { host: "example.net", cookie: "session=other" } });
      expect(response.statusCode).toBe(200);
      expect((JSON.parse(response.body) as { data: { usersFrom: string } }).data.usersFrom).toBe("seen");
      expect(asked).toEqual([]);
    } finally {
      db.prepare("DELETE FROM grants WHERE user_id = ? AND capability = 'access.manage' AND granted_by = 'test'").run(OTHER.id);
    }
  });

  it("shows a panel operator the website's accounts, asked with the operator's cookie", async () => {
    db.prepare("INSERT OR IGNORE INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, '*', 'panel.operator', 'test', 'now')").run(OTHER.id);
    try {
      asked = [];
      answer = { kind: "ok", accounts: [] };
      const response = await listed.inject({ method: "GET", url: "/panel/api/v1/access", headers: { host: "example.net", cookie: "session=other" } });
      expect(response.statusCode).toBe(200);
      expect((JSON.parse(response.body) as { data: { usersFrom: string } }).data.usersFrom).toBe("website");
      expect(asked).toEqual(["session=other"]);
    } finally {
      db.prepare("DELETE FROM grants WHERE user_id = ? AND capability = 'panel.operator' AND granted_by = 'test'").run(OTHER.id);
    }
  });

  it("passes on the website's refusal of an owner's session as an unauthenticated answer", async () => {
    answer = { kind: "refused", status: 401 };
    const response = await access("owner");
    expect(response.statusCode).toBe(401);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe("unauthenticated");
  });
});

describe("grants", () => {
  it("lets an owner grant a server capability and shows the grant on the access screen", async () => {
    const granted = await call("POST", "/access/grants", "owner", { userId: ADMIN.id, serverId: "alpha", capability: "server.view" });
    expect(granted.statusCode).toBe(201);
    const list = JSON.parse((await call("GET", "/access", "owner")).body) as { data: { grants: { serverId: string; capability: string }[] } };
    expect(list.data.grants.some((grant) => grant.serverId === "alpha" && grant.capability === "server.view")).toBe(true);
  });

  it("refuses a grant from an admin, even one who holds access.manage", async () => {
    db.prepare("INSERT OR IGNORE INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, '*', 'access.manage', 'test', 'now')").run(ADMIN.id);
    const response = await call("POST", "/access/grants", "admin", { userId: ADMIN.id, serverId: "beta", capability: "server.view" });
    expect(response.statusCode).toBe(403);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("lets an admin with access.manage see the access screen", async () => {
    expect((await call("GET", "/access", "admin")).statusCode).toBe(200);
  });

  it("refuses a panel capability scoped to one server, an unknown capability, and an unknown server", async () => {
    expect((await call("POST", "/access/grants", "owner", { userId: ADMIN.id, serverId: "alpha", capability: "servers.manage" })).statusCode).toBe(400);
    expect((await call("POST", "/access/grants", "owner", { userId: ADMIN.id, serverId: "alpha", capability: "make.coffee" })).statusCode).toBe(400);
    expect((await call("POST", "/access/grants", "owner", { userId: ADMIN.id, serverId: "ghost", capability: "power" })).statusCode).toBe(400);
  });

  it("refuses an id that is not a server slug, so a constructor or prototype name cannot become a grant", async () => {
    expect((await call("POST", "/access/grants", "owner", { userId: ADMIN.id, serverId: "__proto__", capability: "power" })).statusCode).toBe(400);
    expect((await call("POST", "/access/grants", "owner", { userId: ADMIN.id, serverId: "constructor", capability: "power" })).statusCode).toBe(400);
  });

  it("lets an owner revoke a grant, and says so when there was none", async () => {
    expect((await call("DELETE", "/access/grants", "owner", { userId: ADMIN.id, serverId: "alpha", capability: "server.view" })).statusCode).toBe(200);
    expect((await call("DELETE", "/access/grants", "owner", { userId: ADMIN.id, serverId: "alpha", capability: "server.view" })).statusCode).toBe(404);
  });
});

describe("audit view", () => {
  it("shows an owner every row", async () => {
    const response = JSON.parse((await call("GET", "/audit", "owner")).body) as { data: { rows: { action: string }[] } };
    expect(response.data.rows.some((row) => row.action === "access.grant")).toBe(true);
  });

  it("shows a server-viewer the rows for servers they may view, and nothing about the panel as a whole", async () => {
    db.prepare("DELETE FROM grants WHERE user_id = ?").run(ADMIN.id);
    db.prepare("INSERT INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, 'alpha', 'server.view', 'test', 'now')").run(ADMIN.id);
    db.prepare("INSERT INTO audit (at, user_label, server_id, action, outcome) VALUES ('now', 'x', 'alpha', 'power.start', 'ok')").run();
    db.prepare("INSERT INTO audit (at, user_label, server_id, action, outcome) VALUES ('now', 'x', 'beta', 'power.stop', 'ok')").run();
    db.prepare("INSERT INTO audit (at, user_label, server_id, action, outcome) VALUES ('now', 'x', NULL, 'privileged.enable-lingering', 'ok')").run();
    const response = JSON.parse((await call("GET", "/audit", "admin")).body) as { data: { rows: { action: string; serverId: string | null }[] } };
    const actions = response.data.rows.map((row) => row.action);
    expect(actions).toContain("power.start");
    expect(actions).not.toContain("power.stop");
    expect(actions).not.toContain("privileged.enable-lingering");
  });

  it("records a refused attempt in the audit log, once per window", async () => {
    await call("POST", "/servers", "admin", { id: "x", displayName: "x", directory: "/x", command: { kind: "custom", argv: ["/bin/true"] } });
    await call("POST", "/servers", "admin", { id: "x", displayName: "x", directory: "/x", command: { kind: "custom", argv: ["/bin/true"] } });
    const rows = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'denied.servers.add'").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe("panel operators", () => {
  const designate = () => call("POST", "/access/grants", "owner", { userId: ADMIN.id, serverId: "*", capability: "panel.operator" });
  const undesignate = () => call("DELETE", "/access/grants", "owner", { userId: ADMIN.id, serverId: "*", capability: "panel.operator" });

  it("lets an owner make an admin a panel operator, who then reaches every server, including one added later", async () => {
    db.prepare("DELETE FROM grants WHERE user_id = ?").run(ADMIN.id);
    expect((await designate()).statusCode).toBe(201);
    expect((await call("GET", "/servers/alpha/backups", "admin")).statusCode).toBe(200);
    insertServer("gamma");
    expect((await call("GET", "/servers/gamma/schedules", "admin")).statusCode).toBe(200);
    expect((await undesignate()).statusCode).toBe(200);
  });

  it("lets an operator change grants and make or remove another operator, as an owner can", async () => {
    db.prepare("DELETE FROM grants WHERE user_id = ?").run(ADMIN.id);
    await designate();
    expect((await call("POST", "/access/grants", "admin", { userId: OTHER.id, serverId: "*", capability: "panel.operator" })).statusCode).toBe(201);
    expect((await call("POST", "/access/grants", "admin", { userId: OTHER.id, serverId: "beta", capability: "power" })).statusCode).toBe(201);
    expect((await call("DELETE", "/access/grants", "admin", { userId: OTHER.id, serverId: "*", capability: "panel.operator" })).statusCode).toBe(200);
    await undesignate();
    db.prepare("DELETE FROM grants WHERE user_id = ?").run(OTHER.id);
  });

  it("gives an operator the access list and the Discord webhook, as an owner has them", async () => {
    db.prepare("DELETE FROM grants WHERE user_id = ?").run(ADMIN.id);
    await designate();
    expect((await call("GET", "/access", "admin")).statusCode).toBe(200);
    expect((await call("PUT", "/settings/webhook", "admin", { url: null })).statusCode).toBe(200);
    await undesignate();
  });

  it("refuses to make an operator for one server, since the status is panel-wide", async () => {
    expect((await call("POST", "/access/grants", "owner", { userId: ADMIN.id, serverId: "alpha", capability: "panel.operator" })).statusCode).toBe(400);
  });

  it("ends when the owner removes it, after which the admin reaches nothing", async () => {
    db.prepare("DELETE FROM grants WHERE user_id = ?").run(ADMIN.id);
    await designate();
    expect((await call("GET", "/servers/alpha/backups", "admin")).statusCode).toBe(200);
    expect((await undesignate()).statusCode).toBe(200);
    expect((await call("GET", "/servers/alpha/backups", "admin")).statusCode).toBe(403);
  });
});

describe("the access audit", () => {
  it("records a refused designation by an admin who holds access.manage, and names no server for a grant", async () => {
    db.prepare("DELETE FROM grants WHERE user_id = ?").run(ADMIN.id);
    db.prepare("INSERT INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, '*', 'access.manage', 'test', 'now')").run(ADMIN.id);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'denied.access.grant'").get() as { n: number }).n;
    expect((await call("POST", "/access/grants", "admin", { userId: ADMIN.id, serverId: "*", capability: "panel.operator" })).statusCode).toBe(403);
    const after = (db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'denied.access.grant'").get() as { n: number }).n;
    expect(after).toBe(before + 1);
    expect((await call("POST", "/access/grants", "owner", { userId: ADMIN.id, serverId: "alpha", capability: "players" })).statusCode).toBe(201);
    const row = db.prepare("SELECT server_id FROM audit WHERE action = 'access.grant' ORDER BY id DESC LIMIT 1").get() as { server_id: string | null };
    expect(row.server_id).toBeNull();
    await call("DELETE", "/access/grants", "owner", { userId: ADMIN.id, serverId: "alpha", capability: "players" });
  });

  it("writes no audit row for a grant that is already in place", async () => {
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'access.grant'").get() as { n: number }).n;
    const start = count();
    await call("POST", "/access/grants", "owner", { userId: ADMIN.id, serverId: "beta", capability: "players" });
    await call("POST", "/access/grants", "owner", { userId: ADMIN.id, serverId: "beta", capability: "players" });
    expect(count()).toBe(start + 1);
    await call("DELETE", "/access/grants", "owner", { userId: ADMIN.id, serverId: "beta", capability: "players" });
  });
});
