// A server's start-with-the-machine choice: its unit is enabled exactly when the choice is on, the stored choice follows what systemd did, and
// servers that existed before the choice keep the state their units already had. Systemd is a fake here.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { reconcileAutostart, setAutostart } from "../../src/server/servers/autostart.js";
import { addServer, type Actor } from "../../src/server/servers/service.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import type { Runner } from "../../src/server/systemd/run.js";
import { serviceUnit } from "../../src/server/systemd/user.js";

const ACTOR: Actor = { id: "owner-1", label: "owner@example.net" };
const ENABLE = ["systemctl", "--user", "enable", "--", serviceUnit("alpha")];
const DISABLE = ["systemctl", "--user", "disable", "--", serviceUnit("alpha")];

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let calls: string[][];
// The verbs systemd refuses in a test, with an exit code of 1.
let refused: Set<string>;
// The verbs whose run ends without an exit code, as when a run is killed before systemd answers.
let silent: Set<string>;
// What `is-enabled` reports for the unit: "enabled", "disabled", or "" for no answer.
let unitState: string;

const run: Runner = (argv) => {
  calls.push([...argv]);
  if (argv.includes("is-enabled")) {
    return Promise.resolve({ code: unitState === "disabled" ? 1 : 0, signal: null, stdout: unitState === "" ? "" : `${unitState}\n`, stderr: "" });
  }
  if (argv.some((arg) => silent.has(arg))) return Promise.resolve({ code: null, signal: null, stdout: "", stderr: "" });
  return Promise.resolve({ code: argv.some((arg) => refused.has(arg)) ? 1 : 0, signal: null, stdout: "", stderr: "" });
};

function deps(locks = new OperationLocks()) {
  return { db, config, run, locks, now: () => new Date("2026-10-11T12:00:00Z") };
}

function storedChoice(): number {
  return (db.prepare("SELECT autostart FROM servers WHERE id = 'alpha'").get() as { autostart: number }).autostart;
}

function autostartAudit(outcome: string): { details: string }[] {
  return db.prepare("SELECT details FROM audit WHERE action = 'server.autostart' AND outcome = ? ORDER BY id").all(outcome) as { details: string }[];
}

async function addAlpha(autostart: boolean): Promise<void> {
  const directory = join(root, "alpha");
  mkdirSync(directory, { recursive: true });
  await addServer(deps(), { id: "alpha", displayName: "Alpha", directory, command: { kind: "custom", argv: ["/bin/true"] }, logPath: "logs/latest.log", autostart }, ACTOR);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-autostart-"));
  config = loadConfig(
    { HOME: root, XDG_CONFIG_HOME: join(root, "config"), PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data") },
    { uid: 1000 },
  );
  mkdirSync(config.unitDir, { recursive: true });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  calls = [];
  refused = new Set();
  silent = new Set();
  unitState = "enabled";
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a server's choice to start with the machine", () => {
  it("does not enable the unit of a new server whose choice is off, and clears any link left for its name", async () => {
    await addAlpha(false);
    expect(calls.some((argv) => argv.includes("enable"))).toBe(false);
    expect(calls).toContainEqual(DISABLE);
  });

  it("enables the unit of a new server whose choice is on", async () => {
    await addAlpha(true);
    expect(calls).toContainEqual(ENABLE);
  });

  it("enables the unit when the choice is turned on, and stores and records the change", async () => {
    await addAlpha(false);
    await setAutostart(deps(), "alpha", true, ACTOR);
    expect(calls).toContainEqual(ENABLE);
    expect(storedChoice()).toBe(1);
    expect(autostartAudit("ok")).toHaveLength(1);
  });

  it("disables the unit when the choice is turned off", async () => {
    await addAlpha(true);
    await setAutostart(deps(), "alpha", false, ACTOR);
    expect(calls).toContainEqual(DISABLE);
    expect(storedChoice()).toBe(0);
  });

  it("changes the unit even when the stored choice already matches, so a unit that drifted is put right", async () => {
    await addAlpha(true);
    calls = [];
    await setAutostart(deps(), "alpha", true, ACTOR);
    expect(calls).toContainEqual(ENABLE);
    expect(storedChoice()).toBe(1);
  });

  it("leaves the unit and the stored choice as they were when systemd refuses the change", async () => {
    await addAlpha(false);
    refused = new Set(["enable"]);
    await expect(setAutostart(deps(), "alpha", true, ACTOR)).rejects.toMatchObject({ code: "conflict" });
    expect(storedChoice()).toBe(0);
    expect(autostartAudit("failed")).toHaveLength(1);
  });

  it("reads the unit back when systemd gives no answer, and keeps the change the unit reports", async () => {
    await addAlpha(false);
    silent = new Set(["enable"]);
    unitState = "enabled";
    await setAutostart(deps(), "alpha", true, ACTOR);
    expect(storedChoice()).toBe(1);
  });

  it("refuses when systemd gives no answer and the unit reports the other state", async () => {
    await addAlpha(false);
    silent = new Set(["enable"]);
    unitState = "disabled";
    await expect(setAutostart(deps(), "alpha", true, ACTOR)).rejects.toMatchObject({ code: "conflict" });
    expect(storedChoice()).toBe(0);
    expect(autostartAudit("failed")).toHaveLength(1);
  });

  it("puts the unit back when the stored choice cannot be written, and records nothing as failed", async () => {
    await addAlpha(false);
    db.exec("CREATE TRIGGER refuse_update BEFORE UPDATE ON servers BEGIN SELECT RAISE(ABORT, 'refused'); END;");
    await expect(setAutostart(deps(), "alpha", true, ACTOR)).rejects.toThrow();
    expect(calls).toContainEqual(DISABLE);
    expect(storedChoice()).toBe(0);
    expect(autostartAudit("failed")).toHaveLength(0);
  });

  it("records it when the unit cannot be put back either", async () => {
    await addAlpha(false);
    db.exec("CREATE TRIGGER refuse_update BEFORE UPDATE ON servers BEGIN SELECT RAISE(ABORT, 'refused'); END;");
    refused = new Set(["disable"]);
    await expect(setAutostart(deps(), "alpha", true, ACTOR)).rejects.toThrow();
    const failed = autostartAudit("failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.details).toContain('"reverted":false');
  });

  it("refuses a change while another operation holds the server, and touches nothing", async () => {
    await addAlpha(false);
    const locks = new OperationLocks();
    locks.tryAcquire("alpha", "start");
    await expect(setAutostart(deps(locks), "alpha", true, ACTOR)).rejects.toMatchObject({ code: "conflict" });
    expect(calls.some((argv) => argv.includes("enable"))).toBe(false);
    expect(storedChoice()).toBe(0);
  });

  it("refuses a server that does not exist", async () => {
    await expect(setAutostart(deps(), "ghost", true, ACTOR)).rejects.toMatchObject({ code: "not_found" });
  });

  it("disables a ticked server again when its add fails after the unit was enabled, so no link to its files is left", async () => {
    db.exec("CREATE TRIGGER refuse_insert BEFORE INSERT ON servers BEGIN SELECT RAISE(ABORT, 'refused'); END;");
    await expect(addAlpha(true)).rejects.toThrow();
    expect(calls).toContainEqual(ENABLE);
    expect(calls).toContainEqual(DISABLE);
    expect(existsSync(join(config.unitDir, serviceUnit("alpha")))).toBe(false);
  });
});

describe("the start-up reading of the units", () => {
  it("sets a stored choice from its unit when the two differ, and records the correction", async () => {
    await addAlpha(true);
    unitState = "disabled";
    await reconcileAutostart({ db, run, now: () => new Date("2026-10-11T12:00:00Z") });
    expect(storedChoice()).toBe(0);
    expect(autostartAudit("ok").at(-1)?.details).toContain('"reconciled":true');
  });

  it("keeps the stored choice when systemd gives no answer for the unit", async () => {
    await addAlpha(true);
    unitState = "";
    await reconcileAutostart({ db, run, now: () => new Date("2026-10-11T12:00:00Z") });
    expect(storedChoice()).toBe(1);
    expect(autostartAudit("ok").some((row) => row.details.includes("reconciled"))).toBe(false);
  });

  it("changes nothing when the stored choice matches the unit", async () => {
    await addAlpha(true);
    const before = autostartAudit("ok").length;
    calls = [];
    await reconcileAutostart({ db, run, now: () => new Date("2026-10-11T12:00:00Z") });
    expect(autostartAudit("ok")).toHaveLength(before);
    expect(calls.some((argv) => argv.includes("enable") || argv.includes("disable"))).toBe(false);
  });
});

describe("the migration that ties the stored choice to the units", () => {
  it("sets the choice of every server that existed before it, since their units were enabled", () => {
    const partial = mkdtempSync(join(tmpdir(), "jass-panel-migrations-"));
    const older = openDatabase(join(root, "older.db"));
    try {
      for (const name of ["0001_initial.sql", "0002_plugin_sources_many.sql"]) {
        copyFileSync(join(bundledMigrationsDirectory(), name), join(partial, name));
      }
      migrate(older, { dir: partial, backupDir: join(root, "older-backups") });
      older
        .prepare("INSERT INTO servers (id, display_name, directory, start_command, log_path, update_on_start, created_at, updated_at) VALUES ('alpha', 'Alpha', '/x', '[]', 'logs/latest.log', 0, 'now', 'now')")
        .run();
      migrate(older, { dir: bundledMigrationsDirectory(), backupDir: join(root, "older-backups") });
      expect((older.prepare("SELECT autostart FROM servers WHERE id = 'alpha'").get() as { autostart: number }).autostart).toBe(1);
    } finally {
      older.close();
      rmSync(partial, { recursive: true, force: true });
    }
  });
});
