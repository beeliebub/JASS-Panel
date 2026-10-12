// A scheduled start whose server never reports that it has loaded is a failure that alerts, not a success. The manager is a stand-in: the
// unit becomes active when the start is issued, and its journal never prints the Done line. The wait is shortened, so the five-minute window
// is not spent, and nothing here touches a real unit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AlertService } from "../../src/server/alerts/alerts.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { Readiness } from "../../src/server/power/readiness.js";
import { createScheduler, type Scheduler } from "../../src/server/schedules/scheduler.js";
import { insertServer } from "../../src/server/servers/store.js";
import type { Runner, RunResult } from "../../src/server/systemd/run.js";

const ID = "alpha";
const UNIT = `jass-mc-${ID}.service`;
const INVOCATION = "0123456789abcdef0123456789abcdef";
const OWNER = { id: "owner-scheduled-start", role: "OWNER" as const };

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let locks: OperationLocks;
let scheduler: Scheduler | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-scheduled-start-"));
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data"), XDG_RUNTIME_DIR: join(root, "run") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
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
      unitDigest: "unused",
      socketDigest: "unused",
    },
    new Date().toISOString(),
  );
  locks = new OperationLocks();
  scheduler = null;
});

afterEach(() => {
  scheduler?.stop();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A unit that is inactive until its start is issued, then active. Its journal is answered, but it never prints the Done line. */
function startsWithoutLoading(): Runner {
  let active = false;
  const answer = (code: number, stdout = ""): Promise<RunResult> => Promise.resolve({ code, signal: null, stdout, stderr: "" });
  return (argv) => {
    if (argv[0] === "journalctl") return answer(0, "");
    if (argv.includes("start")) active = true;
    if (argv.includes("is-active")) return answer(3);
    if (argv.includes("show")) {
      return answer(
        0,
        `Id=${UNIT}\nActiveState=${active ? "active" : "inactive"}\nSubState=running\nResult=success\nMainPID=42\nActiveEnterTimestamp=Sun 2026-10-11 08:00:00 CDT\nInvocationID=${INVOCATION}\n`,
      );
    }
    return answer(0);
  };
}

describe("a scheduled start", () => {
  it("that the server never reports as loaded is a failure, which alerts, and the server is left running", async () => {
    const raised: unknown[][] = [];
    const alerts: AlertService = {
      raise: (kind, serverId, message) => {
        raised.push([kind, serverId, message]);
        return Promise.resolve(true);
      },
      clear: () => undefined,
      configured: () => true,
      setWebhook: () => undefined,
    };
    scheduler = createScheduler({
      db,
      config,
      run: startsWithoutLoading(),
      locks,
      readiness: new Readiness(),
      identity: { lookup: () => Promise.resolve({ kind: "eligible", user: OWNER }) },
      alerts,
      powerTiming: { loadWindowMs: 60, loadPollMs: 5 },
    });
    const schedule = scheduler.add({ serverId: ID, kind: "start", cron: "0 4 * * *", timezone: "UTC", payload: null, creatorId: OWNER.id });

    const result = await scheduler.fire(schedule.id);

    expect(result).toMatch(/^failed: the server did not report that it had loaded within five minutes/);
    expect(locks.holder(ID)).toBeNull();
    const last = db.prepare("SELECT last_result FROM schedules WHERE id = ?").get(schedule.id) as { last_result: string };
    expect(last.last_result).toMatch(/^failed:/);
    const scheduleRows = db.prepare("SELECT outcome FROM audit WHERE action = 'schedule.start' ORDER BY id").all() as { outcome: string }[];
    expect(scheduleRows.map((row) => row.outcome)).toEqual(["failed"]);
    expect(raised).toEqual([["schedule-failed", ID, expect.stringContaining("A scheduled start on alpha failed")]]);
    const powerRows = db.prepare("SELECT outcome, details FROM audit WHERE action = 'power.start' ORDER BY id").all() as { outcome: string; details: string | null }[];
    expect(powerRows.map((row) => row.outcome)).toEqual(["started", "ok"]);
    expect(JSON.parse(powerRows[1]?.details ?? "null")).toEqual({ loaded: false });
  });
});
