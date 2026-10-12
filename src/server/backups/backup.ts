// Backups and restores. A backup of a running server saves the world first: auto-save is turned off, the world is flushed, the
// archive is written, and auto-save is turned back on. Each save step is trusted only when the server's own log confirms it; a
// missing confirmation fails the backup, because unknown is not "saved". The marker written before save-off is removed only once
// save-on is confirmed, so a daemon that dies in the middle leaves a record that startup reconciles.
import { createHash } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { recordAudit } from "../audit/audit.js";
import type { PanelConfig } from "../config/config.js";
import type { PanelDatabase } from "../db/open.js";
import { sendCommand } from "../console/fifo.js";
import { LogTail } from "../console/tail.js";
import { classify } from "../console/classify.js";
import { fifoPath } from "../power/power.js";
import { observeServers, type Readiness } from "../power/readiness.js";
import type { OperationLocks } from "../power/lock.js";
import type { Runner } from "../systemd/run.js";
import { observeUnits } from "../systemd/user.js";
import { getServer, listServers, type ServerRecord } from "../servers/store.js";
import { within } from "../files/jail.js";
import { Busy, ServiceError, type Actor } from "../servers/service.js";
import { restoreJournalOf, restoreJournalSchema, writeRestoreRecord, type RestoreJournal } from "./restore-record.js";

export const MIN_FREE_BYTES = 1024 * 1024 * 1024;
// Room a restore keeps free beyond the archive's own size, for the record and the folder moves that come with it.
const RESTORE_RESERVE_BYTES = 256 * 1024 * 1024;
const DEFAULT_SAVE_FLUSH_MS = 180_000;
const DEFAULT_SAVE_TOGGLE_MS = 60_000;
const TAR_MS = 60 * 60_000;

export interface BackupDependencies {
  /** Called when auto-save was turned off and could not be confirmed back on. The restart reconciliation still tries again. */
  readonly onAutoSaveUnconfirmed?: (serverId: string) => void;
  readonly db: PanelDatabase;
  readonly config: PanelConfig;
  readonly run: Runner;
  readonly locks: OperationLocks;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly zstd?: boolean;
  /** Decides whether a running server has printed its Done line. The daemon's shared instance, so each server's Done line is read once. */
  readonly readiness: Readiness;
  /** How long to wait for the server's log to confirm each save step. Defaults are generous for a large world. */
  readonly timeouts?: { readonly toggleMs?: number; readonly flushMs?: number };
}

export interface BackupRow {
  readonly id: number;
  readonly serverId: string;
  readonly file: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly kind: "manual" | "scheduled";
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const toggleMs = (deps: BackupDependencies) => deps.timeouts?.toggleMs ?? DEFAULT_SAVE_TOGGLE_MS;
const flushMs = (deps: BackupDependencies) => deps.timeouts?.flushMs ?? DEFAULT_SAVE_FLUSH_MS;

export function backupDirOf(config: PanelConfig, serverId: string): string {
  return join(config.paths.backups, serverId);
}

export { restoreJournalOf, restoreJournalSchema, type RestoreJournal } from "./restore-record.js";

export function markerOf(config: PanelConfig, serverId: string): string {
  return join(config.paths.markers, `${serverId}.save-off`);
}

/** A file's sha256. The file is opened without following a link or waiting on a pipe, so a path swapped under the read cannot stall it or redirect it. */
export async function sha256File(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream() as AsyncIterable<Buffer>) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Sends one console command and waits for a log line that matches after the send. Returns false when no line matched in time. */
async function sendAndAwait(deps: BackupDependencies, serverId: string, command: string, pattern: RegExp, timeoutMs: number): Promise<boolean> {
  const sleep = deps.sleep ?? sleepDefault;
  const log = logPathOf(deps, serverId);
  // An unknown state is read again before the command is given up: a single failed read must not leave auto-save off until a restart.
  let running = await isRunning(deps, serverId);
  for (let attempt = 0; running === null && attempt < 3; attempt += 1) {
    await sleep(1000);
    running = await isRunning(deps, serverId);
  }
  if (running !== true) return false;
  const tail = new LogTail(log, "end");
  tail.poll();
  const outcome = sendCommand(fifoPath(deps.config.runtimeDir, serverId), command);
  if (!outcome.delivered) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of tail.poll()) {
      const parsed = classify(line.text);
      if (parsed.kind === "system" && pattern.test(parsed.text)) return true;
    }
    await sleep(250);
  }
  return false;
}

/**
 * Sends save-on and reports whether the server confirmed it. A failure to read the log is not a confirmation, and it must not escape the
 * caller, which still has to record the failure and keep the marker.
 */
async function confirmSaveOn(deps: BackupDependencies, serverId: string): Promise<boolean> {
  try {
    return await sendAndAwait(deps, serverId, "save-on", /^System chat: Automatic saving is now enabled$/, toggleMs(deps));
  } catch {
    return false;
  }
}

/** Whether a running server has printed its Done line. Unknown counts as not loaded. */
async function isLoaded(deps: BackupDependencies, serverId: string): Promise<boolean> {
  const seen = (await observeServers(deps.run, deps.readiness, [serverId])).get(serverId);
  return seen?.known === true && seen.state.loaded;
}

function logPathOf(deps: BackupDependencies, serverId: string): string {
  const row = getServer(deps.db, serverId);
  if (row === undefined) throw new ServiceError("not_found", "There is no such server.");
  return join(row.directory, row.logPath);
}

/** True for any state that is not already stopped (a unit still starting or stopping has a world the server is writing); null when unknown. */
async function isRunning(deps: BackupDependencies, serverId: string): Promise<boolean | null> {
  const [state] = [...(await observeUnits(deps.run, [serverId])).values()];
  if (state === undefined || !state.known) return null;
  return !(state.state.activeState === "inactive" || state.state.activeState === "failed");
}

function freeBytes(path: string): number {
  const space = statfsSync(path);
  return Number(space.bavail) * Number(space.bsize);
}

/** Makes a backup. Returns the recorded row, or throws ServiceError with the reason. The operation lock is held throughout. */
export async function createBackup(deps: BackupDependencies, serverId: string, actor: Actor, kind: "manual" | "scheduled"): Promise<BackupRow> {
  const now = deps.now ?? (() => new Date());
  const row: ServerRecord | undefined = getServer(deps.db, serverId);
  if (row === undefined) throw new ServiceError("not_found", "There is no such server.");
  const release = deps.locks.tryAcquire(serverId, "backup");
  if (release === null) throw new Busy(`Another operation (${deps.locks.holder(serverId) ?? "unknown"}) is running on this server.`);
  const actorFields = { userId: actor.id, userLabel: actor.label, serverId };
  let savedOff = false;
  try {
    recordAudit(deps.db, { ...actorFields, action: "backup.create", outcome: "started", details: { kind } }, now());
    const running = await isRunning(deps, serverId);
    if (running === null) throw new ServiceError("conflict", "The panel cannot tell whether the server is running, so it will not back it up.");
    // A server that has not printed Done takes no console input, so its save steps could never be confirmed. Refusing says why.
    if (running && !(await isLoaded(deps, serverId))) throw new ServiceError("conflict", "The server is still loading, so it cannot be backed up yet.");
    const backupDir = backupDirOf(deps.config, serverId);
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    if (freeBytes(backupDir) < MIN_FREE_BYTES) throw new ServiceError("conflict", "There is not enough free space for a backup.");

    if (running) {
      mkdirSync(deps.config.paths.markers, { recursive: true, mode: 0o700 });
      writeFileSync(markerOf(deps.config, serverId), `${now().toISOString()}\n`, { mode: 0o600 });
      // Once save-off has been attempted, save-on is owed whatever the outcome: the server may have acted on the command
      // even though its confirmation never arrived.
      savedOff = true;
      const off = await sendAndAwait(deps, serverId, "save-off", /^System chat: Automatic saving is now disabled$/, toggleMs(deps));
      if (!off) throw new ServiceError("conflict", "The server did not confirm that auto-save was turned off.");
      const flushed = await sendAndAwait(deps, serverId, "save-all flush", /^System chat: Saved the game$/, flushMs(deps));
      if (!flushed) throw new ServiceError("conflict", "The server did not confirm that the world was saved.");
    }

    const stamp = now().toISOString().replace(/[-:.]/g, "").replace(/Z$/, "Z");
    const extension = deps.zstd === false ? "tar.gz" : "tar.zst";
    const file = `${serverId}-${stamp}.${extension}`;
    const partial = join(backupDir, `.${file}.partial`);
    const flag = deps.zstd === false ? "-czf" : "--zstd";
    // The panel's own temporary files from a write that a kill cut short are not part of the world, so they stay out of the archive.
    const exclude = "--exclude=.jass-panel-*.partial";
    const tar = await deps.run(
      deps.zstd === false ? ["tar", "-C", row.directory, "-czf", partial, exclude, "."] : ["tar", "-C", row.directory, flag, "-cf", partial, exclude, "."],
      { timeoutMs: TAR_MS },
    );
    if (tar.code !== 0) {
      rmSync(partial, { force: true });
      throw new ServiceError("conflict", "The archive could not be written.");
    }
    renameSync(partial, join(backupDir, file));
    const size = statSync(join(backupDir, file)).size;
    const sha = await sha256File(join(backupDir, file));
    const id = deps.db.transaction(() => {
      const inserted = deps.db
        .prepare("INSERT INTO backups (server_id, file, size_bytes, sha256, created_at, creator_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(serverId, file, size, sha, now().toISOString(), actor.id, kind);
      recordAudit(deps.db, { ...actorFields, action: "backup.create", outcome: "ok", details: { file, bytes: size } }, now());
      return Number(inserted.lastInsertRowid);
    })();
    pruneBackups(deps, serverId);
    return { id, serverId, file, sizeBytes: size, sha256: sha, createdAt: now().toISOString(), kind };
  } catch (error) {
    // The reason is a fixed sentence from a refusal, which is safe to keep; anything else is recorded by its name only.
    const reason = error instanceof ServiceError ? error.message : `unexpected error (${error instanceof Error ? error.name : "unknown"})`;
    recordAudit(deps.db, { ...actorFields, action: "backup.create", outcome: "failed", details: { reason } }, now());
    throw error;
  } finally {
    try {
      if (savedOff) {
        const on = await confirmSaveOn(deps, serverId);
        if (on) {
          rmSync(markerOf(deps.config, serverId), { force: true });
        } else {
          // The marker stays, so the next start sends save-on again and reports it if it still cannot be confirmed.
          recordAudit(deps.db, { ...actorFields, action: "backup.save-on", outcome: "failed", details: { reason: "auto-save was not confirmed on" } }, now());
          deps.onAutoSaveUnconfirmed?.(serverId);
        }
      }
    } finally {
      release();
    }
  }
}

/** Keeps the newest `keep` successful backups. Runs only after a new backup has succeeded. */
export function pruneBackups(deps: BackupDependencies, serverId: string, keep = retentionOf(deps.db)): void {
  const rows = deps.db
    .prepare("SELECT id, file FROM backups WHERE server_id = ? ORDER BY id DESC")
    .all(serverId) as { id: number; file: string }[];
  for (const old of rows.slice(keep)) {
    rmSync(join(backupDirOf(deps.config, serverId), basename(old.file)), { force: true });
    deps.db.prepare("DELETE FROM backups WHERE id = ?").run(old.id);
  }
}

export function retentionOf(db: PanelDatabase): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'backup_retention'").get() as { value: string } | undefined;
  const parsed = Number(row?.value ?? 7);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 7;
}

export function listBackups(db: PanelDatabase, serverId: string): BackupRow[] {
  return (db
    .prepare("SELECT id, server_id AS serverId, file, size_bytes AS sizeBytes, sha256, created_at AS createdAt, kind FROM backups WHERE server_id = ? ORDER BY id DESC")
    .all(serverId) as BackupRow[]);
}

/** Refuses an archive whose listing names an absolute path, a parent reference, or a link. */
export function checkMembers(names: readonly string[], typeLetters: readonly string[]): string | null {
  for (const name of names) {
    if (name.startsWith("/") || name.split("/").includes("..")) return "the archive contains an absolute or parent path";
  }
  if (typeLetters.some((letter) => letter === "l" || letter === "h")) return "the archive contains a link";
  return null;
}

const LISTING_MAX_BYTES = 128 * 1024 * 1024;

/**
 * The bytes a restore writes: the size of every member in a verbose listing. A line whose size cannot be read is refused, since a total
 * that leaves a member out could let a restore run the disk full.
 */
export function archiveBytes(verboseLines: readonly string[]): number {
  let total = 0;
  for (const line of verboseLines) {
    const match = /^\S+\s+\S+\s+(\d+)\s/.exec(line);
    if (match === null) throw new ServiceError("conflict", "The archive could not be sized, so it was not restored.");
    total += Number(match[1]);
  }
  return total;
}

/** Lists an archive's members and their type letters. A listing that failed or was cut short is no listing at all, so nothing is restored from it. */
async function listArchive(deps: BackupDependencies, archive: string): Promise<{ names: string[]; types: string[]; bytes: number }> {
  const options = { timeoutMs: TAR_MS, maxOutputBytes: LISTING_MAX_BYTES };
  const names = await deps.run(["tar", "-tf", archive], options);
  const verbose = await deps.run(["tar", "-tvf", archive], options);
  for (const result of [names, verbose]) {
    if (result.code !== 0 || result.signal !== null) throw new ServiceError("conflict", "The archive could not be listed in full, so it was not restored.");
  }
  const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);
  return { names: lines(names.stdout), types: lines(verbose.stdout).map((line) => line.charAt(0)), bytes: archiveBytes(lines(verbose.stdout)) };
}

/** A restore that stopped with the previous folder still moved aside. The record stays, and the person is alerted. */
export class RestoreStranded extends ServiceError {}

export async function restoreBackup(deps: BackupDependencies, serverId: string, backupId: number, actor: Actor): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const row = getServer(deps.db, serverId);
  if (row === undefined) throw new ServiceError("not_found", "There is no such server.");
  const backup = deps.db.prepare("SELECT file, sha256 FROM backups WHERE id = ? AND server_id = ?").get(backupId, serverId) as
    | { file: string; sha256: string }
    | undefined;
  if (backup === undefined) throw new ServiceError("not_found", "There is no such backup.");
  const release = deps.locks.tryAcquire(serverId, "restore");
  if (release === null) throw new Busy(`Another operation (${deps.locks.holder(serverId) ?? "unknown"}) is running on this server.`);
  // A file being written is writing into the folder a restore is about to move, so the restore waits for it to finish.
  if (deps.locks.writesRunning(serverId)) {
    release();
    throw new ServiceError("conflict", "A file is being written on this server. Try the restore again when the write has finished.");
  }
  const actorFields = { userId: actor.id, userLabel: actor.label, serverId };
  try {
    recordAudit(deps.db, { ...actorFields, action: "backup.restore", outcome: "started", details: { file: backup.file } }, now());
    const running = await isRunning(deps, serverId);
    if (running !== false) throw new ServiceError("conflict", "Stop the server before restoring it.");
    const archive = join(backupDirOf(deps.config, serverId), basename(backup.file));
    if (!existsSync(archive)) throw new ServiceError("conflict", "The archive is missing from the backup folder.");
    if ((await sha256File(archive)) !== backup.sha256) throw new ServiceError("conflict", "The archive does not match its recorded checksum.");
    const listing = await listArchive(deps, archive);
    const refusal = checkMembers(listing.names, listing.types);
    if (refusal !== null) throw new ServiceError("conflict", `The restore was refused: ${refusal}.`);

    const parent = dirname(row.directory);
    const name = basename(row.directory);
    const stamp = now().toISOString().replace(/[-:.]/g, "");
    const journal: RestoreJournal = {
      directory: row.directory,
      staging: join(parent, `.${name}.restore-${stamp}`),
      aside: join(parent, `${name}.before-restore-${stamp}`),
      startedAt: now().toISOString(),
    };
    const journalFile = restoreJournalOf(deps.config, serverId);
    if (existsSync(journalFile)) throw new ServiceError("conflict", "An earlier restore of this server left a record that start-up could not settle. Check the server's folders, then clear its restore record on the backups screen to allow a restore.");
    if (freeBytes(parent) < listing.bytes + RESTORE_RESERVE_BYTES) throw new ServiceError("conflict", "There is not enough free space to restore this server. The archive is larger than the room left on the disk.");
    // Moving this folder aside would move another server's folder inside it, so the restore is refused.
    if (listServers(deps.db).some((other) => other.id !== serverId && within(other.directory, row.directory))) {
      throw new ServiceError("conflict", "Another server's folder is inside this one, so restoring would move it.");
    }
    let keepJournal = false;
    try {
      // The record is written before the first folder moves, so a death part way through leaves something start-up can act on.
      mkdirSync(deps.config.paths.markers, { recursive: true, mode: 0o700 });
      writeRestoreRecord(journalFile, `${JSON.stringify(restoreJournalSchema.parse(journal))}\n`);
      mkdirSync(journal.staging, { mode: 0o700 });
      const extracted = await deps.run(["tar", "-xf", archive, "-C", journal.staging, "--no-same-owner"], { timeoutMs: TAR_MS });
      if (extracted.code !== 0) {
        rmSync(journal.staging, { recursive: true, force: true });
        throw new ServiceError("conflict", "The archive could not be extracted.");
      }
      // Nothing is deleted: the current folder is renamed aside, and the restored tree takes its place. A folder that is already gone
      // has nothing to move aside, so the restored tree simply takes its place.
      // The server was checked before the archive was read, which takes a while. A unit started since then must not have its folder moved.
      if ((await isRunning(deps, serverId)) !== false) throw new ServiceError("conflict", "The server started while the restore was being prepared, so it was not restored.");
      // Something already at the path the previous folder is moved to (a link, say) is never moved over or into, so the restore is refused.
      if (lstatSync(journal.aside, { throwIfNoEntry: false }) !== undefined) throw new ServiceError("conflict", "Something already sits where the previous folder would be moved, so the restore was refused.");
      const hadFolder = existsSync(row.directory);
      if (hadFolder) renameSync(row.directory, journal.aside);
      try {
        renameSync(journal.staging, row.directory);
      } catch (error) {
        if (hadFolder) {
          try {
            renameSync(journal.aside, row.directory);
          } catch {
            // The folder is still aside and the record stays, so the next start puts it back.
            keepJournal = true;
            throw new RestoreStranded("conflict", "The restore failed and the previous folder could not be put back. The panel will put it back when it next starts.");
          }
        }
        throw error;
      }
      recordAudit(deps.db, { ...actorFields, action: "backup.restore", outcome: "ok", details: { file: backup.file } }, now());
    } finally {
      if (!keepJournal) rmSync(journalFile, { force: true });
      // A staging folder that was never moved into place is only a copy of the archive, so it goes on every exit path.
      rmSync(journal.staging, { recursive: true, force: true });
    }
  } catch (error) {
    recordAudit(deps.db, { ...actorFields, action: "backup.restore", outcome: "failed" }, now());
    throw error;
  } finally {
    release();
  }
}

/** Leftover folders from earlier restores (moved aside, or a staging folder a restore never put in place), listed so they can be removed on purpose. */
const RESTORE_STAMP = "\\d{8}T\\d{9}Z";

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The folder a restore moved the previous server folder into. Only that exact shape counts as a leftover. */
export function isAsideFolder(name: string, entry: string): boolean {
  return new RegExp(`^${escapeForPattern(name)}\\.before-restore-${RESTORE_STAMP}$`).test(entry);
}

/** The folder a restore extracts into before it moves anything. */
export function isStagingFolder(name: string, entry: string): boolean {
  return new RegExp(`^\\.${escapeForPattern(name)}\\.restore-${RESTORE_STAMP}$`).test(entry);
}

export function leftoversOf(directory: string): string[] {
  const parent = dirname(directory);
  const name = basename(directory);
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .filter((entry) => isAsideFolder(name, entry) || isStagingFolder(name, entry))
    .sort();
}

/**
 * Runs at start-up and again while the panel runs, so auto-save is not left off until the next start. A marker left behind means a backup was stopped between save-off and save-on. A running server gets save-on
 * again and the marker goes only when that is confirmed; a server that is not running needs no save state, so the marker goes.
 * Returns the ids whose save-on could not be confirmed, so the caller can raise an alert for each.
 */
export async function reconcileMarkers(deps: BackupDependencies): Promise<string[]> {
  const now = deps.now ?? (() => new Date());
  const unconfirmed: string[] = [];
  if (!existsSync(deps.config.paths.markers)) return unconfirmed;
  for (const name of readdirSync(deps.config.paths.markers)) {
    const match = /^(.+)\.save-off$/.exec(name);
    if (match === null) continue;
    const serverId = match[1] ?? "";
    const row = getServer(deps.db, serverId);
    if (row === undefined) {
      rmSync(join(deps.config.paths.markers, name), { force: true });
      continue;
    }
    // A backup that is running owns the server's save state and settles it itself, so this pass leaves that server alone.
    const release = deps.locks.tryAcquire(serverId, "save-on");
    if (release === null) continue;
    try {
      const running = await isRunning(deps, serverId);
      if (running === null) {
        // Unknown is not "not running": the marker stays so the next pass tries again, and the failure is recorded and reported.
        unconfirmed.push(serverId);
        recordAudit(deps.db, { userId: null, userLabel: "panel reconcile", serverId, action: "backup.reconcile", outcome: "failed", details: { reason: "the server state could not be read" } }, now());
        continue;
      }
      if (running === false) {
        rmSync(join(deps.config.paths.markers, name), { force: true });
        recordAudit(deps.db, { userId: null, userLabel: "panel reconcile", serverId, action: "backup.reconcile", outcome: "ok", details: { reason: "the server was not running" } }, now());
        continue;
      }
      // A server that has not printed Done takes no console input yet, so a later pass sends its save-on once it has loaded.
      if (!(await isLoaded(deps, serverId))) continue;
      if (await confirmSaveOn(deps, serverId)) {
        rmSync(join(deps.config.paths.markers, name), { force: true });
        recordAudit(deps.db, { userId: null, userLabel: "panel reconcile", serverId, action: "backup.reconcile", outcome: "ok", details: { reason: "auto-save restored" } }, now());
      } else {
        unconfirmed.push(serverId);
        recordAudit(deps.db, { userId: null, userLabel: "panel reconcile", serverId, action: "backup.reconcile", outcome: "failed", details: { reason: "auto-save was not confirmed" } }, now());
      }
    } finally {
      release();
    }
  }
  return unconfirmed;
}

export interface RestoreProblem {
  readonly serverId: string;
  readonly message: string;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Runs at start-up, after the save markers. A restore record left behind means a restore stopped part way through moving folders.
 * A server folder still in place needs nothing moved, so the record goes and any restore folder beside it is a leftover for the person
 * to remove. A folder that moved aside with nothing in its place is put back, because the folder as it was is the state to return to.
 * A record that does not match the server, and a folder missing with nothing to put back, are reported and no folder is touched.
 * Returns the problems, so the caller can raise an alert for each.
 */
export function reconcileRestores(deps: { readonly db: PanelDatabase; readonly config: PanelConfig; readonly now?: () => Date }): RestoreProblem[] {
  const now = deps.now ?? (() => new Date());
  const problems: RestoreProblem[] = [];
  const folder = deps.config.paths.markers;
  if (!existsSync(folder)) return problems;
  for (const entry of readdirSync(folder)) {
    const match = /^(.+)\.restore$/.exec(entry);
    if (match === null) continue;
    const serverId = match[1] ?? "";
    const file = join(folder, entry);
    const row = getServer(deps.db, serverId);
    const parsed = restoreJournalSchema.safeParse(readJsonFile(file));
    const record = (outcome: "ok" | "failed", reason: string) =>
      recordAudit(deps.db, { userId: null, userLabel: "panel start-up", serverId, action: "backup.reconcile", outcome, details: { reason: `restore: ${reason}` } }, now());
    const matches =
      row !== undefined &&
      parsed.success &&
      parsed.data.directory === row.directory &&
      dirname(parsed.data.staging) === dirname(row.directory) &&
      dirname(parsed.data.aside) === dirname(row.directory) &&
      isAsideFolder(basename(row.directory), basename(parsed.data.aside)) &&
      isStagingFolder(basename(row.directory), basename(parsed.data.staging));
    if (!matches || !parsed.success) {
      record("failed", "the record does not match the server");
      problems.push({ serverId, message: `An interrupted restore of ${serverId} left a record that does not match the server. Check its folders by hand before restoring again.` });
      continue;
    }
    const journal = parsed.data;
    if (existsSync(journal.directory)) {
      rmSync(file, { force: true });
      // A staging folder still present means the archive never reached the server folder. Without one, the restored tree was moved into place
      // and only the record was left behind by a death before its removal.
      if (existsSync(journal.staging)) {
        record("failed", "the restore did not complete; the server folder is unchanged");
        problems.push({ serverId, message: `A restore of ${serverId} did not complete. The server folder is unchanged; the unfinished copy is listed under leftovers.` });
      } else if (existsSync(journal.aside)) {
        record("ok", "the restored folder is in place; the previous folder is listed under leftovers");
        problems.push({ serverId, message: `A restore of ${serverId} completed, but the panel stopped before it recorded that. The restored folder is in place.` });
      } else {
        // Nothing left beside the folder: the record shows no move, so the outcome is not known.
        record("failed", "the outcome of the restore is not known; the server folder is in place");
        problems.push({ serverId, message: `A restore of ${serverId} was interrupted and the record does not show how far it got. The server folder is in place; check it before restoring again.` });
      }
      continue;
    }
    if (existsSync(journal.aside)) {
      // Only a folder the restore moved is put back. A link or file at that path stays where it is, for a person to move.
      if (lstatSync(journal.aside, { throwIfNoEntry: false })?.isDirectory() !== true) {
        record("failed", "the previous folder is not a directory, so it was not put back");
        problems.push({ serverId, message: `A restore of ${serverId} was interrupted, and the path that held its previous folder is not a folder. Nothing was moved; check it by hand.` });
        continue;
      }
      try {
        renameSync(journal.aside, journal.directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "unknown";
        record("failed", `the previous folder could not be put back (${code})`);
        problems.push({ serverId, message: `A restore of ${serverId} was interrupted and its previous folder could not be put back. Move it back by hand.` });
        continue;
      }
      rmSync(file, { force: true });
      record("ok", "the previous folder was put back");
      problems.push({ serverId, message: `A restore of ${serverId} was interrupted. The previous server folder has been put back.` });
      continue;
    }
    rmSync(file, { force: true });
    record("failed", "the server folder is missing");
    problems.push({ serverId, message: `A restore of ${serverId} was interrupted and its server folder is missing. Restore the server again, or move its folder back by hand.` });
  }
  return problems;
}
