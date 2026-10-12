// Removing a server against a stand-in for the systemd user manager. The unit files, the database and the markers are in a temporary
// directory, and the manager is never called for real: each call is recorded and answered by the test, so no unit is read or changed.
// The real-unit removal is covered by the lifecycle suite, which needs a user manager.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { fileDigest, serviceFile, socketFile } from "../../src/server/servers/files.js";
import { Busy, removeServer } from "../../src/server/servers/service.js";
import { insertServer } from "../../src/server/servers/store.js";
import type { Runner, RunResult } from "../../src/server/systemd/run.js";

const ACTOR = { id: "owner-removal", label: "owner@test" };
const ID = "alpha";
const SERVICE = `jass-mc-${ID}.service`;
const SOCKET = `jass-mc-${ID}.socket`;
const SERVICE_TEXT = "[Service]\nExecStart=/bin/true\n";
const SOCKET_TEXT = "[Socket]\nListenFIFO=/run/user/1000/jass-mc-alpha.stdin\n";

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let locks: OperationLocks;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-removal-"));
  mkdirSync(join(root, "run"), { recursive: true });
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
  locks = new OperationLocks();
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** Writes the unit files the panel wrote for the server, and inserts the row a successful add leaves behind. */
function seedServer(): void {
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
      unitDigest: fileDigest(serviceFile(config.unitDir, ID)) ?? "",
      socketDigest: fileDigest(socketFile(config.unitDir, ID)) ?? "",
    },
    new Date().toISOString(),
  );
}

function rowExists(): boolean {
  return db.prepare("SELECT 1 FROM servers WHERE id = ?").get(ID) !== undefined;
}

function removalOutcomes(): string[] {
  return (db.prepare("SELECT outcome FROM audit WHERE action = 'server.remove' ORDER BY id").all() as { outcome: string }[]).map((row) => row.outcome);
}

interface Manager {
  readonly run: Runner;
  readonly calls: string[];
}

/**
 * The manager as the removal sees it. A unit the test does not list is inactive, which is what systemd reports for a unit whose files are
 * gone. A verb in `refused` is answered with a failure. `watch` sees every call before it is answered, and can change a unit's state, as
 * a start from outside the panel would.
 */
function manager(
  states: Record<string, string>,
  refused: string[] = [],
  watch: (argv: readonly string[], set: (unit: string, state: string) => void) => void = () => undefined,
): Manager {
  const active = new Map(Object.entries(states));
  const calls: string[] = [];
  const answer = (code: number, stdout = ""): Promise<RunResult> => Promise.resolve({ code, signal: null, stdout, stderr: "" });
  const set = (unit: string, state: string): void => {
    active.set(unit, state);
  };
  const run: Runner = (argv) => {
    calls.push(argv.join(" "));
    watch(argv, set);
    // Every call is ["systemctl", "--user", verb, ..., unit], and the unit is always last.
    const verb = argv[2] ?? "";
    const unit = argv[argv.length - 1] ?? "";
    if (refused.includes(verb)) return answer(1);
    if (verb === "show") return answer(0, `Id=${unit}\nActiveState=${active.get(unit) ?? "inactive"}\n`);
    if (verb === "stop") active.set(unit, "inactive");
    return answer(0);
  };
  return { run, calls };
}

describe("removing a server", () => {
  it("removes a stopped server, its unit files and its row, and records the removal", async () => {
    seedServer();
    const fake = manager({ [SERVICE]: "inactive", [SOCKET]: "inactive" });
    await removeServer({ db, config, run: fake.run, locks }, ID, ACTOR);
    expect(rowExists()).toBe(false);
    expect(existsSync(serviceFile(config.unitDir, ID))).toBe(false);
    expect(existsSync(socketFile(config.unitDir, ID))).toBe(false);
    expect(fake.calls.some((call) => call.includes(" stop "))).toBe(false);
    expect(removalOutcomes()).toEqual(["started", "ok"]);
  });

  it("stops a socket that still listens before it deletes any file, since a write to the socket would start the server again", async () => {
    seedServer();
    const filesAtStop: boolean[] = [];
    const fake = manager({ [SERVICE]: "inactive", [SOCKET]: "active" }, [], (argv) => {
      if (argv.includes("stop")) filesAtStop.push(existsSync(serviceFile(config.unitDir, ID)) && existsSync(socketFile(config.unitDir, ID)));
    });
    await removeServer({ db, config, run: fake.run, locks }, ID, ACTOR);
    expect(fake.calls).toContain(`systemctl --user stop -- ${SOCKET}`);
    expect(filesAtStop).toEqual([true]);
    expect(rowExists()).toBe(false);
    expect(existsSync(socketFile(config.unitDir, ID))).toBe(false);
  });

  it("refuses to remove when systemd will not stop the socket, and leaves every file and the row in place", async () => {
    seedServer();
    const fake = manager({ [SERVICE]: "inactive", [SOCKET]: "active" }, ["stop"]);
    await expect(removeServer({ db, config, run: fake.run, locks }, ID, ACTOR)).rejects.toThrow(/would not stop the server's socket/);
    expect(existsSync(serviceFile(config.unitDir, ID))).toBe(true);
    expect(existsSync(socketFile(config.unitDir, ID))).toBe(true);
    expect(rowExists()).toBe(true);
    expect(removalOutcomes()).toEqual(["started", "failed"]);
  });

  it("refuses a server whose service is still running, whatever its socket says, and deletes nothing", async () => {
    seedServer();
    const fake = manager({ [SERVICE]: "active", [SOCKET]: "inactive" });
    await expect(removeServer({ db, config, run: fake.run, locks }, ID, ACTOR)).rejects.toThrow(/Stop the server before removing it/);
    expect(fake.calls.some((call) => call.includes(" disable "))).toBe(false);
    expect(existsSync(serviceFile(config.unitDir, ID))).toBe(true);
    // The refusal is recorded like the power path's refusals: an attempt is started, and it fails.
    expect(removalOutcomes()).toEqual(["started", "failed"]);
  });

  it("refuses, and deletes nothing, when the server is started while its units are being disabled", async () => {
    seedServer();
    const fake = manager({ [SERVICE]: "inactive", [SOCKET]: "inactive" }, [], (argv, set) => {
      if (argv.includes("disable")) set(SERVICE, "active");
    });
    await expect(removeServer({ db, config, run: fake.run, locks }, ID, ACTOR)).rejects.toThrow(/Stop the server before removing it/);
    expect(existsSync(serviceFile(config.unitDir, ID))).toBe(true);
    expect(existsSync(socketFile(config.unitDir, ID))).toBe(true);
    expect(rowExists()).toBe(true);
    expect(removalOutcomes()).toEqual(["started", "failed"]);
  });

  it("refuses, and deletes nothing, when the socket listens again after it was stopped", async () => {
    seedServer();
    const fake = manager({ [SERVICE]: "inactive", [SOCKET]: "active" }, [], (argv, set) => {
      if (argv.includes("disable")) set(SOCKET, "active");
    });
    await expect(removeServer({ db, config, run: fake.run, locks }, ID, ACTOR)).rejects.toThrow(/socket started again/);
    expect(existsSync(serviceFile(config.unitDir, ID))).toBe(true);
    expect(existsSync(socketFile(config.unitDir, ID))).toBe(true);
    expect(rowExists()).toBe(true);
    expect(removalOutcomes()).toEqual(["started", "failed"]);
  });

  it("refuses when the panel cannot read the state of the units, rather than guessing that they are down", async () => {
    seedServer();
    const fake = manager({}, ["show"]);
    await expect(removeServer({ db, config, run: fake.run, locks }, ID, ACTOR)).rejects.toThrow(/cannot tell whether the server is running/);
    expect(existsSync(serviceFile(config.unitDir, ID))).toBe(true);
    expect(rowExists()).toBe(true);
  });

  it("finishes a removal an earlier attempt left half done, once both unit files are gone and systemd no longer lists the units", async () => {
    seedServer();
    rmSync(serviceFile(config.unitDir, ID));
    rmSync(socketFile(config.unitDir, ID));
    const fake = manager({});
    await removeServer({ db, config, run: fake.run, locks }, ID, ACTOR);
    expect(rowExists()).toBe(false);
    expect(removalOutcomes()).toEqual(["started", "ok"]);
  });

  it("finishes a removal whose only leftover is a socket file, and whose service file is already gone", async () => {
    seedServer();
    rmSync(serviceFile(config.unitDir, ID));
    const fake = manager({ [SOCKET]: "inactive" }, ["disable"]);
    await removeServer({ db, config, run: fake.run, locks }, ID, ACTOR);
    expect(rowExists()).toBe(false);
    expect(existsSync(socketFile(config.unitDir, ID))).toBe(false);
  });

  it("refuses a unit file that was edited by hand, and removes nothing", async () => {
    seedServer();
    writeFileSync(serviceFile(config.unitDir, ID), "# edited\n[Service]\nExecStart=/bin/false\n");
    const fake = manager({ [SERVICE]: "inactive", [SOCKET]: "inactive" });
    await expect(removeServer({ db, config, run: fake.run, locks }, ID, ACTOR)).rejects.toThrow(/edited by hand/);
    expect(rowExists()).toBe(true);
    expect(existsSync(socketFile(config.unitDir, ID))).toBe(true);
  });

  it("is refused while the server's operation lock is held, and nothing is touched", async () => {
    seedServer();
    const fake = manager({ [SERVICE]: "inactive", [SOCKET]: "inactive" });
    const release = locks.tryAcquire(ID, "start");
    await expect(removeServer({ db, config, run: fake.run, locks }, ID, ACTOR)).rejects.toBeInstanceOf(Busy);
    expect(fake.calls).toEqual([]);
    release?.();
  });
});
