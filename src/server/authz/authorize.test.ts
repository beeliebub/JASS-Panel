import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundledMigrationsDirectory, migrate } from "../db/migrate.js";
import type { PanelDatabase } from "../db/open.js";
import { PANEL_ACCESS, type Capability } from "./capabilities.js";
import { authorize, decide, isOwnerOrOperator, type GrantRow, type Principal } from "./authorize.js";
import { ROUTES } from "./routes.js";
import { isServerCapability, PANEL_CAPABILITIES, PANEL_OPERATOR, SERVER_CAPABILITIES } from "./capabilities.js";

let db: PanelDatabase;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: "/nonexistent-unused" });
  // A grant only counts for a server that exists, so the servers the tests grant on are rows here.
  for (const id of ["alpha", "beta", "constructor"]) {
    db.prepare("INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES (?, ?, ?, ?, 'logs/latest.log', 'now', 'now')").run(
      id,
      id,
      `/srv/${id}`,
      JSON.stringify(["/bin/true"]),
    );
  }
});

afterEach(() => {
  db.close();
});

const owner: Principal = { id: "owner-1", role: "OWNER" };
const admin: Principal = { id: "admin-1", role: "ADMIN" };

function grant(userId: string, serverId: string, capability: string): void {
  db.prepare("INSERT INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, ?, ?, 'test', 'now')").run(
    userId,
    serverId,
    capability,
  );
}

describe("authorize (database)", () => {
  it("lets an OWNER hold every server capability on every valid server with no rows", () => {
    expect(authorize(db, owner, "power", "alpha")).toBe(true);
    expect(authorize(db, owner, "files.write", "constructor")).toBe(true);
    expect(authorize(db, owner, "console.send", "never-added")).toBe(true);
  });

  it("denies a server capability asked without a server, even for an OWNER", () => {
    expect(authorize(db, owner, "power")).toBe(false);
    expect(authorize(db, owner, "power", "")).toBe(false);
  });

  it("denies the wildcard and malformed ids as a server, so they cannot match every grant", () => {
    grant("admin-1", "*", "power");
    expect(authorize(db, admin, "power", "*")).toBe(false);
    expect(authorize(db, admin, "power", "__proto__")).toBe(false);
    expect(authorize(db, admin, "power", "Alpha")).toBe(false);
    expect(authorize(db, owner, "power", "*")).toBe(false);
  });

  it("gives no access for a grant that names a server which has been removed", () => {
    grant("admin-1", "gone", "server.view");
    expect(authorize(db, admin, PANEL_ACCESS)).toBe(false);
    expect(authorize(db, admin, "server.view", "gone")).toBe(false);
  });

  it("refuses an ADMIN with no grant rows the panel itself, and every capability on it", () => {
    expect(authorize(db, admin, PANEL_ACCESS)).toBe(false);
    expect(authorize(db, admin, "power", "alpha")).toBe(false);
    expect(authorize(db, admin, "servers.manage")).toBe(false);
  });

  it("lets an ADMIN with any one grant row reach the panel, and nothing beyond its rows", () => {
    grant("admin-1", "alpha", "server.view");
    expect(authorize(db, admin, PANEL_ACCESS)).toBe(true);
    expect(authorize(db, admin, "power", "alpha")).toBe(false);
  });

  it("scopes a server grant to its server only", () => {
    grant("admin-1", "alpha", "console.send");
    expect(authorize(db, admin, "console.send", "alpha")).toBe(true);
    expect(authorize(db, admin, "console.send", "beta")).toBe(false);
    expect(authorize(db, admin, "power", "alpha")).toBe(false);
  });

  it("lets a wildcard server grant reach every server, including one added later", () => {
    grant("admin-1", "*", "power");
    expect(authorize(db, admin, "power", "alpha")).toBe(true);
    expect(authorize(db, admin, "power", "added-after-the-grant")).toBe(true);
    expect(authorize(db, admin, "backups", "alpha")).toBe(false);
  });

  it("gives server.view to anyone with another capability on that server, and to nobody else", () => {
    grant("admin-1", "alpha", "players");
    expect(authorize(db, admin, "server.view", "alpha")).toBe(true);
    expect(authorize(db, admin, "server.view", "beta")).toBe(false);
  });

  it("treats a panel capability as wildcard-only and ignores any server it is asked with", () => {
    grant("admin-1", "*", "servers.manage");
    grant("admin-1", "alpha", "audit.read");
    expect(authorize(db, admin, "servers.manage")).toBe(true);
    expect(authorize(db, admin, "servers.manage", "alpha")).toBe(true);
    expect(authorize(db, admin, "audit.read")).toBe(false);
    expect(authorize(db, admin, "audit.read", "alpha")).toBe(false);
  });

  it("keeps a grant for a constructor id from leaking to any other id", () => {
    grant("admin-1", "constructor", "power");
    expect(authorize(db, admin, "power", "constructor")).toBe(true);
    expect(authorize(db, admin, "power", "alpha")).toBe(false);
  });

  it("does not let a grant row for another user apply", () => {
    grant("someone-else", "*", "power");
    expect(authorize(db, admin, "power", "alpha")).toBe(false);
  });
});

describe("decide (pure rules)", () => {
  it("denies anyone whose role is not OWNER or ADMIN, whatever they hold", () => {
    const viewer = { id: "v", role: "VIEWER" } as unknown as Principal;
    const grants: GrantRow[] = [{ serverId: "*", capability: "power" }];
    expect(decide(viewer, grants, PANEL_ACCESS)).toBe(false);
    expect(decide(viewer, grants, "power", "alpha")).toBe(false);
  });

  it("denies an unknown capability name", () => {
    expect(decide(admin, [{ serverId: "*", capability: "nope" }], "nope" as unknown as Capability, "alpha")).toBe(false);
  });

  it("knows which capabilities are server-scoped", () => {
    expect(isServerCapability("power")).toBe(true);
    expect(isServerCapability("servers.manage")).toBe(false);
    expect(isServerCapability(PANEL_ACCESS)).toBe(false);
  });
});

describe("route table", () => {
  it("gives every route a capability and a unique method and path", () => {
    const keys = ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(ROUTES.map((route) => route.id)).size).toBe(ROUTES.length);
    for (const route of ROUTES) expect(route.capability).toEqual(expect.any(String));
  });

  it("requires a server capability when the path names a server, except for the listed panel-guarded routes", () => {
    // Removing a server is a panel-wide act, so it is guarded by a panel-wide capability even though its path names the server.
    const panelGuarded: ReadonlySet<string> = new Set(["servers.remove"]);
    for (const route of ROUTES) {
      const namesServer = route.path.includes(":serverId");
      if (panelGuarded.has(route.id)) {
        expect(namesServer && !isServerCapability(route.capability), route.id).toBe(true);
        continue;
      }
      expect(isServerCapability(route.capability), route.id).toBe(namesServer);
    }
  });
});

describe("the panel operator", () => {
  it("holds every server capability on every server, including one added later", () => {
    grant("admin-1", "*", PANEL_OPERATOR);
    for (const capability of SERVER_CAPABILITIES) {
      expect(authorize(db, admin, capability, "alpha"), capability).toBe(true);
      expect(authorize(db, admin, capability, "added-later"), capability).toBe(true);
    }
  });

  it("holds every panel capability too, as the owner does, and nothing when asked without a server", () => {
    grant("admin-1", "*", PANEL_OPERATOR);
    for (const capability of PANEL_CAPABILITIES) expect(authorize(db, admin, capability), capability).toBe(true);
    expect(authorize(db, admin, "power")).toBe(false);
    expect(authorize(db, admin, "power", "*")).toBe(false);
  });

  it("may change access as an owner may, and a row naming one server does not make it so", () => {
    expect(isOwnerOrOperator(db, admin)).toBe(false);
    grant("admin-1", "alpha", PANEL_OPERATOR);
    expect(isOwnerOrOperator(db, admin)).toBe(false);
    db.prepare("DELETE FROM grants WHERE user_id = ?").run("admin-1");
    grant("admin-1", "*", PANEL_OPERATOR);
    expect(isOwnerOrOperator(db, admin)).toBe(true);
    expect(isOwnerOrOperator(db, owner)).toBe(true);
  });

  it("is a wildcard row only: a row naming one server confers nothing", () => {
    grant("admin-1", "alpha", PANEL_OPERATOR);
    expect(authorize(db, admin, "power", "alpha")).toBe(false);
  });

  it("counts as a grant row for panel access, and ends when its row is removed", () => {
    grant("admin-1", "*", PANEL_OPERATOR);
    expect(authorize(db, admin, PANEL_ACCESS)).toBe(true);
    db.prepare("DELETE FROM grants WHERE user_id = ?").run("admin-1");
    expect(authorize(db, admin, "power", "alpha")).toBe(false);
    expect(authorize(db, admin, PANEL_ACCESS)).toBe(false);
  });
});
