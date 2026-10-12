// Turning "update plugins on start" on rewrites the unit the panel wrote. A unit that systemd will not load is put back as it was, so the
// recorded digest still describes the file on disk and the server is not left looking edited by hand. The manager is a stand-in, and every
// file is in a temporary directory.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { setUpdateOnStart } from "../../src/server/plugins/update-on-start.js";
import { fileDigest, serviceFile, socketFile, unitMatchesRecord } from "../../src/server/servers/files.js";
import { digest } from "../../src/server/servers/unit.js";
import { insertServer } from "../../src/server/servers/store.js";
import type { Runner, RunResult } from "../../src/server/systemd/run.js";

const ACTOR = { id: "owner-update-on-start", label: "owner@test" };
const ID = "alpha";
const SERVICE_TEXT = "[Unit]\nDescription=alpha\n\n[Service]\nExecStart=/bin/true\n";
const SOCKET_TEXT = "[Socket]\nListenFIFO=/run/user/1000/jass-mc-alpha.stdin\n";

let root: string;
let config: PanelConfig;
let db: PanelDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-update-on-start-"));
  mkdirSync(join(root, "config", "systemd", "user"), { recursive: true });
  config = loadConfig(
    {
      PANEL_PUBLIC_ORIGIN: "https://example.net",
      PANEL_DATA_DIR: join(root, "data"),
      XDG_RUNTIME_DIR: join(root, "run"),
      XDG_CONFIG_HOME: join(root, "config"),
    },
    { uid: 1000 },
  );
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  writeFileSync(serviceFile(config.unitDir, ID), SERVICE_TEXT);
  writeFileSync(socketFile(config.unitDir, ID), SOCKET_TEXT);
  insertServer(
    db,
    {
      id: ID,
      displayName: "Alpha",
      directory: join(root, ID),
      startCommand: ["/bin/true"],
      memory: null,
      logPath: "logs/latest.log",
      autostart: false,
      updateOnStart: false,
      unitDigest: digest(SERVICE_TEXT),
      socketDigest: digest(SOCKET_TEXT),
    },
    new Date().toISOString(),
  );
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A manager that answers every call, and fails the reload when `reloadFails` is set. */
function manager(reloadFails: boolean): Runner {
  return (argv): Promise<RunResult> => {
    const failed = reloadFails && argv.includes("daemon-reload");
    return Promise.resolve({ code: failed ? 1 : 0, signal: null, stdout: "", stderr: "" });
  };
}

function deps(run: Runner) {
  return { db, config, run, now: () => new Date() };
}

function recordedUnit(): { readonly updateOnStart: number; readonly unitDigest: string | null } {
  return db.prepare("SELECT update_on_start AS updateOnStart, unit_digest AS unitDigest FROM servers WHERE id = ?").get(ID) as {
    updateOnStart: number;
    unitDigest: string | null;
  };
}

describe("turning update-on-start on", () => {
  it("rewrites the unit, records its digest and the setting, and leaves the unit matching the record", async () => {
    await setUpdateOnStart(deps(manager(false)), ID, true, ACTOR);
    expect(readFileSync(serviceFile(config.unitDir, ID), "utf8")).toContain("ExecStartPre=");
    const recorded = recordedUnit();
    expect(recorded.updateOnStart).toBe(1);
    expect(recorded.unitDigest).toBe(fileDigest(serviceFile(config.unitDir, ID)));
    expect(unitMatchesRecord({ unitDir: config.unitDir, paths: config.paths }, ID, recorded.unitDigest, digest(SOCKET_TEXT))).toBe(true);
  });

  it("puts the unit back when systemd will not load the new one, so the record still matches the file", async () => {
    await expect(setUpdateOnStart(deps(manager(true)), ID, true, ACTOR)).rejects.toThrow(/daemon-reload/);
    expect(readFileSync(serviceFile(config.unitDir, ID), "utf8")).toBe(SERVICE_TEXT);
    expect(recordedUnit()).toEqual({ updateOnStart: 0, unitDigest: digest(SERVICE_TEXT) });
    expect(unitMatchesRecord({ unitDir: config.unitDir, paths: config.paths }, ID, digest(SERVICE_TEXT), digest(SOCKET_TEXT))).toBe(true);
    const audited = db.prepare("SELECT COUNT(*) AS count FROM audit WHERE action = 'plugins.update-on-start'").get() as { count: number };
    expect(audited.count).toBe(0);
  });
});
