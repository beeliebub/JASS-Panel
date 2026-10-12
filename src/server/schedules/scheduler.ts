// Scheduled actions. A schedule is a row fired by croner in its own time zone. A firing has no browser behind it, so it asks the
// website whether its creator still qualifies (the identity route, never cached) and then checks the creator's grant for the
// action's capability. Only a confirmed, authorised creator with no conflicting operation runs the action; anything else is skipped
// and recorded. A daemon that was down at a due time does not replay the firing.
import { Cron } from "croner";
import { recordAudit } from "../audit/audit.js";
import { authorize } from "../authz/authorize.js";
import type { Capability } from "../authz/capabilities.js";
import { decideHold, stillHolds, type HoldCheck } from "../authz/recheck.js";
import type { PanelConfig } from "../config/config.js";
import type { PanelDatabase } from "../db/open.js";
import type { IdentityLookup, ScheduledIdentityAnswer } from "../gate/identity.js";
import type { OperationLocks } from "../power/lock.js";
import { fifoPath, powerAction, type PowerDependencies } from "../power/power.js";
import { observeServers, type Readiness } from "../power/readiness.js";
import { sendCommand } from "../console/fifo.js";
import { createBackup, type BackupDependencies } from "../backups/backup.js";
import type { Runner } from "../systemd/run.js";
import { getServer } from "../servers/store.js";
import { Busy, ServiceError } from "../servers/service.js";
import type { AlertService } from "../alerts/alerts.js";
import { schedulePowerPayloadSchema } from "../../shared/servers.js";

export const SCHEDULE_KINDS = ["start", "stop", "restart", "backup", "command"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** The capability a creator must hold, both when the schedule is made and at every firing. */
export const CAPABILITY_FOR: Record<ScheduleKind, Capability> = {
  start: "power",
  stop: "power",
  restart: "power",
  backup: "backups",
  command: "console.send",
};

export class ScheduleError extends Error {}

/** The most schedules one server may hold, so a server's firings cannot grow without bound. */
export const MAX_SCHEDULES_PER_SERVER = 20;
/** Firings that may run at once. One that finds every slot taken is skipped and recorded, not queued behind the others. */
const MAX_FIRINGS_IN_FLIGHT = 4;

export function validateSchedule(cron: string, timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ScheduleError("that time zone is not known");
  }
  try {
    const probe = new Cron(cron, { timezone, paused: true });
    probe.stop();
  } catch {
    throw new ScheduleError("that schedule is not a valid cron expression");
  }
}

export type FiringDecision = { readonly run: true } | { readonly run: false; readonly reason: string };

/**
 * Whether a failed firing was refused before it began. A refusal is skipped and recorded: a held lock, a creator who no longer holds the
 * capability, or a precondition that does not hold. Work that had begun is a failure, which alerts. A backup is never skipped for a
 * precondition, because a missed backup must be reported; only a held lock skips it.
 */
function refusedBeforeWork(kind: ScheduleKind, error: unknown): boolean {
  if (!(error instanceof ServiceError)) return false;
  if (error.code === "forbidden") return true;
  if (error.began) return false;
  if (kind === "backup") return error instanceof Busy;
  return error.code === "conflict";
}

/** Decides a firing from what is known about the creator. Unknown is never a reason to run. */
export function decideFiring(answer: ScheduledIdentityAnswer, authorized: boolean): FiringDecision {
  const hold: HoldCheck = decideHold(answer, authorized);
  return hold.holds ? { run: true } : { run: false, reason: `skipped: ${hold.reason}` };
}

/** The payload a stop or restart schedule stores. Zero is stored too, so "no warning" is written down rather than left blank. */
export function countdownPayload(seconds: number): string {
  return JSON.stringify({ countdownSeconds: seconds });
}

/**
 * The warning a stored payload names. A null payload is no warning: that is how schedules made before countdowns were offered read.
 * Any other payload must parse, or the firing fails; a payload is never guessed at.
 */
export function countdownOf(payload: string | null): number {
  if (payload === null) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new ScheduleError("the stored countdown is not valid");
  }
  const checked = schedulePowerPayloadSchema.safeParse(parsed);
  if (!checked.success) throw new ScheduleError("the stored countdown is not valid");
  return checked.data.countdownSeconds;
}

export interface ScheduleRecord {
  readonly id: number;
  readonly serverId: string;
  readonly kind: ScheduleKind;
  readonly cron: string;
  readonly timezone: string;
  readonly payload: string | null;
  readonly enabled: boolean;
  readonly creatorId: string;
  readonly lastRunAt: string | null;
  readonly lastResult: string | null;
  readonly createdAt: string;
}

export interface SchedulerDependencies {
  readonly db: PanelDatabase;
  readonly config: PanelConfig;
  readonly run: Runner;
  readonly locks: OperationLocks;
  readonly readiness: Readiness;
  readonly identity: IdentityLookup;
  readonly alerts?: AlertService;
  /** Aborted when the daemon begins to stop. A countdown in progress is then abandoned, so it cannot stop a server during shutdown. */
  readonly stopping?: AbortSignal;
  /** Called when a firing could not be finished or recorded, so the daemon reports it instead of crashing on an unhandled rejection. */
  readonly onError?: (error: unknown) => void;
  readonly now?: () => Date;
  readonly backupOptions?: Omit<BackupDependencies, "db" | "config" | "run" | "locks" | "readiness">;
  /** How long a scheduled start or restart waits for the server's report of loading, and how often. Tests shorten the wait; production leaves it out. */
  readonly powerTiming?: Pick<PowerDependencies, "loadWindowMs" | "loadPollMs" | "sleep">;
}

export interface Scheduler {
  load(): void;
  /** Waits up to timeoutMs for firings already running; returns how many were still running when it stopped waiting. */
  drain(timeoutMs: number): Promise<number>;
  add(input: { serverId: string; kind: ScheduleKind; cron: string; timezone: string; payload: string | null; creatorId: string }): ScheduleRecord;
  remove(id: number): boolean;
  list(serverId: string): ScheduleRecord[];
  fire(id: number): Promise<string>;
  stop(): void;
}

/** The schedules table as SQLite returns it. */
interface ScheduleRow {
  readonly id: number;
  readonly server_id: string;
  readonly kind: ScheduleKind;
  readonly cron: string;
  readonly timezone: string;
  readonly payload: string | null;
  readonly enabled: number;
  readonly creator_id: string;
  readonly last_run_at: string | null;
  readonly last_result: string | null;
  readonly created_at: string;
}

function rowToRecord(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    kind: row.kind,
    cron: row.cron,
    timezone: row.timezone,
    payload: row.payload,
    enabled: row.enabled === 1,
    creatorId: row.creator_id,
    lastRunAt: row.last_run_at,
    lastResult: row.last_result,
    createdAt: row.created_at,
  };
}

export function createScheduler(deps: SchedulerDependencies): Scheduler {
  const now = deps.now ?? (() => new Date());
  const jobs = new Map<number, Cron>();

  function record(id: number, result: string, at: Date): void {
    deps.db.prepare("UPDATE schedules SET last_run_at = ?, last_result = ? WHERE id = ?").run(at.toISOString(), result, id);
  }

  async function fire(id: number): Promise<string> {
    const row = deps.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
    if (row === undefined) return "gone";
    const schedule = rowToRecord(row);
    const at = now();
    // A lookup that rejects is treated as unavailable, so the firing is recorded like any other refusal rather than lost.
    const answer = await deps.identity.lookup(schedule.creatorId).catch((): ScheduledIdentityAnswer => ({ kind: "unavailable" }));
    const authorized =
      answer.kind === "eligible" &&
      authorize(deps.db, { id: answer.user.id, role: answer.user.role }, CAPABILITY_FOR[schedule.kind], schedule.serverId);
    const decision = decideFiring(answer, authorized);
    const actorFields = { userId: schedule.creatorId, userLabel: `schedule ${schedule.id}`, serverId: schedule.serverId };
    if (!decision.run) {
      record(id, decision.reason, at);
      recordAudit(deps.db, { ...actorFields, action: `schedule.${schedule.kind}`, outcome: "denied", details: { reason: decision.reason } }, at);
      return decision.reason;
    }
    try {
      const result = await runAction(schedule);
      record(id, result, at);
      recordAudit(deps.db, { ...actorFields, action: `schedule.${schedule.kind}`, outcome: result === "cancelled" ? "cancelled" : "ok" }, at);
      return result;
    } catch (error) {
      // Only the panel's own messages are recorded. Any other error can carry a path or a URL, so only its name reaches the daemon log.
      if (!(error instanceof ServiceError || error instanceof ScheduleError)) deps.onError?.(error);
      const reason = error instanceof ServiceError || error instanceof ScheduleError ? error.message : "an unexpected error; the daemon log has its name";
      if (refusedBeforeWork(schedule.kind, error)) {
        record(id, `skipped: ${reason}`, at);
        recordAudit(deps.db, { ...actorFields, action: `schedule.${schedule.kind}`, outcome: "denied", details: { reason } }, at);
        return `skipped: ${reason}`;
      }
      record(id, `failed: ${reason}`, at);
      recordAudit(deps.db, { ...actorFields, action: `schedule.${schedule.kind}`, outcome: "failed" }, at);
      void deps.alerts?.raise("schedule-failed", schedule.serverId, `A scheduled ${schedule.kind} on ${schedule.serverId} failed: ${reason}`);
      return `failed: ${reason}`;
    }
  }

  /** Runs the action and says how it ended: "ok", "cancelled" for a countdown its starter cancelled, or the reason a stop did not finish. */
  async function runAction(schedule: ScheduleRecord): Promise<string> {
    const actor = { id: schedule.creatorId, label: `schedule ${schedule.id}` };
    if (schedule.kind === "backup") {
      const backupOptions = deps.backupOptions ?? {};
      await createBackup(
        {
          ...backupOptions,
          db: deps.db,
          config: deps.config,
          run: deps.run,
          locks: deps.locks,
          readiness: deps.readiness,
          now,
          onAutoSaveUnconfirmed: (serverId) => void deps.alerts?.raise("auto-save", serverId, "A backup finished, but the server did not confirm that auto-save is back on."),
        },
        schedule.serverId,
        actor,
        "scheduled",
      );
      return "ok";
    }
    if (schedule.kind === "command") {
      // A command written to a stopped server with its socket still open would start it, so a command needs a running, loaded server, as chat does.
      const [state] = [...(await observeServers(deps.run, deps.readiness, [schedule.serverId])).values()];
      if (state === undefined || !state.known || state.state.activeState !== "active") throw new ServiceError("conflict", "the server is not running");
      if (!state.state.loaded) throw new ServiceError("conflict", "the server is still loading");
      // A command schedule always stores its text when it is made; an empty line must never be sent in its place.
      if (schedule.payload === null) throw new ScheduleError("the command is missing");
      const outcome = sendCommand(fifoPath(deps.config.runtimeDir, schedule.serverId), schedule.payload);
      if (!outcome.delivered) throw new ServiceError("conflict", "the server is not accepting input");
      return "ok";
    }
    // The countdown is read before anything else, so a payload that does not parse fails the firing before any warning is given.
    const countdownSeconds = schedule.kind === "stop" || schedule.kind === "restart" ? countdownOf(schedule.payload) : 0;
    const result = await powerAction(
      {
        db: deps.db,
        config: deps.config,
        run: deps.run,
        locks: deps.locks,
        readiness: deps.readiness,
        now,
        stillHolds: (userId) => stillHolds(deps.identity, deps.db, userId, CAPABILITY_FOR[schedule.kind], schedule.serverId),
        ...(deps.powerTiming ?? {}),
      },
      schedule.serverId,
      schedule.kind,
      actor,
      { countdownSeconds, scheduled: true, ...(deps.stopping === undefined ? {} : { signal: deps.stopping }) },
    );
    if (result.outcome === "cancelled") return "cancelled";
    // A scheduled start or restart that the server never reported as loaded is a failure, so it alerts: the schedule asked for a running server.
    if (result.outcome === "not_loaded") throw new ScheduleError("the server did not report that it had loaded within five minutes, and it was left running");
    if (result.outcome === "unknown") throw new ScheduleError("the panel could not confirm that the server started, and it may still come up");
    return "ok";
  }

  const running = new Set<Promise<unknown>>();
  function track(work: Promise<unknown>): void {
    running.add(work);
    void work.finally(() => running.delete(work));
  }

  function schedule(row: ScheduleRecord): void {
    if (!row.enabled || jobs.has(row.id)) return;
    const job = new Cron(row.cron, { timezone: row.timezone, name: `schedule-${row.id}` }, () => {
      if (running.size >= MAX_FIRINGS_IN_FLIGHT) {
        // A firing that cannot start is not dropped quietly: it is recorded and alerts, as a failed firing does, so a missed backup is seen.
        record(row.id, "skipped: too many scheduled actions are running", now());
        void deps.alerts?.raise("schedule-failed", row.serverId, `A scheduled ${row.kind} on ${row.serverId} did not run, because too many scheduled actions were already running.`);
        return;
      }
      track(fire(row.id).catch((error: unknown) => deps.onError?.(error)));
    });
    jobs.set(row.id, job);
  }

  return {
    load() {
      const rows = deps.db.prepare("SELECT * FROM schedules WHERE enabled = 1").all() as ScheduleRow[];
      for (const row of rows) schedule(rowToRecord(row));
    },
    add(input) {
      if (getServer(deps.db, input.serverId) === undefined) throw new ScheduleError("there is no such server");
      const held = (deps.db.prepare("SELECT COUNT(*) AS count FROM schedules WHERE server_id = ?").get(input.serverId) as { count: number }).count;
      if (held >= MAX_SCHEDULES_PER_SERVER) throw new ScheduleError(`a server can hold at most ${MAX_SCHEDULES_PER_SERVER} schedules`);
      validateSchedule(input.cron, input.timezone);
      const at = now().toISOString();
      const id = Number(
        deps.db
          .prepare("INSERT INTO schedules (server_id, kind, cron, timezone, payload, enabled, creator_id, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
          .run(input.serverId, input.kind, input.cron, input.timezone, input.payload, input.creatorId, at).lastInsertRowid,
      );
      const row = rowToRecord(deps.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow);
      schedule(row);
      return row;
    },
    remove(id) {
      jobs.get(id)?.stop();
      jobs.delete(id);
      return deps.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes === 1;
    },
    list(serverId) {
      return (deps.db.prepare("SELECT * FROM schedules WHERE server_id = ? ORDER BY id").all(serverId) as ScheduleRow[]).map(rowToRecord);
    },
    fire,
    async drain(timeoutMs: number): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      while (running.size > 0 && Date.now() < deadline) {
        await Promise.race([Promise.allSettled([...running]), new Promise((resolve) => setTimeout(resolve, deadline - Date.now()))]);
      }
      return running.size;
    },
    stop() {
      for (const job of jobs.values()) job.stop();
      jobs.clear();
    },
  };
}
