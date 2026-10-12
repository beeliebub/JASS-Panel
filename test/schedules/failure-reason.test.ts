// A scheduled firing that fails for a reason the panel did not raise records only a generic reason. The message of an error from outside the
// panel can carry a path or a URL, so it is kept out of the schedule's result, and the daemon log is given the error to report by its name.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import type { IdentityLookup } from "../../src/server/gate/identity.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { Readiness } from "../../src/server/power/readiness.js";
import { createScheduler, type Scheduler } from "../../src/server/schedules/scheduler.js";
import { insertServer } from "../../src/server/servers/store.js";

const ID = "alpha";
const OWNER = { id: "owner-failure-reason", role: "OWNER" as const };
const SECRET_PATH = "/srv/private-folder/token-file";

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let scheduler: Scheduler | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-failure-reason-"));
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data"), XDG_RUNTIME_DIR: join(root, "run") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  insertServer(
    db,
    { id: ID, displayName: "Alpha", directory: join(root, ID), startCommand: ["/bin/true"], memory: null, logPath: "logs/latest.log", autostart: false, updateOnStart: false, unitDigest: "unused", socketDigest: "unused" },
    new Date().toISOString(),
  );
  scheduler = null;
});

afterEach(() => {
  scheduler?.stop();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a scheduled firing that fails outside the panel's own errors", () => {
  it("records a generic reason, leaves the message out, and hands the error to the daemon log", async () => {
    const reported: unknown[] = [];
    const identity: IdentityLookup = { lookup: () => Promise.resolve({ kind: "eligible", user: { id: OWNER.id, role: OWNER.role } }) };
    const run = () => Promise.reject(new Error(`cannot read ${SECRET_PATH}`));
    scheduler = createScheduler({ db, config, run, locks: new OperationLocks(), readiness: new Readiness(), identity, onError: (error) => reported.push(error) });
    const schedule = scheduler.add({ serverId: ID, kind: "backup", cron: "0 0 1 1 *", timezone: "UTC", payload: null, creatorId: OWNER.id });
    const result = await scheduler.fire(schedule.id);
    expect(result).toBe("failed: an unexpected error; the daemon log has its name");
    expect(result).not.toContain(SECRET_PATH);
    expect(db.prepare("SELECT last_result FROM schedules WHERE id = ?").get(schedule.id)).toEqual({ last_result: result });
    expect(reported).toHaveLength(1);
  });
});
