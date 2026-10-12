// The marker a restart leaves while the server is down between its stop and its start, and the start-up pass that reads it. The unit is a
// stand-in that the test controls. The marker is looked at while the stop is being answered, which is when a daemon that died would have
// left it behind, so the test sees the state the start-up pass would find.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { powerAction, reconcileRestarts, restartMarkerOf, type PowerDependencies } from "../../src/server/power/power.js";
import { Readiness } from "../../src/server/power/readiness.js";
import { insertServer } from "../../src/server/servers/store.js";
import type { Runner, RunResult } from "../../src/server/systemd/run.js";

const ACTOR = { id: "owner-restart-marker", label: "owner@test" };
const ID = "alpha";
const DONE = '[10:00:00 INFO]: Done (0.5s)! For help, type "help"';
const INVOCATION = "0123456789abcdef0123456789abcdef";

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let locks: OperationLocks;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-restart-marker-"));
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data"), XDG_RUNTIME_DIR: join(root, "run") }, { uid: 1000 });
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

function showBlock(active: boolean): string {
  return `Id=jass-mc-${ID}.service\nActiveState=${active ? "active" : "inactive"}\nSubState=running\nResult=success\nMainPID=42\nActiveEnterTimestamp=Sun 2026-10-11 08:00:00 CDT\nInvocationID=${INVOCATION}\n`;
}

/** A unit the stop and the start change. `onStop` runs before the stop is answered, which is when a daemon that died would leave its marker. */
function unit(state: { active: boolean }, onStop: () => void = () => undefined): Runner {
  const answer = (code: number, stdout = ""): Promise<RunResult> => Promise.resolve({ code, signal: null, stdout, stderr: "" });
  return (argv) => {
    if (argv[0] === "journalctl") return answer(0, state.active ? `${DONE}\n` : "");
    if (argv.includes("stop")) {
      onStop();
      state.active = false;
      return answer(0);
    }
    if (argv.includes("start")) {
      state.active = true;
      return answer(0);
    }
    if (argv.includes("is-active")) return answer(3);
    if (argv.includes("show")) return answer(0, showBlock(state.active));
    return answer(0);
  };
}

function deps(run: Runner): PowerDependencies {
  return { db, config, run, locks, readiness: new Readiness(), sleep: () => Promise.resolve(), loadWindowMs: 5_000, loadPollMs: 1 };
}

describe("the restart marker", () => {
  it("is written while the server is down between the stop and the start, and removed once the restart ends", async () => {
    const state = { active: true };
    let seenDuringStop: boolean | null = null;
    const markers = config.paths.markers;
    const result = await powerAction(
      deps(unit(state, () => (seenDuringStop = existsSync(restartMarkerOf(markers, ID))))),
      ID,
      "restart",
      ACTOR,
    );
    expect(result.outcome).toBe("done");
    expect(seenDuringStop).toBe(true);
    expect(existsSync(restartMarkerOf(markers, ID))).toBe(false);
  });

  it("is not written by a stop, and a start clears one a dead daemon left behind", async () => {
    const markers = config.paths.markers;
    mkdirSync(markers, { recursive: true });
    writeFileSync(restartMarkerOf(markers, ID), "left by a daemon that died\n");
    await powerAction(deps(unit({ active: false })), ID, "start", ACTOR);
    expect(existsSync(restartMarkerOf(markers, ID))).toBe(false);
  });

  it("is left in place by a start that is refused before any work begins", async () => {
    const markers = config.paths.markers;
    mkdirSync(markers, { recursive: true });
    writeFileSync(restartMarkerOf(markers, ID), "left by a daemon that died\n");
    await expect(powerAction(deps(unit({ active: true })), ID, "start", ACTOR)).rejects.toThrow(/already running/);
    expect(existsSync(restartMarkerOf(markers, ID))).toBe(true);
  });

  it("is reported at start-up when the server is stopped, and cleared when the server is running", async () => {
    const markers = config.paths.markers;
    mkdirSync(markers, { recursive: true });
    writeFileSync(restartMarkerOf(markers, ID), "left\n");
    const state = { active: false };
    expect(await reconcileRestarts(deps(unit(state)))).toEqual([ID]);
    expect(existsSync(restartMarkerOf(markers, ID))).toBe(true);
    state.active = true;
    expect(await reconcileRestarts(deps(unit(state)))).toEqual([]);
    expect(existsSync(restartMarkerOf(markers, ID))).toBe(false);
  });

  it("is cleared at start-up for a server that no longer exists", async () => {
    const markers = config.paths.markers;
    mkdirSync(markers, { recursive: true });
    writeFileSync(restartMarkerOf(markers, "removed"), "left\n");
    expect(await reconcileRestarts(deps(unit({ active: false })))).toEqual([]);
    expect(existsSync(restartMarkerOf(markers, "removed"))).toBe(false);
  });
});
