// Start, stop and restart. A start clears a failed state first and removes a stale FIFO, but only when the socket that owns it is not
// active: removing a live FIFO would break a running server's console. Unknown state refuses a start, because the panel cannot know that
// it is safe. The operation holds the server's lock for its whole length, a countdown included, so no other operation can begin while
// players are being warned. A start or restart returns once the server reports that it has loaded, or after five minutes with the server
// left running. A stop without a warning may end a start or restart that is still waiting for that report. A countdown lives only in
// this call: a daemon restart or shutdown abandons it and leaves the server running.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { recordAudit } from "../audit/audit.js";
import type { HoldCheck } from "../authz/recheck.js";
import { sendCommand } from "../console/fifo.js";
import type { PowerOutcome } from "../../shared/servers.js";
import { Busy, ServiceError, type Actor, type ServiceDependencies } from "../servers/service.js";
import { getServer, type ServerRecord } from "../servers/store.js";
import { observeUnits, serviceUnit, socketUnit, type ObservedState } from "../systemd/user.js";
import { Countdown } from "./countdown.js";
import type { LoadWait, OperationLocks } from "./lock.js";
import { observeServers, type Readiness } from "./readiness.js";
import { changedDuringCountdown, countDown, pause, warningMarks, type CountdownProgress } from "./warnings.js";

export { warningMarks };
export type { PowerOutcome };
export type PowerAction = "start" | "stop" | "restart";

export interface PowerOptions {
  /** Seconds of warning to players before a stop or restart. Zero, or no value, acts at once. A start never has one. */
  readonly countdownSeconds?: number;
  /** Aborted when the daemon is stopping. A countdown in progress is abandoned, and the server is not stopped by that. */
  readonly signal?: AbortSignal;
  /** True when a schedule, not a person, asked for the action, so its countdown is shown as scheduled. */
  readonly scheduled?: boolean;
}

export interface PowerResult {
  readonly state: ObservedState;
  readonly outcome: PowerOutcome;
}

export interface PowerDependencies extends ServiceDependencies {
  readonly locks: OperationLocks;
  readonly readiness: Readiness;
  /**
   * Whether the person who began a countdown still holds the power capability on the server. It is asked when the countdown ends and
   * before anything is stopped. A countdown is refused when this is not given, because the starter could not then be checked.
   */
  readonly stillHolds?: (userId: string) => Promise<HoldCheck>;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Whether each warning must be echoed in the server's log before the next wait. Defaults to true; a test with no server log turns it off.
   */
  readonly confirmWarning?: boolean;
  /** How long to wait for a warning to appear in the log. The default is ten seconds; tests shorten it. */
  readonly warningEchoMs?: number;
  /** How long a start or restart waits for the server to report that it has loaded. Five minutes by design; tests shorten it. */
  readonly loadWindowMs?: number;
  /** How often that wait looks at the unit. */
  readonly loadPollMs?: number;
}

// The unit allows 300 seconds to start, and an update step inside the start can use most of that; the wait here must not be shorter.
const START_TIMEOUT_MS = 330_000;
const STOP_TIMEOUT_MS = 150_000;
const LOAD_WINDOW_MS = 5 * 60_000;
const LOAD_POLL_MS = 1000;
// A unit in one of these states may still report that it has loaded; any other state means the start has ended.
const STARTING_STATES: ReadonlySet<string> = new Set(["active", "activating", "reloading"]);

/** A stop ended a start or restart before the server reported that it had loaded. The start's request is refused; the stop went ahead. */
export class StartInterrupted extends ServiceError {
  constructor() {
    super("conflict", "A stop ended the start before the server finished loading.", true);
  }
}

export function fifoPath(runtimeDir: string, id: string): string {
  return join(runtimeDir, `jass-mc-${id}.stdin`);
}

/** The marker a restart leaves while the server is down between its stop and its start. */
export function restartMarkerOf(markers: string, serverId: string): string {
  return join(markers, `${serverId}.restart`);
}

function sleepFor(deps: PowerDependencies): (ms: number, signal?: AbortSignal) => Promise<void> {
  return deps.sleep ?? ((ms: number, signal?: AbortSignal) => pause(ms, signal));
}

/** The part of a unit's state that identifies one running process. A later process has a different pid or start time. */
interface UnitIdentity {
  readonly mainPid: number | null;
  readonly activeSince: string | null;
}

function serverIs(current: ObservedState, expected: UnitIdentity): boolean {
  return current.known && current.state.activeState === "active" && current.state.mainPid === expected.mainPid && current.state.activeSince === expected.activeSince;
}

async function observe(deps: PowerDependencies, id: string): Promise<ObservedState> {
  const [state] = [...(await observeServers(deps.run, deps.readiness, [id])).values()];
  return state ?? { known: false, reason: "the state could not be read" };
}

/**
 * Tells the players that a planned stop or restart did not happen, after a warning for it went out. Only a server that is still running
 * and has loaded is told: before that Paper refuses the line, and a stopped one with an open socket would be woken by it.
 */
async function announceCancelled(deps: PowerDependencies, row: ServerRecord, action: "stop" | "restart"): Promise<void> {
  try {
    const state = await observe(deps, row.id);
    if (!state.known || state.state.activeState !== "active" || !state.state.loaded) return;
    sendCommand(fifoPath(deps.config.runtimeDir, row.id), `say The planned ${action} was cancelled.`);
  } catch {
    // Best effort: the failure the person needs to see is the one the action reports, not this notice.
  }
}

function requireServer(deps: PowerDependencies, id: string): ServerRecord {
  const row = getServer(deps.db, id);
  if (row === undefined) throw new ServiceError("not_found", "There is no such server.");
  return row;
}

/**
 * Starts the unit and waits for the server to report that it has loaded. Five minutes without that is "not_loaded": the unit is left
 * running. The deadline is measured on the monotonic clock, so a change to the wall clock cannot shorten or stretch the wait.
 */
async function startUnit(deps: PowerDependencies, row: ServerRecord): Promise<PowerOutcome> {
  // The window opens before the start, so the unit's own update step counts against the same five minutes the person was promised.
  const deadline = performance.now() + (deps.loadWindowMs ?? LOAD_WINDOW_MS);
  const service = serviceUnit(row.id);
  await deps.run(["systemctl", "--user", "reset-failed", "--", service]);
  const socket = await deps.run(["systemctl", "--user", "is-active", "--quiet", "--", socketUnit(row.id)]);
  const pipe = fifoPath(deps.config.runtimeDir, row.id);
  // Only an answer of "inactive" (exit 3) frees the pipe. Any other answer, including an unreadable one, leaves it alone.
  if (socket.code === 3 && existsSync(pipe)) rmSync(pipe, { force: true });
  const started = await deps.run(["systemctl", "--user", "start", "--", service], { timeoutMs: START_TIMEOUT_MS });
  if (started.code === null) {
    // A reply that never came does not show that the unit failed, and the unit may still come up. Its state is read once: loaded is done,
    // and anything else is unknown, so the person is not told that the start failed and invited to start it again.
    const after = await observe(deps, row.id);
    return after.known && after.state.loaded ? "done" : "unknown";
  }
  if (started.code !== 0) throw new ServiceError("conflict", "The server did not start. The journal has the reason.");
  return untilLoaded(deps, row.id, deadline, deps.locks.beginLoadWait(row.id));
}

/**
 * Gives up the wait because a stop ended it. The mark is set first, so the stop can record in its own audit row that it cut the start short.
 */
function interruptedWait(wait: LoadWait): never {
  wait.markCutShort();
  throw new StartInterrupted();
}

async function untilLoaded(deps: PowerDependencies, id: string, deadline: number, wait: LoadWait): Promise<PowerOutcome> {
  const sleep = sleepFor(deps);
  for (;;) {
    // The state is read before the wait is checked, so a server that the read shows as loaded is never reported as cut short, even when a
    // stop arrived while the read was made.
    const state = await observe(deps, id);
    if (state.known && state.state.loaded) return "done";
    if (wait.signal.aborted) {
      // A look at the journal can be a couple of seconds old, since a run that has not printed Done is not asked again straight away. The
      // journal is asked afresh before a stop may count as having cut the start short.
      deps.readiness.recheck(id);
      const fresh = await observe(deps, id);
      if (fresh.known && fresh.state.loaded) return "done";
      interruptedWait(wait);
    }
    // A unit that stopped while it was starting will never report that it has loaded. Unknown is not "stopped", so it keeps the wait going.
    if (state.known && !STARTING_STATES.has(state.state.activeState)) {
      throw new ServiceError("conflict", "The server stopped while it was starting. The journal has the reason.");
    }
    // A journal that could not be read at the deadline leaves whether the server loaded unknown, which is not the same as not loaded.
    // Not loaded needs both a known unit state and a journal that could be read. Either missing leaves the answer unknown.
    if (performance.now() >= deadline) return state.known && !deps.readiness.unreadable(id) ? "not_loaded" : "unknown";
    await sleep(deps.loadPollMs ?? LOAD_POLL_MS, wait.signal);
  }
}

// The socket is stopped in the same job: stopping the service alone can return while the socket still holds the FIFO open, and a
// write in that window would wake the server. Naming both units makes systemctl wait until neither is active.
async function stopUnit(deps: PowerDependencies, row: ServerRecord): Promise<void> {
  const stopped = await deps.run(["systemctl", "--user", "stop", "--", serviceUnit(row.id), socketUnit(row.id)], { timeoutMs: STOP_TIMEOUT_MS });
  if (stopped.code !== 0) throw new ServiceError("conflict", "The server did not stop cleanly; check its state.");
}

export async function powerAction(deps: PowerDependencies, id: string, action: PowerAction, actor: Actor, options: PowerOptions = {}): Promise<PowerResult> {
  const now = deps.now ?? (() => new Date());
  const row = requireServer(deps, id);
  const countdown = options.countdownSeconds ?? 0;
  if (countdown > 0 && action === "start") throw new ServiceError("invalid_request", "A start has no countdown.");
  let release = deps.locks.tryAcquire(id, action);
  let cutShort = false;
  // A stop without a warning may end a start or restart that is still waiting for its Done line, and nothing else. The lock passes to the
  // stop in the same step in which that operation releases it. A stop with a warning is refused while the server loads, so it never interrupts a wait.
  if (release === null && action === "stop" && countdown === 0) {
    const handed = await deps.locks.interruptLoadWait(id, action);
    if (handed !== null) {
      release = handed.release;
      cutShort = handed.cutShort;
    }
  }
  if (release === null) {
    throw new Busy(`Another operation (${deps.locks.holder(id) ?? "unknown"}) is already running on this server.`);
  }
  const actorFields = { userId: actor.id, userLabel: actor.label, serverId: id };
  const countdownFields = countdown > 0 ? { countdownSeconds: countdown } : undefined;
  const progress: CountdownProgress = { sent: 0, due: 0 };
  let stopBegun = false;
  let startBegun = false;
  let attached: Countdown | null = null;
  const progressFields = () => (countdownFields === undefined ? {} : { ...countdownFields, warningsSent: progress.sent, warningsDue: progress.due });
  // A cancelled countdown is an answer, not an error: the request says so, and the players are told nothing was stopped.
  const cancelledResult = async (cancelled: "stop" | "restart"): Promise<PowerResult> => {
    // The audit row names who cancelled: a scheduled countdown can be cancelled by someone other than the schedule.
    const by = attached?.cancelledBy ?? null;
    recordAudit(deps.db, { ...actorFields, action: `power.${cancelled}`, outcome: "cancelled", details: { ...progressFields(), ...(by === null ? {} : { cancelledBy: by }) } }, now());
    await announceCancelled(deps, row, cancelled);
    return { state: await observe(deps, id), outcome: "cancelled" };
  };
  try {
    recordAudit(deps.db, { ...actorFields, action: `power.${action}`, outcome: "started", ...(countdownFields === undefined ? {} : { details: countdownFields }) }, now());
    const before = await observe(deps, id);
    let outcome: PowerOutcome = "done";
    if (action === "start") {
      if (!before.known) throw new ServiceError("conflict", "The panel cannot read this server's state, so it will not start it.");
      if (before.state.activeState === "active" || before.state.activeState === "activating") {
        throw new ServiceError("conflict", "The server is already running.");
      }
      // The start command is issued inside startUnit, so a failure from there on is a failure of work that began, not a refusal.
      startBegun = true;
      outcome = await startUnit(deps, row);
    } else {
      if (countdown > 0) {
        if (!before.known || before.state.activeState !== "active") {
          throw new ServiceError("conflict", "The server is not running, so there is nothing to count down to.");
        }
        if (!before.state.loaded) throw new ServiceError("conflict", "The server is still loading, so a countdown cannot begin yet.");
        if (deps.stillHolds === undefined) {
          throw new ServiceError("conflict", "The panel cannot re-check the person who started the countdown, so the countdown is refused.");
        }
        const started = new Countdown(id, actor.id, action, options.scheduled === true, progress);
        attached = started;
        deps.locks.countdowns.attach(started);
        const ended = await countDown({
          pipe: fifoPath(deps.config.runtimeDir, id),
          log: join(row.directory, row.logPath),
          action,
          seconds: countdown,
          countdown: started,
          progress,
          sameProcess: async () => serverIs(await observe(deps, id), before.state),
          confirm: deps.confirmWarning !== false,
          ...(deps.warningEchoMs === undefined ? {} : { echoMs: deps.warningEchoMs }),
          sleep: sleepFor(deps),
          ...(options.signal === undefined ? {} : { daemonSignal: options.signal }),
        });
        if (ended === "cancelled") return await cancelledResult(action);
        // The person who began the countdown must still hold the capability when it ends. Unknown is refused, like a failed check. A cancel
        // that arrived during the check is the answer, whatever the check said.
        const holds = await deps.stillHolds(actor.id);
        if (!holds.holds) {
          if (started.cancelled) return await cancelledResult(action);
          throw new ServiceError("forbidden", `The countdown was not carried out, because the panel could not confirm that the person who began it still holds the power capability: ${holds.reason}. The server was not stopped.`);
        }
        // The server may have stopped or restarted on its own during the wait (an in-game stop, a crash restart). Acting on the state
        // seen before the wait would stop a process nobody warned, or start one an operator had stopped, so the state must match.
        if (!serverIs(await observe(deps, id), before.state)) {
          if (started.cancelled) return await cancelledResult(action);
          throw changedDuringCountdown();
        }
        // The stop begins here, after the last check and with no await in between. A cancel that arrived in the checks above wins.
        if (!started.beginStop()) return await cancelledResult(action);
      }
      // A restart leaves its marker while the server is down between its stop and its start, so a daemon that dies then can report it.
      if (action === "restart") {
        mkdirSync(deps.config.paths.markers, { recursive: true, mode: 0o700 });
        writeFileSync(restartMarkerOf(deps.config.paths.markers, id), `${now().toISOString()}\n`, { mode: 0o600 });
      }
      stopBegun = true;
      await stopUnit(deps, row);
      if (action === "restart") outcome = await startUnit(deps, row);
    }
    const after = await observe(deps, id);
    const details = {
      ...progressFields(),
      ...(outcome === "not_loaded" ? { loaded: false } : outcome === "unknown" ? { loaded: "unknown" } : {}),
      ...(cutShort ? { interruptedLoad: true } : {}),
    };
    recordAudit(deps.db, { ...actorFields, action: `power.${action}`, outcome: "ok", ...(Object.keys(details).length === 0 ? {} : { details }) }, now());
    return { state: after, outcome };
  } catch (error) {
    const denied = error instanceof ServiceError && error.code === "forbidden";
    const details = { ...progressFields(), ...(error instanceof StartInterrupted ? { interruptedLoad: true } : {}) };
    recordAudit(deps.db, { ...actorFields, action: `power.${action}`, outcome: denied ? "denied" : "failed", ...(Object.keys(details).length === 0 ? {} : { details }) }, now());
    // Players were warned, so they are told the planned action will not happen (only while the server is still running and not yet stopped).
    if (action !== "start" && progress.sent > 0 && !stopBegun) await announceCancelled(deps, row, action);
    // Work that had begun failed; it is not a refusal. A scheduled firing reports a failure, where it only records a refusal.
    const began = stopBegun || startBegun || attached !== null;
    if (began && !denied && error instanceof ServiceError && !error.began) throw new ServiceError(error.code, error.message, true);
    throw error;
  } finally {
    if (attached !== null) deps.locks.countdowns.detach(attached);
    try {
      // Work that began settles the marker when it ends, whether it succeeded or failed. A refusal before any work began leaves in place
      // whatever a daemon that died part way left behind, so a person can act on it.
      if (action !== "stop" && (startBegun || stopBegun)) rmSync(restartMarkerOf(deps.config.paths.markers, id), { force: true });
    } finally {
      release();
    }
  }
}

/**
 * Runs at start-up. A restart marker left behind means the panel stopped between a restart's stop and its start. A server that is running
 * needs nothing, so its marker goes. A server that is not running, or cannot be read, is returned for a person to act on; its marker stays
 * until a start clears it.
 */
export async function reconcileRestarts(deps: Pick<PowerDependencies, "db" | "config" | "run">): Promise<string[]> {
  const markers = deps.config.paths.markers;
  const stranded: string[] = [];
  if (!existsSync(markers)) return stranded;
  for (const name of readdirSync(markers)) {
    const match = /^(.+)\.restart$/.exec(name);
    if (match === null) continue;
    const serverId = match[1] ?? "";
    const file = join(markers, name);
    if (getServer(deps.db, serverId) === undefined) {
      rmSync(file, { force: true });
      continue;
    }
    const [state] = [...(await observeUnits(deps.run, [serverId])).values()];
    if (state !== undefined && state.known && STARTING_STATES.has(state.state.activeState)) {
      rmSync(file, { force: true });
      continue;
    }
    stranded.push(serverId);
  }
  return stranded;
}
