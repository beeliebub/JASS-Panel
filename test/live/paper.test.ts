// A live check against a real Paper server. It runs only when the operator names a Paper jar and accepts the Minecraft EULA: set
// JASS_LIVE_PAPER_JAR to the jar's path and JASS_LIVE_PAPER_EULA to "accepted". The server lives in a temporary directory under a unit
// named with the jass-test- prefix, which is stopped and removed in afterAll. These are the checks a fake Paper cannot make: the start's
// wait for the real Done line, the countdown's warnings in the real log, a cancel, a stop that ends a start still loading, a backup with
// the real save confirmations, and a restart.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBackup, markerOf } from "../../src/server/backups/backup.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { powerAction, restartMarkerOf, type PowerDependencies } from "../../src/server/power/power.js";
import { observeServers, Readiness } from "../../src/server/power/readiness.js";
import { addServer, removeServer } from "../../src/server/servers/service.js";
import { getServer } from "../../src/server/servers/store.js";
import { serviceFile, socketFile } from "../../src/server/servers/files.js";
import { runProcess } from "../../src/server/systemd/run.js";
import { observeUnits } from "../../src/server/systemd/user.js";

const JAR = process.env.JASS_LIVE_PAPER_JAR ?? "";
const LIVE = JAR !== "" && process.env.JASS_LIVE_PAPER_EULA === "accepted";
const ACTOR = { id: "owner-live-paper", label: "owner@test" };
const ID = `jass-test-live-${Math.random().toString(36).slice(2, 8)}`;
const UNIT = `jass-mc-${ID}.service`;
const LIMIT = 900_000;

let root = "";
let directory = "";
let config: PanelConfig;
let db: PanelDatabase;
let locks: OperationLocks;
let deps: PowerDependencies;

function log(): string {
  return existsSync(join(directory, "logs", "latest.log")) ? readFileSync(join(directory, "logs", "latest.log"), "utf8") : "";
}

async function stateOf(): Promise<string> {
  const [state] = [...(await observeUnits(runProcess, [ID])).values()];
  return state?.known ? state.state.activeState : "unknown";
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the condition was not met in time");
}

beforeAll(() => {
  if (!LIVE) return;
  root = mkdtempSync(join(tmpdir(), "jass-panel-live-paper-"));
  directory = join(root, "server");
  mkdirSync(directory, { recursive: true });
  copyFileSync(JAR, join(directory, "paper.jar"));
  writeFileSync(join(directory, "eula.txt"), "eula=true\n");
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data"), XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}` }, { uid: process.getuid?.() ?? 0 });
  mkdirSync(config.unitDir, { recursive: true });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  locks = new OperationLocks();
  const readiness = new Readiness({ markers: config.paths.markers });
  deps = { db, config, run: runProcess, locks, readiness, stillHolds: () => Promise.resolve({ holds: true }) };
});

afterAll(async () => {
  if (!LIVE) return;
  try {
    await runProcess(["systemctl", "--user", "stop", "--", UNIT], { timeoutMs: 150_000 });
    await runProcess(["systemctl", "--user", "disable", "--", UNIT]);
    await runProcess(["systemctl", "--user", "reset-failed", "--", UNIT]);
    rmSync(serviceFile(config.unitDir, ID), { force: true });
    rmSync(socketFile(config.unitDir, ID), { force: true });
    db.prepare("DELETE FROM servers WHERE id = ?").run(ID);
    await runProcess(["systemctl", "--user", "daemon-reload"]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!LIVE)("a real Paper server", () => {
  it(
    "is added with the Paper preset and starts, returning done once Paper prints its Done line",
    async () => {
      await addServer(deps, { id: ID, displayName: "Live check", directory, logPath: "logs/latest.log", autostart: false, command: { kind: "paper", javaPath: "/usr/bin/java", minMb: 512, maxMb: 1024, jarFile: "paper.jar", extraFlags: [] } }, ACTOR);
      const result = await powerAction(deps, ID, "start", ACTOR);
      expect(result.outcome).toBe("done");
      expect(log()).toContain("Done (");
      expect(await stateOf()).toBe("active");
    },
    LIMIT,
  );

  it(
    "takes a backup of the running world, with real save confirmations, and turns auto-save back on",
    async () => {
      const row = await createBackup({ db, config, run: runProcess, locks, zstd: true, readiness: deps.readiness }, ID, ACTOR, "manual");
      expect(row.file.endsWith(".tar.zst")).toBe(true);
      expect(existsSync(markerOf(config, ID))).toBe(false);
      expect(log()).toContain("Automatic saving is now enabled");
    },
    LIMIT,
  );

  it(
    "warns players in the real log before a stop, then stops the server",
    async () => {
      const result = await powerAction(deps, ID, "stop", ACTOR, { countdownSeconds: 3 });
      expect(result.outcome).toBe("done");
      expect(log()).toContain("Server stopping in 3 seconds");
      expect(await stateOf()).toBe("inactive");
    },
    LIMIT,
  );

  it(
    "cancels a countdown that is under way, and leaves the server running",
    async () => {
      await powerAction(deps, ID, "start", ACTOR);
      const stopping = powerAction(deps, ID, "stop", ACTOR, { countdownSeconds: 10, scheduled: false });
      await waitUntil(() => Promise.resolve((locks.countdowns.describe(ID)?.warningsSent ?? 0) >= 1), 60_000);
      const shown = locks.countdowns.describe(ID);
      expect(locks.countdowns.cancel(ID, { id: ACTOR.id, label: ACTOR.label }, shown?.id ?? "none")).toBe("cancelled");
      const result = await stopping;
      expect(result.outcome).toBe("cancelled");
      expect(await stateOf()).toBe("active");
      expect(log()).toContain("The planned stop was cancelled");
    },
    LIMIT,
  );

  it(
    "ends a start that is still loading when a stop is sent, and the stop goes ahead",
    async () => {
      await powerAction(deps, ID, "stop", ACTOR);
      const starting = powerAction(deps, ID, "start", ACTOR).then(
        () => new Error("the start was not interrupted"),
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
      await waitUntil(async () => {
        const seen = (await observeServers(runProcess, deps.readiness ?? new Readiness(), [ID])).get(ID);
        return seen?.known === true && seen.state.activeState === "active" && !seen.state.loaded;
      }, 120_000);
      const stop = await powerAction(deps, ID, "stop", ACTOR);
      expect(stop.outcome).toBe("done");
      const interrupted = await starting;
      expect(interrupted.message).toMatch(/stop ended the start/);
      expect(await stateOf()).toBe("inactive");
    },
    LIMIT,
  );

  it(
    "restarts the server, with its restart marker gone once the restart has loaded",
    async () => {
      await powerAction(deps, ID, "start", ACTOR);
      const result = await powerAction(deps, ID, "restart", ACTOR);
      expect(result.outcome).toBe("done");
      expect(existsSync(restartMarkerOf(config.paths.markers, ID))).toBe(false);
      expect(await stateOf()).toBe("active");
    },
    LIMIT,
  );

  it(
    "removes the server after it is stopped, its unit files and row included",
    async () => {
      await powerAction(deps, ID, "stop", ACTOR);
      await removeServer(deps, ID, ACTOR);
      expect(getServer(db, ID)).toBeUndefined();
      expect(existsSync(serviceFile(config.unitDir, ID))).toBe(false);
    },
    LIMIT,
  );
});
