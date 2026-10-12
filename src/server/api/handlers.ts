// The handlers behind each route in the table. Each one reads the signed-in person from the guard, validates its body with Zod, does
// its work through the services, and answers with the envelope. Errors from the services map to fixed statuses here, and an
// invalid body reports the paths and codes of the problems, never the values that were sent.
import { join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { recordAudit } from "../audit/audit.js";
import { authorize, decide, isOwnerOrOperator, loadGrants, type GrantRow } from "../authz/authorize.js";
import { SERVER_CAPABILITIES } from "../authz/capabilities.js";
import { PANEL_ACCESS, type Capability } from "../authz/capabilities.js";
import type { PanelConfig } from "../config/config.js";
import { classify } from "../console/classify.js";
import { commandProblem, sendCommand } from "../console/fifo.js";
import { LogTail, readHistory } from "../console/tail.js";
import type { PanelDatabase } from "../db/open.js";
import type { OperationLocks } from "../power/lock.js";
import { fifoPath, powerAction } from "../power/power.js";
import { observeServers, type Readiness } from "../power/readiness.js";
import { stillHolds } from "../authz/recheck.js";
import type { SessionGate } from "../gate/session.js";
import type { Runner } from "../systemd/run.js";
import type { ObservedState } from "../systemd/user.js";
import { addServerSchema } from "../servers/model.js";
import { addServer, removeServer, ServiceError } from "../servers/service.js";
import { getServer, listServers, type ServerRecord } from "../servers/store.js";
import { viewServers, type ServerView } from "../servers/state.js";
import { UnitRenderError } from "../servers/unit.js";
import { sendData, sendError } from "./envelope.js";
import { openEventStream, type StreamRegistry } from "./streams.js";
import type { PanelUser } from "../../shared/api.js";
import { cancelRequestSchema, powerRequestSchema, type countdownViewSchema } from "../../shared/servers.js";
import type { IdentityLookup } from "../gate/identity.js";
import type { AccountsLookup } from "../gate/accounts.js";
import { type PasswordLockout } from "../privileged/lockout.js";
import { auditFor } from "../audit/query.js";
import { grantBodySchema, GrantError, listGrants, listKnownUsers, revokeGrant, setGrant } from "../access/grants.js";
import { privilegedRun } from "./privileged-handlers.js";
import { healthReport } from "../health/health.js";
import { createFeatureHandlers, type FeatureRouteId } from "./feature-handlers.js";
import { createOpsHandlers, type OpsRouteId } from "./ops-handlers.js";
import type { AlertService } from "../alerts/alerts.js";
import type { Fetcher } from "../plugins/updater.js";
import type { Scheduler } from "../schedules/scheduler.js";
import type { RouteId } from "../authz/routes.js";

export interface ApiContext {
  readonly db: PanelDatabase;
  readonly config: PanelConfig;
  readonly run: Runner;
  readonly locks: OperationLocks;
  readonly sessionGate: SessionGate;
  readonly identity: IdentityLookup;
  readonly accounts: AccountsLookup;
  readonly readiness: Readiness;
  readonly streams: StreamRegistry;
  readonly sudo: string;
  readonly account: string;
  readonly lockout: PasswordLockout;
  readonly scheduler: Scheduler;
  readonly zstd: boolean;
  /** Aborted when the daemon is stopping; countdowns and open streams end with it. */
  readonly stopping?: AbortSignal;
  readonly alerts: AlertService;
  readonly fetcher: Fetcher;
  readonly now?: () => Date;
}

export type Handler = (request: FastifyRequest, reply: FastifyReply) => unknown;

const consoleBody = z.strictObject({ line: z.string().max(4096) });
/** A running countdown as a page is shown it. The starter is not in it; only the cancel decision is made from the starter. */
type CountdownWire = z.infer<typeof countdownViewSchema>;
type StreamSend = (event: string, data: unknown, id?: string) => void;
type ConsoleLine = ReturnType<LogTail["poll"]>[number];
/** A console stream's share of a log: the lines it has not yet sent, and how many it lost by falling this far behind. */
interface ConsoleWatcher {
  readonly pending: ConsoleLine[];
  lost: number;
}
interface ConsoleReader {
  readonly tail: LogTail;
  readonly watchers: Set<ConsoleWatcher>;
  readonly timer: ReturnType<typeof setInterval>;
}
/** The most lines a console stream may hold unsent. Beyond it the oldest are dropped, and the stream is told how many were lost. */
const CONSOLE_BACKLOG = 2000;
const HISTORY_LINES = 300;
const STREAM_TICK_MS = 1000;
const EVENTS_TICK_MS = 3000;

function principal(request: FastifyRequest): PanelUser {
  if (request.panelUser === undefined) throw new Error("the guard did not attach a signed-in person");
  return request.panelUser;
}

function actorOf(user: PanelUser): { id: string; label: string } {
  return { id: user.id, label: user.email };
}

function cookieOf(request: FastifyRequest): string | undefined {
  const value = request.headers.cookie;
  return Array.isArray(value) ? value.join("; ") : value;
}

function serverIdOf(request: FastifyRequest): string {
  return (request.params as { serverId: string }).serverId;
}

function stateJson(state: ObservedState) {
  if (!state.known) return { known: false as const, reason: state.reason };
  const { activeState, subState, result, execMainStatus, nRestarts, mainPid, activeSince, memoryBytes, loaded } = state.state;
  return { known: true as const, activeState, subState, result, execMainStatus, nRestarts, mainPid, activeSince, memoryBytes, loaded };
}

/** The server capabilities the person holds on one server, computed by the same check every route uses. */
/** A person's grant rows, read once for a request or a tick. An owner needs none, and an ADMIN's grants serve every server checked. */
function grantsOf(ctx: ApiContext, user: PanelUser): GrantRow[] {
  return user.role === "OWNER" ? [] : loadGrants(ctx.db, user.id);
}

/** Whether a person holds a capability on a server, decided from grants read by grantsOf. */
function allowed(user: PanelUser, grants: readonly GrantRow[], capability: Capability, serverId?: string): boolean {
  return decide({ id: user.id, role: user.role }, grants, capability, serverId);
}

function capabilitiesOf(user: PanelUser, grants: readonly GrantRow[], serverId: string): string[] {
  return SERVER_CAPABILITIES.filter((capability) => allowed(user, grants, capability, serverId));
}

/** The countdown running on a server, as this person may see it. Only its starter may cancel a countdown a person began, and power is always needed. */
function countdownOf(ctx: ApiContext, serverId: string, user: PanelUser, grants: readonly GrantRow[]): CountdownWire | null {
  const running = ctx.locks.countdowns.describe(serverId);
  if (running === null) return null;
  // A scheduled countdown may be cancelled by any holder of power; a person's own only by that person. Power is checked either way.
  const cancellable = (running.scheduled || running.starterId === user.id) && allowed(user, grants, "power", serverId);
  return { id: running.id, action: running.action, scheduled: running.scheduled, warningsSent: running.warningsSent, warningsDue: running.warningsDue, cancellable };
}

/** What a person may see of a server. The start command is not in it: changing that needs servers.manage. */
function publicView(view: ServerView, capabilities: readonly string[], countdown: CountdownWire | null) {
  return {
    capabilities,
    id: view.id,
    displayName: view.displayName,
    directory: view.directory,
    logPath: view.logPath,
    autostart: view.autostart,
    updateOnStart: view.updateOnStart,
    memory: view.memory,
    state: stateJson(view.state),
    lastEnd: view.lastEnd,
    unitEdited: view.unitEdited,
    countdown,
  };
}

function mapError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof ServiceError) {
    const code = error.code === "invalid_request" ? "invalid_request" : error.code === "not_found" ? "not_found" : error.code === "forbidden" ? "forbidden" : "conflict";
    return sendError(reply, code, error.message);
  }
  if (error instanceof UnitRenderError) return sendError(reply, "invalid_request", "The server settings cannot be written as a unit.");
  return null;
}

function invalidBody(reply: FastifyReply, issues: readonly z.core.$ZodIssue[]): FastifyReply {
  return sendError(reply, "invalid_request", "The request body is not valid.", {
    issues: issues.map((issue) => ({ path: issue.path.map(String).join("."), code: issue.code })),
  });
}

function requireServer(ctx: ApiContext, id: string, reply: FastifyReply): ServerRecord | null {
  const row = getServer(ctx.db, id);
  if (row === undefined) {
    sendError(reply, "not_found", "There is no such server.");
    return null;
  }
  return row;
}

async function viewOf(ctx: ApiContext, row: ServerRecord, user: PanelUser) {
  const [view] = await viewServers(ctx.run, ctx.config, [row], ctx.readiness);
  if (view === undefined) throw new Error("a view was not built for a server row");
  const grants = grantsOf(ctx, user);
  return publicView(view, capabilitiesOf(user, grants, row.id), countdownOf(ctx, row.id, user, grants));
}

function logFileOf(row: ServerRecord): string {
  return join(row.directory, row.logPath);
}

/** Opens a stream for a person and a capability, if the person may hold one more stream. */
function openStream(
  ctx: ApiContext,
  request: FastifyRequest,
  reply: FastifyReply,
  capability: Capability,
  serverId: string | undefined,
  options: { readonly intervalMs: number; readonly tick: (send: StreamSend, user: PanelUser) => void; readonly onClose?: () => void },
): FastifyReply {
  const first = principal(request);
  const release = ctx.streams.acquire(first.id);
  if (release === null) {
    options.onClose?.();
    return sendError(reply, "too_many_streams", "Close one of your open streams first.");
  }
  const cookie = cookieOf(request);
  // The person as the latest check saw them, so a change of role applies from the next check rather than from the next connection.
  let current = first;
  openEventStream(request, reply, release, {
    ...(ctx.stopping === undefined ? {} : { signal: ctx.stopping }),
    intervalMs: options.intervalMs,
    watch: (check) => ctx.streams.watch(first.id, check),
    ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
    tick: (send) => options.tick(send, current),
    reauthorize: async () => {
      const answer = await ctx.sessionGate.lookup(cookie, { fresh: true, channel: "stream" });
      // A session that now belongs to another person ends the stream, whatever that person may see.
      if (answer.kind !== "user" || answer.user.id !== first.id) return false;
      current = answer.user;
      // A removed server ends its streams even where a wildcard grant would still name it.
      if (serverId !== undefined && getServer(ctx.db, serverId) === undefined) return false;
      return authorize(ctx.db, { id: answer.user.id, role: answer.user.role }, capability, serverId);
    },
  });
  return reply;
}

export function createHandlers(ctx: ApiContext): Record<RouteId, Handler> {
  const now = ctx.now ?? (() => new Date());

  const ownerOnly = (reply: FastifyReply, user: PanelUser, action: string) => {
    recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: null, action: `denied.${action}`, outcome: "denied" }, now());
    return sendError(reply, "forbidden", "Only an owner or a panel operator can change access grants.");
  };

  // One log reader per server, shared by the console streams that watch it, so each line is read once however many streams are open. A
  // reader that is no longer watched is stopped, and the next stream to watch the log starts a new one from the end of the file.
  const readers = new Map<string, ConsoleReader>();
  const fanOut = (reader: ConsoleReader): void => {
    for (const line of reader.tail.poll()) {
      for (const watcher of reader.watchers) {
        if (watcher.pending.length >= CONSOLE_BACKLOG) {
          watcher.pending.shift();
          watcher.lost += 1;
        }
        watcher.pending.push(line);
      }
    }
  };
  const watchLog = (file: string, watcher: ConsoleWatcher): (() => void) => {
    let reader = readers.get(file);
    if (reader === undefined) {
      // Priming the tail now fixes the starting point at the moment the first stream opens: a line written after that is sent, and nothing before it.
      const tail = new LogTail(file, "end");
      tail.poll();
      // A read that throws is skipped, so an error inside a timer cannot end the daemon. The tail keeps its place and the next read goes on.
      const created: ConsoleReader = {
        tail,
        watchers: new Set(),
        timer: setInterval(() => {
          try {
            fanOut(created);
          } catch {
            // Skipped on purpose; see above.
          }
        }, STREAM_TICK_MS),
      };
      readers.set(file, created);
      reader = created;
    } else {
      // Lines already written are read before the newcomer joins, so it starts after them, and the streams already open keep them.
      fanOut(reader);
    }
    const joined = reader;
    joined.watchers.add(watcher);
    return () => {
      joined.watchers.delete(watcher);
      if (joined.watchers.size > 0) return;
      clearInterval(joined.timer);
      if (readers.get(file) === joined) readers.delete(file);
    };
  };

  const privileged = privilegedRun({ db: ctx.db, alerts: ctx.alerts, run: ctx.run, sudo: ctx.sudo, lockout: ctx.lockout, account: ctx.account, now });

  const features = createFeatureHandlers({ db: ctx.db, config: ctx.config, run: ctx.run, locks: ctx.locks, scheduler: ctx.scheduler, zstd: ctx.zstd, alerts: ctx.alerts, readiness: ctx.readiness, sessionGate: ctx.sessionGate, now });

  const core: Record<Exclude<RouteId, FeatureRouteId | OpsRouteId>, Handler> = {
    me: (request, reply) => sendData(reply, { user: principal(request), ownerOrOperator: isOwnerOrOperator(ctx.db, principal(request)) }),

    "health.get": async (_request, reply) => {
      const checks = await healthReport({ config: ctx.config, db: ctx.db, run: ctx.run, account: ctx.account });
      return sendData(reply, { checks });
    },

    "privileged.run": privileged,

    "audit.list": (request, reply) => {
      const user = principal(request);
      const limit = Math.min(200, Math.max(1, Number((request.query as { limit?: string }).limit ?? 100) || 100));
      return sendData(reply, { rows: auditFor(ctx.db, { id: user.id, role: user.role }, limit) });
    },

    // The website's accounts are listed for an owner or a panel operator, so an account that has never opened the panel can still be
    // granted. The website keeps its own account list to owners, so anyone else with access.manage sees the people this panel has seen.
    "access.list": async (request, reply) => {
      const user = principal(request);
      const grants = listGrants(ctx.db);
      const seen = listKnownUsers(ctx.db);
      if (!isOwnerOrOperator(ctx.db, user)) return sendData(reply, { grants, users: seen, usersFrom: "seen" });
      const cookie = typeof request.headers.cookie === "string" ? request.headers.cookie : undefined;
      const site = await ctx.accounts.list(cookie);
      // The website refused this session after the guard accepted it, which happens when a session ends inside the guard's short cache.
      if (site.kind === "refused") {
        return site.status === 401
          ? sendError(reply, "unauthenticated", "Sign in to the website first.")
          : sendError(reply, "no_access", "This account cannot access the server panel.");
      }
      if (site.kind === "unavailable") return sendData(reply, { grants, users: seen, usersFrom: "website-unavailable" });
      const lastSeen = new Map(seen.map((person) => [person.id, person.lastSeen]));
      const users = site.accounts.map((account) => ({ id: account.id, email: account.email, name: account.name, lastSeen: lastSeen.get(account.id) ?? null }));
      return sendData(reply, { grants, users, usersFrom: "website" });
    },

    "access.grant": (request, reply) => {
      const user = principal(request);
      if (!isOwnerOrOperator(ctx.db, user)) return ownerOnly(reply, user, "access.grant");
      const parsed = grantBodySchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      try {
        setGrant(ctx.db, parsed.data, actorOf(user), now());
      } catch (error) {
        if (error instanceof GrantError) return sendError(reply, "invalid_request", error.message);
        throw error;
      }
      ctx.streams.recheck(parsed.data.userId);
      return sendData(reply, { granted: true }, 201);
    },

    "access.revoke": (request, reply) => {
      const user = principal(request);
      if (!isOwnerOrOperator(ctx.db, user)) return ownerOnly(reply, user, "access.revoke");
      const parsed = grantBodySchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      const removed = revokeGrant(ctx.db, parsed.data, actorOf(user), now());
      if (!removed) return sendError(reply, "not_found", "That grant does not exist.");
      ctx.streams.recheck(parsed.data.userId);
      return sendData(reply, { revoked: true });
    },

    "servers.list": async (request, reply) => {
      const user = principal(request);
      const grants = grantsOf(ctx, user);
      const visible = listServers(ctx.db).filter((row) => allowed(user, grants, "server.view", row.id));
      const views = await viewServers(ctx.run, ctx.config, visible, ctx.readiness);
      return sendData(reply, { servers: views.map((view) => publicView(view, capabilitiesOf(user, grants, view.id), countdownOf(ctx, view.id, user, grants))) });
    },

    "servers.add": async (request, reply) => {
      const user = principal(request);
      const parsed = addServerSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      try {
        const row = await addServer({ db: ctx.db, config: ctx.config, run: ctx.run, now }, parsed.data, actorOf(user));
        return sendData(reply, { server: await viewOf(ctx, row, user) }, 201);
      } catch (error) {
        const mapped = mapError(reply, error);
        if (mapped !== null) return mapped;
        throw error;
      }
    },

    "servers.get": async (request, reply) => {
      const row = requireServer(ctx, serverIdOf(request), reply);
      if (row === null) return reply;
      return sendData(reply, { server: await viewOf(ctx, row, principal(request)) });
    },

    "servers.remove": async (request, reply) => {
      const user = principal(request);
      const id = serverIdOf(request);
      try {
        await removeServer({ db: ctx.db, config: ctx.config, run: ctx.run, locks: ctx.locks, now }, id, actorOf(user));
        ctx.streams.recheck();
        return sendData(reply, { id });
      } catch (error) {
        const mapped = mapError(reply, error);
        if (mapped !== null) return mapped;
        throw error;
      }
    },

    "servers.power": async (request, reply) => {
      const user = principal(request);
      const id = serverIdOf(request);
      const parsed = powerRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      const row = requireServer(ctx, id, reply);
      if (row === null) return reply;
      try {
        const countdown = parsed.data.countdownSeconds ?? 0;
        const result = await powerAction(
          { db: ctx.db, config: ctx.config, run: ctx.run, locks: ctx.locks, readiness: ctx.readiness, now, stillHolds: (userId) => stillHolds(ctx.identity, ctx.db, userId, "power", id) },
          id,
          parsed.data.action,
          actorOf(user),
          { countdownSeconds: countdown, ...(ctx.stopping === undefined ? {} : { signal: ctx.stopping }) },
        );
        return sendData(reply, { state: stateJson(result.state), outcome: result.outcome });
      } catch (error) {
        const mapped = mapError(reply, error);
        if (mapped !== null) return mapped;
        throw error;
      }
    },

    "servers.power-cancel": (request, reply) => {
      const user = principal(request);
      const id = serverIdOf(request);
      const parsed = cancelRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      const row = requireServer(ctx, id, reply);
      if (row === null) return reply;
      // The countdown is cancelled only by the person who started it, and only until its stop begins. The countdown's own request
      // answers "cancelled", so a cancel is never reported as a failure of the stop.
      const outcome = ctx.locks.countdowns.cancel(id, { id: user.id, label: user.email }, parsed.data.countdownId);
      if (outcome === "none") return sendError(reply, "conflict", "There is no countdown to cancel on this server.");
      if (outcome === "stale") return sendError(reply, "conflict", "That countdown has already ended. Nothing was cancelled.");
      if (outcome === "not_starter") return sendError(reply, "forbidden", "Only the person who started the countdown can cancel it.");
      if (outcome === "too_late") return sendError(reply, "conflict", "The stop has begun, so the countdown cannot be cancelled.");
      return sendData(reply, { cancelled: true });
    },

    "console.history": (request, reply) => {
      const row = requireServer(ctx, serverIdOf(request), reply);
      if (row === null) return reply;
      const lines = readHistory(logFileOf(row), HISTORY_LINES).map((line) => {
        const parsed = classify(line.text);
        return { id: line.id, text: line.text, cut: line.cut, kind: parsed.kind, player: parsed.player, time: parsed.time };
      });
      return sendData(reply, { lines });
    },

    "console.send": async (request, reply) => {
      const user = principal(request);
      const id = serverIdOf(request);
      const parsed = consoleBody.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      const row = requireServer(ctx, id, reply);
      if (row === null) return reply;
      const problem = commandProblem(parsed.data.line);
      if (problem !== null) return sendError(reply, "invalid_request", "That line cannot be sent to the server.", { problem });
      const [state] = [...(await observeServers(ctx.run, ctx.readiness, [id])).values()];
      if (state === undefined || !state.known || state.state.activeState !== "active") {
        return sendError(reply, "conflict", "The server is not running, so it is not taking input.");
      }
      // Paper refuses console input until it has printed Done, and a line sent before then can fail inside the server.
      if (!state.state.loaded) return sendError(reply, "conflict", "The server is still loading, so it is not taking input yet.");
      const fifo = fifoPath(ctx.config.runtimeDir, id);
      const outcome = sendCommand(fifo, parsed.data.line);
      // The audit row keeps the command's first word only: a command can carry a value a person would not want in a log.
      const verb = parsed.data.line.trim().split(/\s+/)[0] ?? "";
      recordAudit(
        ctx.db,
        {
          userId: user.id,
          userLabel: user.email,
          serverId: id,
          action: "console.send",
          outcome: outcome.delivered ? "ok" : "failed",
          details: { verb, bytes: Buffer.byteLength(parsed.data.line, "utf8") },
        },
        now(),
      );
      if (!outcome.delivered) return sendError(reply, "conflict", "The server is not accepting input right now.");
      return sendData(reply, { delivered: true });
    },

    "console.stream": (request, reply) => {
      const row = requireServer(ctx, serverIdOf(request), reply);
      if (row === null) return reply;
      const watcher: ConsoleWatcher = { pending: [], lost: 0 };
      return openStream(ctx, request, reply, "console.read", row.id, {
        intervalMs: STREAM_TICK_MS,
        tick: (send) => {
          if (watcher.lost > 0) {
            send("lagged", { lost: watcher.lost });
            watcher.lost = 0;
          }
          for (const line of watcher.pending.splice(0)) {
            const parsed = classify(line.text);
            send("line", { text: line.text, cut: line.cut, replay: line.replay, kind: parsed.kind, player: parsed.player, time: parsed.time }, line.id);
          }
        },
        onClose: watchLog(logFileOf(row), watcher),
      });
    },

    "events.stream": (request, reply) => {
      const last = new Map<string, string>();
      // One observation at a time: a slow systemctl or journal read must not stack the next tick on top of it.
      let observing = false;
      // An async body turns a synchronous failure, such as a database read, into a rejection, so the guard below is released on every path.
      const observeAll = async (send: StreamSend, user: PanelUser): Promise<void> => {
        const grants = grantsOf(ctx, user);
        const rows = listServers(ctx.db).filter((row) => allowed(user, grants, "server.view", row.id));
        // A server that is no longer visible is forgotten, so a later failed read cannot name it.
        const visible = new Set(rows.map((row) => row.id));
        for (const id of [...last.keys()]) if (!visible.has(id)) last.delete(id);
        const states = await observeServers(ctx.run, ctx.readiness, rows.map((row) => row.id));
        for (const row of rows) {
          const state = stateJson(states.get(row.id) ?? { known: false, reason: "not read" });
          const countdown = countdownOf(ctx, row.id, user, grants);
          const encoded = JSON.stringify({ state, countdown });
          if (last.get(row.id) === encoded) continue;
          last.set(row.id, encoded);
          send("state", { id: row.id, state, countdown });
        }
      };
      return openStream(ctx, request, reply, PANEL_ACCESS, undefined, {
        intervalMs: EVENTS_TICK_MS,
        tick: (send, user) => {
          if (observing) return;
          observing = true;
          observeAll(send, user)
            // A read that fails sends each server it had reported as unknown, so a page never keeps a state it may no longer hold. Nothing
            // here may end the stream, and the next good read sends the real states again because nothing is remembered for them.
            .catch(() => {
              for (const id of last.keys()) {
                last.delete(id);
                send("state", { id, state: stateJson({ known: false, reason: "the state could not be read just now" }), countdown: null });
              }
            })
            .finally(() => {
              observing = false;
            });
        },
      });
    },
  };

  const ops = createOpsHandlers({ db: ctx.db, config: ctx.config, run: ctx.run, locks: ctx.locks, readiness: ctx.readiness, alerts: ctx.alerts, fetcher: ctx.fetcher, now });

  return { ...core, ...features, ...ops };
}
