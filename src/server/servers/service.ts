// Adding and removing servers. Each is an external effect (unit files and systemd) plus a row, so the audit trail records a
// started row before the effect and an ok or failed row after it, and a failed attempt leaves no unit file behind. Removing a
// server never touches its directory: the world and the plugins are the operator's.
import { accessSync, constants, existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { recordAudit } from "../audit/audit.js";
import { restoreJournalOf } from "../backups/restore-record.js";
import { within } from "../files/jail.js";
import { isAbsolute } from "node:path";
import type { OperationLocks } from "../power/lock.js";
import type { PanelConfig } from "../config/config.js";
import type { PanelDatabase } from "../db/open.js";
import { parseShow, serviceUnit, socketUnit } from "../systemd/user.js";
import type { Runner } from "../systemd/run.js";
import { type AddServerInput, paperArgv, relativeLogPath } from "./model.js";
import { DriftError, ensureStopEvent, fileDigest, removeUnits, reloadManager, serviceFile, socketFile, writeNewUnits, type WrittenUnits } from "./files.js";
import { deleteServerRow, getServer, insertServer, listServers, type ServerRecord } from "./store.js";
import { loadedMarkerOf } from "../power/readiness.js";

/**
 * A refusal or a failure of a request. `began` is true when the operation had already changed something before it failed: such an error is
 * a failure to report, where an error without it is a refusal that a scheduled firing may simply record.
 */
export class ServiceError extends Error {
  constructor(
    readonly code: "invalid_request" | "conflict" | "not_found" | "forbidden",
    message: string,
    readonly began = false,
  ) {
    super(message);
  }
}

/** The server's operation lock is held by another operation. Nothing has begun, so a scheduled firing that meets one is skipped. */
export class Busy extends ServiceError {
  constructor(message: string) {
    super("conflict", message);
  }
}

export interface Actor {
  readonly id: string;
  readonly label: string;
}

export interface ServiceDependencies {
  readonly db: PanelDatabase;
  readonly config: PanelConfig;
  readonly run: Runner;
  /** When given, removal holds the server's operation lock, so a start cannot begin while its unit is being taken apart. */
  readonly locks?: OperationLocks;
  readonly now?: () => Date;
}

function realDirectory(path: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new ServiceError("invalid_request", "That directory does not exist.");
  }
  if (!statSync(real).isDirectory()) throw new ServiceError("invalid_request", "That path is not a directory.");
  return real;
}

function executable(path: string): void {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new ServiceError("invalid_request", `The Java program at ${path} does not exist or is not executable.`);
  }
}

/** Refuses a directory inside the panel's own data, or one another server already uses. */
export function checkDirectory(deps: ServiceDependencies, directory: string): string {
  const real = realDirectory(directory);
  const data = realpathSync(deps.config.dataDir);
  if (within(real, data)) {
    throw new ServiceError("invalid_request", "A server directory cannot be inside the panel's data directory.");
  }
  // A server folder that holds the data directory would let the server's own files replace the database and the start-up records.
  if (within(data, real)) {
    throw new ServiceError("invalid_request", "The panel's data directory cannot be inside a server directory.");
  }
  // A folder inside another server's folder, or holding one, is refused: removing or restoring either would move the other's files.
  for (const other of listServers(deps.db)) {
    if (within(real, other.directory) || within(other.directory, real)) throw new ServiceError("conflict", `That directory overlaps server ${other.id}'s directory.`);
  }
  return real;
}

// Adds run one at a time. The overlap check reads the rows, so a second add must not check until the first has written its row.
let addQueue: Promise<unknown> = Promise.resolve();

export function addServer(deps: ServiceDependencies, input: AddServerInput, actor: Actor): Promise<ServerRecord> {
  const next = addQueue.then(() => addServerUnlocked(deps, input, actor));
  addQueue = next.catch(() => undefined);
  return next;
}

async function addServerUnlocked(deps: ServiceDependencies, input: AddServerInput, actor: Actor): Promise<ServerRecord> {
  const now = deps.now ?? (() => new Date());
  if (getServer(deps.db, input.id) !== undefined) throw new ServiceError("conflict", `A server called ${input.id} already exists.`);
  if (!relativeLogPath(input.logPath)) {
    throw new ServiceError("invalid_request", "The log path must be relative and must not climb out of the server directory.");
  }
  const directory = checkDirectory(deps, input.directory);
  const argv = input.command.kind === "paper" ? paperArgv(input.command) : input.command.argv;
  const program = argv[0];
  if (program === undefined || !isAbsolute(program)) {
    throw new ServiceError("invalid_request", "The start command must begin with an absolute program path.");
  }
  if (input.command.kind === "paper") executable(input.command.javaPath);
  const memory = input.command.kind === "paper" ? { minMb: input.command.minMb, maxMb: input.command.maxMb } : null;
  const actorFields = { userId: actor.id, userLabel: actor.label, serverId: input.id };
  recordAudit(deps.db, { ...actorFields, action: "server.add", outcome: "started", details: { directory } }, now());

  ensureStopEvent(deps.config.paths);
  const units = { unitDir: deps.config.unitDir, paths: deps.config.paths };
  let written: WrittenUnits;
  try {
    written = writeNewUnits(units, { id: input.id, directory, startCommand: argv }, deps.config.dataDir);
  } catch (error) {
    // Nothing was written by this call, so nothing is removed here: an existing file is someone else's.
    recordAudit(deps.db, { ...actorFields, action: "server.add", outcome: "failed" }, now());
    throw error instanceof DriftError ? new ServiceError("conflict", error.message) : error;
  }
  let linked = false;
  try {
    await reloadManager(deps.run);
    // The unit is enabled when the choice is on and disabled when it is off. Disabling a unit that is not enabled changes nothing, but it
    // also removes a link that an earlier unit of the same id left behind, and that link would start the new unit at boot.
    const applied = await deps.run(["systemctl", "--user", input.autostart ? "enable" : "disable", "--", serviceUnit(input.id)]);
    if (applied.code !== 0) {
      throw new ServiceError("conflict", input.autostart ? "systemd would not enable the new unit." : "systemd would not disable the new unit.");
    }
    linked = input.autostart;
    return deps.db.transaction(() => {
      const stored = insertServer(
        deps.db,
        {
          id: input.id,
          displayName: input.displayName,
          directory,
          startCommand: argv,
          memory,
          logPath: input.logPath,
          autostart: input.autostart,
          updateOnStart: false,
          unitDigest: written.serviceDigest,
          socketDigest: written.socketDigest,
        },
        now().toISOString(),
      );
      recordAudit(deps.db, { ...actorFields, action: "server.add", outcome: "ok" }, now());
      return stored;
    })();
  } catch (error) {
    // An enabled unit is disabled before its files are removed, or its link to them is left behind.
    if (linked) await deps.run(["systemctl", "--user", "disable", "--", serviceUnit(input.id)]).catch(() => undefined);
    removeUnits(units, input.id);
    await reloadManager(deps.run).catch(() => undefined);
    recordAudit(deps.db, { ...actorFields, action: "server.add", outcome: "failed" }, now());
    throw error;
  }
}

/**
 * The active state systemd reports for one unit, or null when the answer cannot be read, which is unknown and never a reason to remove.
 * A unit systemd does not know any more is inactive: that is what a removal that already took its files away leaves behind.
 */
async function activeStateOf(run: Runner, unit: string): Promise<string | null> {
  const outcome = await run(["systemctl", "--user", "show", "--property=Id,ActiveState", "--", unit]);
  if (outcome.code !== 0) return null;
  return parseShow(outcome.stdout).get(unit)?.ActiveState ?? null;
}

function isDown(activeState: string): boolean {
  return activeState === "inactive" || activeState === "failed";
}

/** A unit file that is gone, or still holds what the panel wrote, may be taken away by a removal. Any other content was edited by hand. */
function unchangedOrGone(current: string | null, recorded: string | null): boolean {
  return current === null || current === recorded;
}

export async function removeServer(deps: ServiceDependencies, id: string, actor: Actor): Promise<void> {
  const locks = deps.locks;
  const release = locks === undefined ? () => undefined : locks.tryAcquire(id, "remove");
  if (release === null) throw new Busy(`Another operation (${locks?.holder(id) ?? "unknown"}) is running on this server.`);
  try {
    await removeServerLocked(deps, id, actor);
  } finally {
    release();
  }
}

/**
 * What a removal needs before it touches anything, and again before it deletes a file: no restore record is open, the service is down, the
 * socket is down when `socketMustBeDown` says it must be, and each unit file is absent or holds what the panel wrote. Unknown is refused.
 */
async function removalReadiness(
  deps: ServiceDependencies,
  id: string,
  row: ServerRecord,
  socketMustBeDown: boolean,
): Promise<{ readonly socket: string; readonly serviceDigest: string | null }> {
  // While a restore record exists, the folders it names are the only way back to the server's data. The row is kept until the record is settled.
  if (existsSync(restoreJournalOf(deps.config, id))) throw new ServiceError("conflict", "A restore of this server has not settled. Check its folders, then clear its restore record on the backups screen, before removing the server.");
  // Each unit is read by name, so a unit whose files an earlier removal already took away is still answered for.
  const service = await activeStateOf(deps.run, serviceUnit(id));
  const socket = await activeStateOf(deps.run, socketUnit(id));
  if (service === null || socket === null) {
    throw new ServiceError("conflict", "The panel cannot tell whether the server is running, so it will not remove it.");
  }
  if (!isDown(service)) throw new ServiceError("conflict", "Stop the server before removing it.");
  if (socketMustBeDown && !isDown(socket)) {
    throw new ServiceError("conflict", "The server's socket started again while it was being removed, so nothing was deleted.");
  }
  const units = { unitDir: deps.config.unitDir, paths: deps.config.paths };
  // A unit file that is already gone is what an earlier removal left behind before it failed, and that is not an edit by hand. A file that
  // is still present must match what the panel wrote, so the removal can be finished whichever part of it an earlier attempt completed.
  const serviceDigest = fileDigest(serviceFile(units.unitDir, id));
  const socketDigest = fileDigest(socketFile(units.unitDir, id));
  if (!unchangedOrGone(serviceDigest, row.unitDigest) || !unchangedOrGone(socketDigest, row.socketDigest)) {
    throw new ServiceError("conflict", "The unit files were edited by hand. Remove them yourself, then remove the server here.");
  }
  return { socket, serviceDigest };
}

async function removeServerLocked(deps: ServiceDependencies, id: string, actor: Actor): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const row = getServer(deps.db, id);
  if (row === undefined) throw new ServiceError("not_found", "There is no such server.");
  const units = { unitDir: deps.config.unitDir, paths: deps.config.paths };
  const actorFields = { userId: actor.id, userLabel: actor.label, serverId: id };
  recordAudit(deps.db, { ...actorFields, action: "server.remove", outcome: "started" }, now());
  try {
    const first = await removalReadiness(deps, id, row, false);
    // A socket that still listens holds the server's FIFO open, and a write to it would start the server again once its files are gone.
    // It is stopped here the same way a stop of the server stops it.
    if (!isDown(first.socket)) {
      const stopped = await deps.run(["systemctl", "--user", "stop", "--", socketUnit(id)]);
      if (stopped.code !== 0) throw new ServiceError("conflict", "systemd would not stop the server's socket, so the server was not removed.");
    }
    const disabled = await deps.run(["systemctl", "--user", "disable", "--", serviceUnit(id)]);
    // A service file that is already gone cannot be disabled, which an earlier removal leaves behind. A file that is present must disable,
    // and when it will not, nothing has been removed yet.
    if (disabled.code !== 0 && first.serviceDigest !== null) throw new ServiceError("conflict", "systemd would not disable the unit, so it was not removed.");
    // Stopping and disabling take time, and the server may have been started in that time. Nothing is deleted until the state is checked again.
    await removalReadiness(deps, id, row, true);
    removeUnits(units, id);
    await reloadManager(deps.run);
    // The grants name this server by id. They go with it, so a server added later under the same id starts with none.
    rmSync(loadedMarkerOf(deps.config.paths.markers, id), { force: true });
    deps.db.transaction(() => {
      const grants = deps.db.prepare("DELETE FROM grants WHERE server_id = ?").run(id).changes;
      deleteServerRow(deps.db, id);
      recordAudit(deps.db, { ...actorFields, action: "server.remove", outcome: "ok", details: { grantsRemoved: grants } }, now());
    })();
    // A start issued by hand between the last check and the deletion cannot be held off, since systemd is not the panel's to lock. The unit
    // is read once more, so a server running unmanaged after its record is gone is recorded for the person to stop by hand.
    if ((await deps.run(["systemctl", "--user", "is-active", "--quiet", "--", serviceUnit(id)])).code === 0) {
      recordAudit(deps.db, { ...actorFields, action: "server.remove.late-start", outcome: "failed" }, now());
    }
  } catch (error) {
    recordAudit(deps.db, { ...actorFields, action: "server.remove", outcome: "failed" }, now());
    throw error;
  }
}

