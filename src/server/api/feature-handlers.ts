// Handlers for files, backups, restores and scheduled actions. Each validates its body, goes through the file jail or the matching
// service, writes its audit row, and answers with the envelope. Path problems are reported with the jail's fixed messages, which never
// echo the path that was sent.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { recordAudit } from "../audit/audit.js";
import { authorize } from "../authz/authorize.js";
import type { PanelConfig } from "../config/config.js";
import { commandProblem } from "../console/fifo.js";
import type { PanelDatabase } from "../db/open.js";
import { keepHistory } from "../files/history.js";
import { FileTooLarge, JailError, listDirectory, readText, resolveInside, within, writeStream, writeText } from "../files/jail.js";
import { PANEL_ACCESS } from "../authz/capabilities.js";
import { folderState, readRestoreRecord, restoreJournalOf } from "../backups/restore-record.js";
import type { OperationLocks } from "../power/lock.js";
import type { Readiness } from "../power/readiness.js";
import type { SessionGate } from "../gate/session.js";
import { CAPABILITY_FOR, countdownPayload, SCHEDULE_KINDS, ScheduleError, type Scheduler } from "../schedules/scheduler.js";
import { getServer, type ServerRecord } from "../servers/store.js";
import { ServiceError } from "../servers/service.js";
import type { Runner } from "../systemd/run.js";
import type { AlertService } from "../alerts/alerts.js";
import { createBackup, leftoversOf, listBackups, restoreBackup, RestoreStranded, type BackupDependencies } from "../backups/backup.js";
import { listServers } from "../servers/store.js";
import type { PanelUser } from "../../shared/api.js";
import { UPLOAD_MAX_BYTES } from "../../shared/features.js";
import { SCHEDULE_COUNTDOWN_SECONDS } from "../../shared/servers.js";
import { sendData, sendError } from "./envelope.js";

export interface FeatureContext {
  readonly db: PanelDatabase;
  readonly config: PanelConfig;
  readonly run: Runner;
  readonly locks: OperationLocks;
  readonly scheduler: Scheduler;
  readonly zstd: boolean;
  readonly alerts: AlertService;
  readonly readiness: Readiness;
  readonly sessionGate: SessionGate;
  readonly now: () => Date;
}

export type FeatureHandler = (request: FastifyRequest, reply: FastifyReply) => unknown;

/** The route ids these handlers answer. The route table and the handler map are checked against each other where they meet. */
export type FeatureRouteId =
  | "files.list"
  | "files.read"
  | "files.write"
  | "files.upload"
  | "backups.list"
  | "backups.create"
  | "backups.restore"
  | "backups.leftovers"
  | "backups.leftover-remove"
  | "backups.restore-record-clear"
  | "schedules.list"
  | "schedules.add"
  | "schedules.remove";

const writeBody = z.strictObject({ path: z.string().min(1).max(1024), content: z.string().max(2 * 1024 * 1024) });
const pathQuery = z.strictObject({ path: z.string().max(1024).optional() });
const uploadQuery = z.strictObject({ path: z.string().min(1).max(1024) });
const scheduleBody = z.strictObject({
  kind: z.enum(SCHEDULE_KINDS),
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64),
  payload: z.string().max(1024).optional(),
  countdownSeconds: z.literal([...SCHEDULE_COUNTDOWN_SECONDS]).optional(),
});
const confirmBody = z.strictObject({ confirm: z.string().max(200) });

function principal(request: FastifyRequest): PanelUser {
  if (request.panelUser === undefined) throw new Error("the guard did not attach a signed-in person");
  return request.panelUser;
}

function isServer(value: ServerRecord | FastifyReply): value is ServerRecord {
  return !("send" in value);
}

/**
 * Whether an unsettled restore record may be cleared now. The folders are read on disk, never through the record: a record that cannot be
 * read names no folders at all. While the server folder is missing, folders from a restore must not be left with nothing to settle them.
 */
function clearableNow(row: ServerRecord): boolean {
  const folder = folderState(row.directory);
  return folder === "present" || (folder === "missing" && leftoversOf(row.directory).length === 0);
}

function restoreRecordOf(config: PanelConfig, row: ServerRecord) {
  const view = readRestoreRecord(config, row.id);
  return view === null ? null : { ...view, clearable: clearableNow(row) };
}

/** The answer for a write that did not start: a restore moves the folders, and a second write to the same file would race the first. */
function writeRefused(reply: FastifyReply, reason: "restore" | "busy"): FastifyReply {
  return reason === "restore"
    ? sendError(reply, "conflict", "A restore is running on this server.")
    : sendError(reply, "conflict", "That file is already being written. Wait for the save to finish, then try again.");
}

/** Uploads being received at once. Each is written to disk as it arrives, and the disk is shared with every server, so only two run. */
const MAX_UPLOADS = 2;
let uploadsRunning = 0;

/** The body of an octet-stream request, which the parser hands over as a stream of raw bytes. */
function isByteStream(body: unknown): body is AsyncIterable<Uint8Array> {
  return typeof body === "object" && body !== null && Symbol.asyncIterator in body;
}

/** The length the request declared, when it declared a valid one. An upload must declare one, so a file that cannot fit is refused before any byte is written. */
function declaredLength(request: FastifyRequest): number | undefined {
  const declared = request.headers["content-length"];
  if (declared === undefined) return undefined;
  const length = Number(declared);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

/**
 * The file is replaced only if the website, asked now, still names this person and they still hold the write capability. The request guard
 * checked both when the upload began, but the body can take minutes to arrive, and a person signed out or demoted in that time must not
 * still be able to replace a file. A session the website cannot confirm is refused, like one that is gone.
 */
async function requireFreshWrite(ctx: FeatureContext, request: FastifyRequest, user: PanelUser, serverId: string): Promise<void> {
  const cookie = request.headers.cookie;
  const answer = await ctx.sessionGate.lookup(Array.isArray(cookie) ? cookie.join("; ") : cookie, { fresh: true, channel: "request" });
  if (answer.kind !== "user" || answer.user.id !== user.id) {
    throw new ServiceError("forbidden", "The session could not be confirmed, so the file was not replaced.");
  }
  const principal = { id: answer.user.id, role: answer.user.role };
  if (!authorize(ctx.db, principal, PANEL_ACCESS) || !authorize(ctx.db, principal, "files.write", serverId)) {
    throw new ServiceError("forbidden", "Your account does not have permission for this.");
  }
}

/** Turns a known failure into its response, and rethrows anything unexpected so the error handler reports it. */
function mapFailure(reply: FastifyReply, error: unknown): FastifyReply {
  const mapped = jailError(reply, error) ?? serviceError(reply, error);
  if (mapped === null) throw error;
  return mapped;
}

function serverOf(ctx: FeatureContext, request: FastifyRequest, reply: FastifyReply): ServerRecord | FastifyReply {
  const id = (request.params as { serverId: string }).serverId;
  const row = getServer(ctx.db, id);
  if (row === undefined) return sendError(reply, "not_found", "There is no such server.");
  return row;
}

function jailError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof JailError) return sendError(reply, "invalid_request", error.message);
  return null;
}

function serviceError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof ServiceError) {
    return sendError(reply, error.code === "invalid_request" ? "invalid_request" : error.code === "not_found" ? "not_found" : error.code === "forbidden" ? "forbidden" : "conflict", error.message);
  }
  if (error instanceof ScheduleError) return sendError(reply, "invalid_request", error.message);
  return null;
}

function backupDeps(ctx: FeatureContext): BackupDependencies {
  return {
    db: ctx.db,
    config: ctx.config,
    run: ctx.run,
    locks: ctx.locks,
    now: ctx.now,
    zstd: ctx.zstd,
    readiness: ctx.readiness,
    onAutoSaveUnconfirmed: (serverId) => void ctx.alerts.raise("auto-save", serverId, "A backup finished, but the server did not confirm that auto-save is back on. The panel will try again when it next starts."),
  };
}

export function createFeatureHandlers(ctx: FeatureContext): Record<FeatureRouteId, FeatureHandler> {
  return {
    "files.list": (request, reply) => {
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      const query = pathQuery.safeParse(request.query);
      if (!query.success) return sendError(reply, "invalid_request", "The path is not valid.");
      try {
        return sendData(reply, listDirectory(row.directory, query.data.path ?? ""));
      } catch (error) {
        return mapFailure(reply, error);
      }
    },

    "files.read": (request, reply) => {
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      const query = pathQuery.safeParse(request.query);
      if (!query.success || query.data.path === undefined) return sendError(reply, "invalid_request", "A path is required.");
      try {
        return sendData(reply, { path: query.data.path, ...readText(row.directory, query.data.path) });
      } catch (error) {
        return mapFailure(reply, error);
      }
    },

    "files.write": async (request, reply) => {
      const user = principal(request);
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      const parsed = writeBody.safeParse(request.body);
      if (!parsed.success) return sendError(reply, "invalid_request", "The request body is not valid.");
      let target: string;
      try {
        target = resolveInside(row.directory, parsed.data.path, { allowMissing: true });
      } catch (error) {
        return mapFailure(reply, error);
      }
      const write = ctx.locks.beginWrite(row.id, target);
      if (!write.ok) return writeRefused(reply, write.reason);
      try {
        await writeText(row.directory, parsed.data.path, parsed.data.content, (previous) =>
          keepHistory(ctx.config.paths.fileHistory, row.id, parsed.data.path, previous, ctx.now()),
        );
      } catch (error) {
        recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "file.write", outcome: "failed", details: { path: parsed.data.path } }, ctx.now());
        return mapFailure(reply, error);
      } finally {
        write.end();
      }
      recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "file.write", outcome: "ok", details: { path: parsed.data.path, bytes: Buffer.byteLength(parsed.data.content, "utf8") } }, ctx.now());
      return sendData(reply, { saved: true });
    },

    "files.upload": async (request, reply) => {
      const user = principal(request);
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      const query = uploadQuery.safeParse(request.query);
      if (!query.success) return sendError(reply, "invalid_request", "A path is required.");
      // Anything but raw bytes arrives in another form, and only the octet-stream body is written.
      const body = request.body;
      if (!isByteStream(body)) return sendError(reply, "unsupported_media_type", "Send the file as application/octet-stream.");
      // The length is declared up front, so a file that cannot be stored is refused before any byte is written.
      const length = declaredLength(request);
      if (length === undefined) return sendError(reply, "invalid_request", "The upload must say how long the file is.");
      if (length > UPLOAD_MAX_BYTES) return sendError(reply, "payload_too_large", "The file is larger than the panel accepts.");
      if (uploadsRunning >= MAX_UPLOADS) return sendError(reply, "conflict", "Other uploads are running. Try again when one has finished.");
      let target: string;
      try {
        target = resolveInside(row.directory, query.data.path, { allowMissing: true });
      } catch (error) {
        return mapFailure(reply, error);
      }
      const write = ctx.locks.beginWrite(row.id, target);
      if (!write.ok) return writeRefused(reply, write.reason);
      uploadsRunning += 1;
      let bytes: number;
      try {
        bytes = await writeStream(row.directory, query.data.path, body, {
          maxBytes: UPLOAD_MAX_BYTES,
          expectedBytes: length,
          keepPrevious: (previous) => keepHistory(ctx.config.paths.fileHistory, row.id, query.data.path, previous, ctx.now()),
          // The body may have taken a long time to arrive, so the session and the permission are asked again before the file is replaced.
          beforeCommit: () => requireFreshWrite(ctx, request, user, row.id),
        });
      } catch (error) {
        recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "file.upload", outcome: "failed", details: { path: query.data.path } }, ctx.now());
        if (error instanceof FileTooLarge) return sendError(reply, "payload_too_large", "The file is larger than the panel accepts.");
        return mapFailure(reply, error);
      } finally {
        uploadsRunning -= 1;
        write.end();
      }
      recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "file.upload", outcome: "ok", details: { path: query.data.path, bytes } }, ctx.now());
      return sendData(reply, { saved: true });
    },

    "backups.list": (request, reply) => {
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      return sendData(reply, { backups: listBackups(ctx.db, row.id), restoreRecord: restoreRecordOf(ctx.config, row) });
    },

    "backups.create": async (request, reply) => {
      const user = principal(request);
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      try {
        const created = await createBackup(backupDeps(ctx), row.id, { id: user.id, label: user.email }, "manual");
        return sendData(reply, { backup: created }, 201);
      } catch (error) {
        if (error instanceof ServiceError && error.code === "conflict") {
          // A refused backup (a lock, no space, a server that will not confirm) is still worth an alert: the person asked and got nothing.
          void ctx.alerts.raise("backup-failed", row.id, `A backup of ${row.displayName} did not complete: ${error.message}`);
        }
        return mapFailure(reply, error);
      }
    },

    "backups.restore": async (request, reply) => {
      const user = principal(request);
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      const backupId = Number((request.params as { backupId: string }).backupId);
      if (!Number.isInteger(backupId)) return sendError(reply, "invalid_request", "The backup id is not valid.");
      try {
        await restoreBackup(backupDeps(ctx), row.id, backupId, { id: user.id, label: user.email });
        return sendData(reply, { restored: true });
      } catch (error) {
        // The previous folder is still moved aside, so the person is told at once, not only by the response.
        if (error instanceof RestoreStranded) void ctx.alerts.raise("restore-interrupted", row.id, `A restore of ${row.displayName} could not put its previous folder back. Move it back by hand.`);
        return mapFailure(reply, error);
      }
    },

    "backups.leftovers": (request, reply) => {
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      return sendData(reply, { leftovers: leftoversOf(row.directory) });
    },

    "backups.leftover-remove": async (request, reply) => {
      const user = principal(request);
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      const name = (request.params as { name: string }).name;
      const parsed = confirmBody.safeParse(request.body);
      if (!parsed.success || parsed.data.confirm !== name) {
        return sendError(reply, "confirmation_required", "Type the folder's name exactly to remove it.");
      }
      // A restore creates and moves these folders under the server's lock, so removal takes the same lock and cannot race one.
      const release = ctx.locks.tryAcquire(row.id, "leftover-remove");
      if (release === null) return sendError(reply, "conflict", `Another operation (${ctx.locks.holder(row.id) ?? "unknown"}) is running on this server.`);
      try {
        if (!leftoversOf(row.directory).includes(name)) return sendError(reply, "not_found", "There is no such leftover folder.");
        // An unsettled restore record names these folders, and the moved-aside one may be the only copy of the server.
        if (existsSync(restoreJournalOf(ctx.config, row.id))) return sendError(reply, "conflict", "A restore of this server has not settled, so its folders are kept.");
        const target = join(dirname(row.directory), name);
        // A folder that is a server's own, or that holds one, can share a leftover's shape (a server adopted from an earlier restore). Neither is removed here.
        if (listServers(ctx.db).some((server) => within(server.directory, target))) return sendError(reply, "conflict", "That folder holds a server's folder, so it is not removed here.");
        recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "backup.leftover-remove", outcome: "started", details: { name } }, ctx.now());
        try {
          await rm(target, { recursive: true, force: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? "unknown";
          recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "backup.leftover-remove", outcome: "failed", details: { name, code } }, ctx.now());
          return sendError(reply, "conflict", "The folder could not be removed completely, and it may be partly removed. Check it before anything else.");
        }
        recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "backup.leftover-remove", outcome: "ok", details: { name } }, ctx.now());
        return sendData(reply, { removed: name });
      } finally {
        release();
      }
    },

    "backups.restore-record-clear": async (request, reply) => {
      const user = principal(request);
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      const parsed = confirmBody.safeParse(request.body);
      if (!parsed.success || parsed.data.confirm !== row.displayName) {
        return sendError(reply, "confirmation_required", "Type the server's name exactly to clear its restore record.");
      }
      // Clearing takes the server's lock, so no restore, backup or removal can be settling the same folders at the same moment.
      const release = ctx.locks.tryAcquire(row.id, "restore-record");
      if (release === null) return sendError(reply, "conflict", `Another operation (${ctx.locks.holder(row.id) ?? "unknown"}) is running on this server.`);
      try {
        const file = restoreJournalOf(ctx.config, row.id);
        const view = readRestoreRecord(ctx.config, row.id);
        if (view === null) return sendError(reply, "not_found", "There is no restore record to clear.");
        // Checked on disk, so an unreadable record cannot lower the bar. The person moves the folders back first; the record is cleared after.
        if (!clearableNow(row)) {
          return sendError(reply, "conflict", "The server folder is missing, and folders from an earlier restore are still beside it. Move them back by hand, then clear the record.");
        }
        // The folders are never touched here: the record is only what stops a restore, and the folders stay as the person checked them.
        const folders = view.folders.map((folder) => folder.name);
        recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "backup.restore-record.clear", outcome: "started", details: { folders, unreadable: view.unreadable } }, ctx.now());
        try {
          await rm(file, { force: true });
        } catch (error) {
          const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
          recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "backup.restore-record.clear", outcome: "failed", details: { folders, unreadable: view.unreadable, code } }, ctx.now());
          return sendError(reply, "conflict", "The restore record could not be removed. Nothing else was changed.");
        }
        recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "backup.restore-record.clear", outcome: "ok", details: { folders, unreadable: view.unreadable } }, ctx.now());
        return sendData(reply, { cleared: true });
      } finally {
        release();
      }
    },

    "schedules.list": (request, reply) => {
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      return sendData(reply, { schedules: ctx.scheduler.list(row.id) });
    },

    "schedules.add": (request, reply) => {
      const user = principal(request);
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      const parsed = scheduleBody.safeParse(request.body);
      if (!parsed.success) return sendError(reply, "invalid_request", "The schedule is not valid.");
      const { kind, payload, countdownSeconds } = parsed.data;
      // Each kind takes exactly one of a command, a warning length or nothing, so a stored payload always means what its kind says.
      let stored: string | null = null;
      if (kind === "command") {
        if (payload === undefined) return sendError(reply, "invalid_request", "A command schedule needs the command to send.");
        if (commandProblem(payload) !== null) return sendError(reply, "invalid_request", "That command cannot be sent to the server.");
        if (countdownSeconds !== undefined) return sendError(reply, "invalid_request", "A command schedule takes no warning.");
        stored = payload;
      } else if (kind === "stop" || kind === "restart") {
        if (payload !== undefined) return sendError(reply, "invalid_request", "A stop or restart takes a warning length, not a command.");
        stored = countdownSeconds === undefined ? null : countdownPayload(countdownSeconds);
      } else if (payload !== undefined || countdownSeconds !== undefined) {
        return sendError(reply, "invalid_request", "This action takes no command and no warning.");
      }
      // A schedule is console access when it is a command, so its creator must hold the capability at the moment of making it.
      if (!authorize(ctx.db, { id: user.id, role: user.role }, CAPABILITY_FOR[kind], row.id)) {
        return sendError(reply, "forbidden", "Your account does not hold the capability this action needs.");
      }
      try {
        const created = ctx.scheduler.add({ serverId: row.id, kind, cron: parsed.data.cron, timezone: parsed.data.timezone, payload: stored, creatorId: user.id });
        recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "schedule.add", outcome: "ok", details: { kind, cron: parsed.data.cron, timezone: parsed.data.timezone, ...(countdownSeconds === undefined ? {} : { countdownSeconds }) } }, ctx.now());
        return sendData(reply, { schedule: created }, 201);
      } catch (error) {
        return mapFailure(reply, error);
      }
    },

    "schedules.remove": (request, reply) => {
      const user = principal(request);
      const row = serverOf(ctx, request, reply);
      if (!isServer(row)) return row;
      const scheduleId = Number((request.params as { scheduleId: string }).scheduleId);
      const owned = ctx.scheduler.list(row.id).some((schedule) => schedule.id === scheduleId);
      if (!owned) return sendError(reply, "not_found", "There is no such schedule on this server.");
      ctx.scheduler.remove(scheduleId);
      recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "schedule.remove", outcome: "ok", details: { id: scheduleId } }, ctx.now());
      return sendData(reply, { removed: scheduleId });
    },
  };
}

