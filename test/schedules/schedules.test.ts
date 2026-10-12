// Scheduled actions: validation, daylight-saving behaviour, every firing decision, and one real start fired through the identity
// check. The identity lookup is a stub standing in for the website; everything else is the real code and the real user manager.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cron } from "croner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import type { IdentityLookup, ScheduledIdentityAnswer } from "../../src/server/gate/identity.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { createScheduler, decideFiring, ScheduleError, validateSchedule, type Scheduler } from "../../src/server/schedules/scheduler.js";
import { Readiness } from "../../src/server/power/readiness.js";
import { addServer, removeServer } from "../../src/server/servers/service.js";
import { serviceFile, socketFile } from "../../src/server/servers/files.js";
import { getServer } from "../../src/server/servers/store.js";
import { runProcess } from "../../src/server/systemd/run.js";
import { observeUnits } from "../../src/server/systemd/user.js";

const FAKE_PAPER = fileURLToPath(new URL("../support/fake-paper.mjs", import.meta.url));
const ACTOR = { id: "owner-sched", label: "owner@test" };
const AVAILABLE = (() => {
  const out = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" }).stdout.trim();
  return out === "running" || out === "degraded";
})();

function stubIdentity(answer: ScheduledIdentityAnswer): IdentityLookup {
  return { lookup: () => Promise.resolve(answer) };
}

describe("validation", () => {
  it("refuses a cron expression that cannot be parsed, and an unknown time zone", () => {
    expect(() => validateSchedule("not a schedule", "UTC")).toThrow(ScheduleError);
    expect(() => validateSchedule("0 4 * * *", "Mars/Olympus")).toThrow(ScheduleError);
    expect(() => validateSchedule("0 4 * * *", "America/Chicago")).not.toThrow();
  });
});

describe("daylight saving", () => {
  it("fires once a day at a wall-clock time in its own zone, across the autumn change", () => {
    const zone = "America/Chicago";
    const job = new Cron("30 1 * * *", { timezone: zone, paused: true });
    const runs: string[] = [];
    let cursor = new Date("2026-10-31T12:00:00Z");
    for (let index = 0; index < 4; index += 1) {
      const next = job.nextRun(cursor);
      if (next === null) break;
      runs.push(next.toISOString());
      cursor = new Date(next.getTime() + 1000);
    }
    job.stop();
    const localDays = runs.map((iso) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)));
    expect(new Set(localDays).size).toBe(localDays.length);
    expect(runs.length).toBeGreaterThanOrEqual(3);
  });
});

describe("spring forward", () => {
  it("fires once on the change day, at the first valid time after the missing hour, and never twice", () => {
    const zone = "America/Chicago";
    const job = new Cron("30 2 * * *", { timezone: zone, paused: true });
    const runs: Date[] = [];
    let cursor = new Date("2026-03-07T12:00:00Z");
    for (let index = 0; index < 4; index += 1) {
      const next = job.nextRun(cursor);
      if (next === null) break;
      runs.push(next);
      cursor = new Date(next.getTime() + 1000);
    }
    job.stop();
    const local = (run: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(run);
    const changeDay = runs.filter((run) => local(run).startsWith("08/03/2026"));
    expect(changeDay).toHaveLength(1);
    expect(local(changeDay[0] ?? new Date(0))).toBe("08/03/2026, 03:30");
    const days = runs.map((run) => local(run).slice(0, 10));
    expect(new Set(days).size).toBe(days.length);
  });
});

describe("firing decisions", () => {
  it("runs only for a confirmed, authorised creator", () => {
    expect(decideFiring({ kind: "eligible", user: { id: "u", role: "ADMIN" } }, true)).toEqual({ run: true });
  });

  it("skips and says why for an unconfirmed creator, a removed one, and one who lost the capability", () => {
    const unavailable = decideFiring({ kind: "unavailable" }, false);
    const gone = decideFiring({ kind: "not_eligible" }, false);
    const demoted = decideFiring({ kind: "eligible", user: { id: "u", role: "ADMIN" } }, false);
    expect(unavailable).toMatchObject({ run: false });
    expect(gone).toMatchObject({ run: false });
    expect(demoted).toMatchObject({ run: false });
    expect((unavailable as { reason: string }).reason).toMatch(/could not confirm/);
    expect((gone as { reason: string }).reason).toMatch(/no longer has panel access/);
  });
});

describe.skipIf(!AVAILABLE)("the scheduler against the real user manager", () => {
  let root: string;
  let config: PanelConfig;
  let db: PanelDatabase;
  let locks: OperationLocks;
  const created: string[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "jass-panel-sched-"));
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
    for (const id of created) {
      if (getServer(db, id) !== undefined) await removeServer({ db, config, run: runProcess }, id, ACTOR).catch(() => undefined);
      await runProcess(["systemctl", "--user", "stop", "--", `jass-mc-${id}.service`], { timeoutMs: 130_000 });
      await runProcess(["systemctl", "--user", "disable", "--", `jass-mc-${id}.service`]);
      rmSync(serviceFile(config.unitDir, id), { force: true });
      rmSync(socketFile(config.unitDir, id), { force: true });
    }
    await runProcess(["systemctl", "--user", "daemon-reload"]);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function serverNamed(id: string): Promise<void> {
    created.push(id);
    const directory = join(root, id);
    mkdirSync(join(directory, "logs"), { recursive: true });
    await addServer({ db, config, run: runProcess }, { id, displayName: id, directory, logPath: "logs/latest.log", autostart: false, command: { kind: "custom", argv: [process.execPath, FAKE_PAPER] } }, ACTOR);
  }

  function schedulerWith(identity: IdentityLookup): Scheduler {
    return createScheduler({ db, config, run: runProcess, locks, readiness: new Readiness(), identity });
  }

  it("skips a firing whose creator the website cannot confirm, and records the skip", async () => {
    const id = "jass-test-sk-unavail";
    await serverNamed(id);
    const scheduler = schedulerWith(stubIdentity({ kind: "unavailable" }));
    const row = scheduler.add({ serverId: id, kind: "start", cron: "0 4 * * *", timezone: "UTC", payload: null, creatorId: "creator-1" });
    expect(await scheduler.fire(row.id)).toMatch(/could not confirm/);
    expect(scheduler.list(id)[0]?.lastResult).toMatch(/could not confirm/);
    scheduler.stop();
  }, 60_000);

  it("skips a creator who no longer holds the capability for the action, without running it", async () => {
    const id = "jass-test-sk-noncap";
    await serverNamed(id);
    const scheduler = schedulerWith(stubIdentity({ kind: "eligible", user: { id: "creator-2", role: "ADMIN" } }));
    const row = scheduler.add({ serverId: id, kind: "start", cron: "0 4 * * *", timezone: "UTC", payload: null, creatorId: "creator-2" });
    expect(await scheduler.fire(row.id)).toMatch(/no longer holds/);
    const states = await observeUnits(runProcess, [id]);
    expect([...states.values()][0]).toMatchObject({ known: true, state: { activeState: "inactive" } });
    scheduler.stop();
  }, 60_000);

  it("runs a start for a confirmed creator who holds the power grant, and the server comes up", async () => {
    const id = "jass-test-sk-run";
    await serverNamed(id);
    db.prepare("INSERT INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES ('creator-3', ?, 'power', 'test', 'now')").run(id);
    const scheduler = schedulerWith(stubIdentity({ kind: "eligible", user: { id: "creator-3", role: "ADMIN" } }));
    const row = scheduler.add({ serverId: id, kind: "start", cron: "0 4 * * *", timezone: "UTC", payload: null, creatorId: "creator-3" });
    expect(await scheduler.fire(row.id)).toBe("ok");
    const states = await observeUnits(runProcess, [id]);
    expect([...states.values()][0]).toMatchObject({ known: true, state: { activeState: "active" } });
    await scheduler.fire(scheduler.add({ serverId: id, kind: "stop", cron: "0 5 * * *", timezone: "UTC", payload: null, creatorId: "creator-3" }).id);
    scheduler.stop();
  }, 120_000);

  it("stores a command schedule; the console.send check belongs to the handler that accepts the request", async () => {
    const id = "jass-test-sk-cmd";
    await serverNamed(id);
    const scheduler = schedulerWith(stubIdentity({ kind: "unavailable" }));
    expect(() => scheduler.add({ serverId: id, kind: "command", cron: "0 4 * * *", timezone: "UTC", payload: "say hi", creatorId: "nobody" })).not.toThrow();
    scheduler.stop();
  }, 60_000);
});
