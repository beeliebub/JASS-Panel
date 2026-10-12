// Backups, restores and marker reconciliation with real tar, zstd and systemd. A running server is the fake Paper, which confirms
// each save command in its log the way Paper does. Units carry the jass-test- prefix and are removed in finally.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAudit } from "../../src/server/audit/audit.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { createBackup, checkMembers, leftoversOf, listBackups, reconcileMarkers, restoreBackup, markerOf, pruneBackups } from "../../src/server/backups/backup.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { powerAction } from "../../src/server/power/power.js";
import { Readiness } from "../../src/server/power/readiness.js";
import { addServer, removeServer, ServiceError } from "../../src/server/servers/service.js";
import { serviceFile, socketFile } from "../../src/server/servers/files.js";
import { runProcess } from "../../src/server/systemd/run.js";
import { observeUnits } from "../../src/server/systemd/user.js";
import { getServer } from "../../src/server/servers/store.js";

const FAKE_PAPER = fileURLToPath(new URL("../support/fake-paper.mjs", import.meta.url));
const ACTOR = { id: "owner-backup", label: "owner@test" };
const AVAILABLE = (() => {
  const out = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" }).stdout.trim();
  return out === "running" || out === "degraded";
})();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let locks: OperationLocks;
const created: string[] = [];

function deps() {
  return { db, config, run: runProcess, locks, readiness: new Readiness(), zstd: true, sleep };
}

function server(id: string, extra: Record<string, unknown> = {}) {
  const directory = join(root, id);
  mkdirSync(join(directory, "logs"), { recursive: true });
  mkdirSync(join(directory, "world"), { recursive: true });
  writeFileSync(join(directory, "world", "level.dat"), "original world\n");
  created.push(id);
  return { id, displayName: id, directory, logPath: "logs/latest.log", autostart: false, command: { kind: "custom" as const, argv: [process.execPath, FAKE_PAPER] }, ...extra };
}

beforeAll(() => {
  if (!AVAILABLE) return;
  root = mkdtempSync(join(tmpdir(), "jass-panel-backups-"));
  config = loadConfig(
    { PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data"), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "/tmp", ".config"), XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}` },
    { uid: process.getuid?.() ?? 0 },
  );
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  locks = new OperationLocks();
  mkdirSync(config.unitDir, { recursive: true });
});

afterAll(async () => {
  if (!AVAILABLE) return;
  for (const id of created) {
    const row = getServer(db, id);
    if (row !== undefined) await removeServer({ db, config, run: runProcess, now: () => new Date() }, id, ACTOR).catch(() => undefined);
    await runProcess(["systemctl", "--user", "stop", "--", `jass-mc-${id}.service`], { timeoutMs: 130_000 });
    await runProcess(["systemctl", "--user", "disable", "--", `jass-mc-${id}.service`]);
    rmSync(serviceFile(config.unitDir, id), { force: true });
    rmSync(socketFile(config.unitDir, id), { force: true });
    db.prepare("DELETE FROM servers WHERE id = ?").run(id);
  }
  await runProcess(["systemctl", "--user", "daemon-reload"]);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!AVAILABLE)("backups", () => {
  it("backs up a stopped server to a checksummed archive and records it", async () => {
    const id = "jass-test-bk-stop";
    const spec = server(id);
    await addServer({ db, config, run: runProcess }, spec, ACTOR);
    const backup = await createBackup(deps(), id, ACTOR, "manual");
    expect(backup.file).toMatch(/\.tar\.zst$/);
    expect(backup.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(config.paths.backups, id, backup.file))).toBe(true);
    expect(listBackups(db, id)[0]?.file).toBe(backup.file);
    expect(existsSync(markerOf(config, id))).toBe(false);
  }, 120_000);

  it("saves a running server through auto-save off and on, and clears the marker only after both are confirmed", async () => {
    const id = "jass-test-bk-live";
    await addServer({ db, config, run: runProcess }, server(id), ACTOR);
    await powerAction({ db, config, run: runProcess, locks, readiness: new Readiness(), sleep }, id, "start", ACTOR);
    await sleep(1500);
    const backup = await createBackup(deps(), id, ACTOR, "manual");
    expect(backup.sizeBytes).toBeGreaterThan(0);
    const log = readFileSync(join(root, id, "logs", "latest.log"), "utf8");
    expect(log).toContain("Automatic saving is now disabled");
    expect(log).toContain("Saved the game");
    expect(log).toContain("Automatic saving is now enabled");
    expect(existsSync(markerOf(config, id))).toBe(false);
    await powerAction({ db, config, run: runProcess, locks, readiness: new Readiness(), sleep }, id, "stop", ACTOR);
  }, 240_000);

  it("keeps only the newest successful backups, and prunes after a new one succeeds", async () => {
    const id = "jass-test-bk-keep";
    await addServer({ db, config, run: runProcess }, server(id), ACTOR);
    for (let round = 0; round < 3; round += 1) await createBackup(deps(), id, ACTOR, "manual");
    pruneBackups(deps(), id, 2);
    expect(listBackups(db, id)).toHaveLength(2);
    expect(readdirSync(join(config.paths.backups, id)).filter((name) => name.endsWith(".tar.zst"))).toHaveLength(2);
  }, 180_000);

  it("restores an archive over a stopped server and keeps the old directory aside", async () => {
    const id = "jass-test-bk-restore";
    const spec = server(id);
    await addServer({ db, config, run: runProcess }, spec, ACTOR);
    const backup = await createBackup(deps(), id, ACTOR, "manual");
    writeFileSync(join(spec.directory, "world", "level.dat"), "damaged\n");
    await restoreBackup(deps(), id, (listBackups(db, id).find((row) => row.file === backup.file) ?? backup).id, ACTOR);
    expect(readFileSync(join(spec.directory, "world", "level.dat"), "utf8")).toBe("original world\n");
    const leftovers = leftoversOf(spec.directory);
    expect(leftovers).toHaveLength(1);
    expect(readFileSync(join(root, id, "..", leftovers[0] ?? "", "world", "level.dat"), "utf8")).toBe("damaged\n");
  }, 180_000);

  it("refuses a restore while the server is running", async () => {
    const id = "jass-test-bk-running";
    await addServer({ db, config, run: runProcess }, server(id), ACTOR);
    const backup = await createBackup(deps(), id, ACTOR, "manual");
    await powerAction({ db, config, run: runProcess, locks, readiness: new Readiness(), sleep }, id, "start", ACTOR);
    await expect(restoreBackup(deps(), id, listBackups(db, id)[0]?.id ?? 0, ACTOR)).rejects.toThrow(/Stop the server/);
    expect(backup.file).toBeTruthy();
    await powerAction({ db, config, run: runProcess, locks, readiness: new Readiness(), sleep }, id, "stop", ACTOR);
  }, 180_000);

  it("refuses an archive whose checksum no longer matches the record", async () => {
    const id = "jass-test-bk-tamper";
    await addServer({ db, config, run: runProcess }, server(id), ACTOR);
    const backup = await createBackup(deps(), id, ACTOR, "manual");
    writeFileSync(join(config.paths.backups, id, backup.file), "not an archive any more");
    await expect(restoreBackup(deps(), id, backup.id, ACTOR)).rejects.toThrow(/checksum/);
  }, 120_000);

  it("refuses a backup while another operation holds the server's lock", async () => {
    const id = "jass-test-bk-lock";
    await addServer({ db, config, run: runProcess }, server(id), ACTOR);
    const release = locks.tryAcquire(id, "power");
    await expect(createBackup(deps(), id, ACTOR, "manual")).rejects.toThrow(/Another operation \(power\)/);
    release?.();
  }, 60_000);

  it("sends save-on at start-up for a backup that died mid-save, and removes the marker once it is confirmed", async () => {
    const id = "jass-test-bk-marker";
    await addServer({ db, config, run: runProcess }, server(id), ACTOR);
    await powerAction({ db, config, run: runProcess, locks, readiness: new Readiness(), sleep }, id, "start", ACTOR);
    await sleep(1500);
    mkdirSync(config.paths.markers, { recursive: true });
    writeFileSync(markerOf(config, id), "left behind\n");
    const unconfirmed = await reconcileMarkers({ db, config, run: runProcess, locks, readiness: new Readiness(), zstd: true, sleep });
    expect(unconfirmed).toEqual([]);
    expect(existsSync(markerOf(config, id))).toBe(false);
    await powerAction({ db, config, run: runProcess, locks, readiness: new Readiness(), sleep }, id, "stop", ACTOR);
  }, 120_000);

  it("reports a missing save confirmation as a failed backup, and never records an archive", async () => {
    const id = "jass-test-bk-unconfirmed";
    await addServer({ db, config, run: runProcess }, server(id, { command: { kind: "custom", argv: [process.execPath, FAKE_PAPER, "--silent"] } }), ACTOR);
    await powerAction({ db, config, run: runProcess, locks, readiness: new Readiness(), sleep }, id, "start", ACTOR);
    await sleep(1500);
    const before = listBackups(db, id).length;
    const quick = { ...deps(), timeouts: { toggleMs: 2000, flushMs: 2000 } };
    await expect(createBackup(quick, id, ACTOR, "manual")).rejects.toThrow(/did not confirm/);
    expect(listBackups(db, id).length).toBe(before);
    await powerAction({ db, config, run: runProcess, locks, readiness: new Readiness(), sleep }, id, "stop", ACTOR);
  }, 120_000);
});

describe("archive member checks", () => {
  it("refuses absolute paths, parent references and links", () => {
    expect(checkMembers(["./world/level.dat"], ["-"])).toBeNull();
    expect(checkMembers(["/etc/passwd"], ["-"])).toMatch(/absolute or parent/);
    expect(checkMembers(["world/../../escape"], ["-"])).toMatch(/absolute or parent/);
    expect(checkMembers(["link"], ["l"])).toMatch(/link/);
    expect(checkMembers(["hard"], ["h"])).toMatch(/link/);
  });
});

describe("ServiceError and audit", () => {
  it("is a service error type the handlers can map", () => {
    expect(new ServiceError("conflict", "x").code).toBe("conflict");
    expect(typeof recordAudit).toBe("function");
    expect(typeof observeUnits).toBe("function");
  });
});
