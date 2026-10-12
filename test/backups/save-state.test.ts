// Auto-save around a backup: the marker and what is reported when save-on cannot be confirmed, the periodic pass that retries it, a backup
// that refuses a server still loading, the archive that leaves out the panel's own temporary files, and the sizing of a restore. The
// systemd manager is a stand-in, so no unit is started or stopped; the log, the marker and the backups live in temporary directories.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveBytes, backupDirOf, createBackup, markerOf, reconcileMarkers, type BackupDependencies } from "../../src/server/backups/backup.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { Readiness } from "../../src/server/power/readiness.js";
import { insertServer } from "../../src/server/servers/store.js";
import { runProcess, type Runner, type RunResult } from "../../src/server/systemd/run.js";

const ACTOR = { id: "owner-save-state", label: "owner@test" };
const ID = "alpha";
const DONE = '[10:00:00 INFO]: Done (0.5s)! For help, type "help"';
const INVOCATION = "0123456789abcdef0123456789abcdef";

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let locks: OperationLocks;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-save-state-"));
  mkdirSync(join(root, ID, "logs"), { recursive: true });
  mkdirSync(join(root, ID, "world"), { recursive: true });
  writeFileSync(join(root, ID, "world", "level.dat"), "world\n");
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data"), XDG_RUNTIME_DIR: join(root, "run"), XDG_CONFIG_HOME: join(root, "config") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  insertServer(
    db,
    { id: ID, displayName: "Alpha", directory: join(root, ID), startCommand: ["/bin/true"], memory: null, logPath: "logs/latest.log", autostart: false, updateOnStart: false, unitDigest: "unused", socketDigest: "unused" },
    new Date().toISOString(),
  );
  locks = new OperationLocks();
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * A systemd stand-in for one server. It is active or not as the test says, loaded when its journal has Done, and it stops answering after
 * `failFrom` calls to the manager when that is set, as an unreachable manager would.
 */
function manager(options: { readonly active: boolean; readonly loaded: boolean; readonly failFrom?: number }): Runner {
  let calls = 0;
  const answer = (code: number, stdout = ""): Promise<RunResult> => Promise.resolve({ code, signal: null, stdout, stderr: "" });
  return (argv) => {
    if (argv[0] === "journalctl") return answer(0, options.loaded ? `${DONE}\n` : "");
    calls += 1;
    if (options.failFrom !== undefined && calls >= options.failFrom) return Promise.reject(new Error("the manager is unreachable"));
    const state = options.active ? "active" : "inactive";
    return answer(0, `Id=jass-mc-${ID}.service\nActiveState=${state}\nSubState=running\nResult=success\nMainPID=42\nActiveEnterTimestamp=Sun 2026-10-11 08:00:00 CDT\nInvocationID=${INVOCATION}\n`);
  };
}

/** The manager stand-in for systemctl and journalctl, with real commands for everything else, so the archive is made by a real tar. */
function withRealTar(stand: Runner): Runner {
  return (argv, options) => (argv[0] === "systemctl" || argv[0] === "journalctl" ? stand(argv, options) : runProcess(argv, options));
}

function backupDeps(run: Runner, extra: Partial<BackupDependencies> = {}): BackupDependencies {
  return { db, config, run, locks, readiness: new Readiness(), sleep: () => Promise.resolve(), ...extra };
}

describe("auto-save when a backup cannot finish its save steps", () => {
  it("keeps the marker, reports auto-save as unconfirmed, and fails the backup", async () => {
    const unconfirmed: string[] = [];
    const deps = backupDeps(manager({ active: true, loaded: true, failFrom: 3 }), { onAutoSaveUnconfirmed: (serverId) => unconfirmed.push(serverId) });
    await expect(createBackup(deps, ID, ACTOR, "manual")).rejects.toThrow();
    expect(existsSync(markerOf(config, ID))).toBe(true);
    expect(unconfirmed).toEqual([ID]);
    expect(db.prepare("SELECT action, outcome FROM audit WHERE action = 'backup.save-on' ORDER BY id").all()).toEqual([{ action: "backup.save-on", outcome: "failed" }]);
  });

  it("refuses a server that is running but has not printed Done, before any save command is sent", async () => {
    await expect(createBackup(backupDeps(manager({ active: true, loaded: false })), ID, ACTOR, "manual")).rejects.toThrow(/still loading/);
    expect(existsSync(markerOf(config, ID))).toBe(false);
  });

  it("does not hold back a server outside the Paper preset while its unit is active, since its unit alone reports that it has loaded", async () => {
    // A custom start command prints no Done line, so the active unit is the only report of loading such a server can give. The backup
    // then goes on to the save steps, which fail here only because no console is attached.
    const custom = new Readiness({ paperServer: () => false });
    await expect(createBackup(backupDeps(manager({ active: true, loaded: false }), { readiness: custom }), ID, ACTOR, "manual")).rejects.toThrow(/did not confirm/);
  });
});

describe("the pass that settles auto-save while the panel runs", () => {
  it("leaves a server alone while a backup holds it", async () => {
    mkdirSync(config.paths.markers, { recursive: true });
    writeFileSync(markerOf(config, ID), "earlier\n");
    const calls: string[] = [];
    const stand = manager({ active: true, loaded: true });
    const release = locks.tryAcquire(ID, "backup");
    expect(await reconcileMarkers(backupDeps((argv, options) => (calls.push(argv.join(" ")), stand(argv, options))))).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(markerOf(config, ID))).toBe(true);
    release?.();
  });

  it("sends nothing to a server that is still loading, and reports nothing for it yet", async () => {
    mkdirSync(config.paths.markers, { recursive: true });
    writeFileSync(markerOf(config, ID), "earlier\n");
    expect(await reconcileMarkers(backupDeps(manager({ active: true, loaded: false })))).toEqual([]);
    expect(existsSync(markerOf(config, ID))).toBe(true);
  });
});

describe("the archive of a backup", () => {
  it.each([
    ["zstd", true],
    ["gzip", false],
  ])("leaves only the panel's own temporary files out, with %s", async (_name, zstd) => {
    writeFileSync(join(root, ID, "world", ".jass-panel-k3j4h5g6f7.partial"), "half a write");
    writeFileSync(join(root, ID, "world", ".notes.partial"), "a file of the world's own");
    writeFileSync(join(root, ID, "keep.txt"), "kept");
    const row = await createBackup(backupDeps(withRealTar(manager({ active: false, loaded: false })), { zstd }), ID, ACTOR, "manual");
    const archive = join(backupDirOf(config, ID), row.file);
    const listing = await runProcess(zstd ? ["tar", "--zstd", "-tf", archive] : ["tar", "-tzf", archive]);
    expect(listing.code).toBe(0);
    expect(listing.stdout).toContain("keep.txt");
    expect(listing.stdout).toContain("level.dat");
    expect(listing.stdout).not.toContain(".jass-panel-k3j4h5g6f7.partial");
    expect(listing.stdout).toContain(".notes.partial");
    expect(readdirSync(backupDirOf(config, ID)).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });
});

describe("sizing a restore", () => {
  it("adds up the size of every member in a verbose listing", () => {
    expect(archiveBytes(["-rw-r--r-- jass/jass 1234 2026-10-11 12:00 ./a", "drwxr-xr-x jass/jass 0 2026-10-11 12:00 ./world/"])).toBe(1234);
  });

  it("refuses a listing line whose size it cannot read, rather than under-count the restore", () => {
    expect(() => archiveBytes(["something the listing does not say"])).toThrow(/could not be sized/);
  });
});
