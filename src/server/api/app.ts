// The HTTP application. Three checks run for every request, in this order: the Host must be the public host or loopback (a
// DNS-rebinding guard); a mutating request must carry the panel's own header and the panel's Origin (a cross-site form cannot
// set either); and each API route runs the identity gate and then `authorize` with the capability the route table declares.
// Handlers are looked up by route id, so a route in the table without a handler does not compile.
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { PanelDatabase } from "../db/open.js";
import type { PanelConfig } from "../config/config.js";
import { isAllowedHost } from "../config/config.js";
import { authorize } from "../authz/authorize.js";
import { PANEL_ACCESS } from "../authz/capabilities.js";
import { ROUTES, type RouteSpec } from "../authz/routes.js";
import { OperationLocks } from "../power/lock.js";
import { Readiness } from "../power/readiness.js";
import { runProcess, type Runner } from "../systemd/run.js";
import { createHandlers, type Handler } from "./handlers.js";
import { SECURITY_HEADERS } from "./headers.js";
import { StreamRegistry } from "./streams.js";
import { PasswordLockout } from "../privileged/lockout.js";
import { recordAudit } from "../audit/audit.js";
import { touchKnownUser } from "../access/grants.js";
import { getServer } from "../servers/store.js";
import { userInfo } from "node:os";
import { createIdentityLookup, type IdentityLookup } from "../gate/identity.js";
import { createAccountsLookup, type AccountsLookup } from "../gate/accounts.js";
import { createScheduler, type Scheduler } from "../schedules/scheduler.js";
import { createAlerts, type AlertService } from "../alerts/alerts.js";
import type { Fetcher } from "../plugins/updater.js";
import type { SessionGate } from "../gate/session.js";
import type { PanelUser } from "../../shared/api.js";
import { readStatic } from "./static.js";
import { sendError } from "./envelope.js";
import { UPLOAD_MAX_BYTES } from "../../shared/features.js";

declare module "fastify" {
  interface FastifyRequest {
    panelUser?: PanelUser;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BODY_LIMIT_BYTES = 64 * 1024;
// A text file is saved as JSON, where a control character takes six bytes. The editor saves up to 2 MiB, so this covers that in the worst escaping.
const TEXT_WRITE_BODY_LIMIT = 12 * 1024 * 1024;
// The longest a request may take to arrive. It bounds a slow upload (the largest is 256 MiB) on a slow link, and it does not limit how long
// a response takes. Only an authorized caller reaches the body, because identity is checked before it is read.
const REQUEST_TIMEOUT_MS = 15 * 60_000;

export interface AppDependencies {
  readonly config: PanelConfig;
  readonly db: PanelDatabase;
  readonly sessionGate: SessionGate;
  readonly run?: Runner;
  readonly locks?: OperationLocks;
  /** The start-up readiness cache. One per daemon, shared with the scheduler, so a server's Done line is read once. */
  readonly readiness?: Readiness;
  readonly streams?: StreamRegistry;
  /** The sudo binary used for privileged actions. Tests substitute a fake; production uses the system's. */
  readonly sudo?: string;
  readonly account?: string;
  readonly lockout?: PasswordLockout;
  readonly identity?: IdentityLookup;
  /** The website's account list for the Access screen. Tests substitute a fake; production asks the website with the caller's cookie. */
  readonly accounts?: AccountsLookup;
  readonly scheduler?: Scheduler;
  readonly alerts?: AlertService;
  readonly fetcher?: Fetcher;
  /** Whether zstd is installed, which picks the backup archive format. Defaults to true. */
  readonly zstd?: boolean;
  /** Aborted when the daemon starts stopping. See ApiContext. */
  readonly stopping?: AbortSignal;
  readonly webDir?: string;
  /** How long a request body may take to arrive. Production uses the default; tests shorten it. */
  readonly requestTimeoutMs?: number;
  readonly logger?: boolean | { level: string; redact: { paths: string[]; censor: string } };
}


function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join("; ") : value;
}

// A refused attempt is audited, but a page that retries must not flood the log: one row per person and route in a window. The
// window map is bounded: when it grows past its cap it is cleared, which at worst repeats a row that the window would have hidden.
const DENIAL_WINDOW_MS = 30_000;
const WINDOW_CAP = 2000;
const lastDenial = new Map<string, number>();
const lastTouch = new Map<string, number>();
const TOUCH_INTERVAL_MS = 10 * 60_000;

function shouldTouch(userId: string, now: Date): boolean {
  const previous = lastTouch.get(userId);
  // A clock that stepped back must not hold the window closed until it catches up, so only a forward spacing inside the window counts.
  const since = previous === undefined ? Number.POSITIVE_INFINITY : now.getTime() - previous;
  if (since >= 0 && since < TOUCH_INTERVAL_MS) return false;
  if (lastTouch.size > WINDOW_CAP) lastTouch.clear();
  lastTouch.set(userId, now.getTime());
  return true;
}

function recordDenial(deps: AppDependencies, userId: string, email: string, routeId: string, serverId: string | undefined, now: Date): void {
  const key = `${userId} ${routeId} ${serverId ?? ""}`;
  const previous = lastDenial.get(key);
  const since = previous === undefined ? Number.POSITIVE_INFINITY : now.getTime() - previous;
  if (since >= 0 && since < DENIAL_WINDOW_MS) return;
  if (lastDenial.size > WINDOW_CAP) lastDenial.clear();
  lastDenial.set(key, now.getTime());
  recordAudit(
    deps.db,
    { userId, userLabel: email, serverId: serverId ?? null, action: `denied.${routeId}`, outcome: "denied" },
    now,
  );
}

function guardFor(spec: RouteSpec, deps: AppDependencies) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const answer = await deps.sessionGate.lookup(headerValue(request.headers.cookie), {
      fresh: MUTATING.has(request.method),
    });
    if (answer.kind === "signed_out") {
      return sendError(reply, "unauthenticated", "Sign in to the website first.");
    }
    if (answer.kind === "no_access") {
      return sendError(reply, "no_access", "This account cannot access the server panel.");
    }
    if (answer.kind === "unavailable") {
      // Unavailable is never access and never a redirect: the page shows that sign-in cannot be checked right now.
      return sendError(reply, "unavailable", "Sign-in cannot be checked right now. Try again shortly.");
    }
    const params = request.params as Record<string, string | undefined>;
    const principal = { id: answer.user.id, role: answer.user.role };
    const now = new Date();
    if (shouldTouch(answer.user.id, now)) touchKnownUser(deps.db, answer.user, now);
    // Panel access comes before any route's own capability: an ADMIN with no grant rows is refused here, on every route.
    if (!authorize(deps.db, principal, PANEL_ACCESS)) {
      return sendError(reply, "no_access", "This account cannot access the server panel.");
    }
    const allowed = authorize(deps.db, principal, spec.capability, params.serverId);
    if (!allowed) {
      recordDenial(deps, answer.user.id, answer.user.email, spec.id, params.serverId, now);
      return sendError(reply, "forbidden", "Your account does not have permission for this.");
    }
    request.panelUser = answer.user;
    return undefined;
  };
}

export function createApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: BODY_LIMIT_BYTES,
    // The limit is enforced per request below, so a refusal is answered in the panel's envelope rather than in Node's plain-text 408.
    requestTimeout: 0,
    trustProxy: false,
  });
  const apiPrefix = `${deps.config.basePath}/api/v1`;
  const run = deps.run ?? runProcess;
  const locks = deps.locks ?? new OperationLocks();
  const readiness = deps.readiness ?? new Readiness({ paperServer: (id) => getServer(deps.db, id)?.memory !== null });
  const identity = deps.identity ?? createIdentityLookup({ siteOrigin: deps.config.siteOrigin });
  // Discord posting is not connected yet, so incidents are recorded as not sent. Both consumers share this one instance so its windows agree.
  const alerts = deps.alerts ?? createAlerts({ db: deps.db });
  const scheduler =
    deps.scheduler ??
    createScheduler({
      db: deps.db,
      config: deps.config,
      run,
      locks,
      readiness,
      identity,
      alerts,
      ...(deps.stopping === undefined ? {} : { stopping: deps.stopping }),
    });
  const handlers = createHandlers({
    db: deps.db,
    config: deps.config,
    run,
    locks,
    readiness,
    identity,
    accounts: deps.accounts ?? createAccountsLookup({ siteOrigin: deps.config.siteOrigin }),
    sessionGate: deps.sessionGate,
    streams: deps.streams ?? new StreamRegistry(),
    sudo: deps.sudo ?? "/usr/bin/sudo",
    account: deps.account ?? userInfo().username,
    lockout: deps.lockout ?? new PasswordLockout(),
    scheduler,
    zstd: deps.zstd ?? true,
    ...(deps.stopping === undefined ? {} : { stopping: deps.stopping }),
    alerts,
    fetcher: deps.fetcher ?? ((url, init) => fetch(url, init)),
  });

  // Every response carries the same hardening, including the static files: the site and the panel share an origin, so the panel
  // must refuse to be framed and must not be scriptable from a page the site hosts. Script can come only from this origin.
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    return payload;
  });

  // A request whose body is still arriving at the limit is answered in the panel's envelope, and its connection is closed. Only a request that
  // has not been read in full is refused, so a slow upload is the one that can hit the limit.
  const requestLimitMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  app.addHook("onRequest", async (request, reply) => {
    const timer = setTimeout(() => {
      if (request.raw.complete) return;
      // A request already answered (refused before its body was read) must not keep its socket while the body trickles in.
      if (reply.sent) {
        request.raw.destroy();
        return;
      }
      reply.header("connection", "close");
      sendError(reply, "request_timeout", "The request took longer than the panel allows. Try again, or send a smaller file.");
    }, requestLimitMs);
    timer.unref();
    reply.raw.once("close", () => clearTimeout(timer));
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedHost(request.headers.host, deps.config)) {
      return sendError(reply, "wrong_host", "This address is not served by the panel.");
    }
    if (MUTATING.has(request.method)) {
      if (request.headers["x-panel-request"] !== "1") {
        return sendError(reply, "csrf_refused", "The request is missing the panel's request header.");
      }
      if (request.headers.origin !== deps.config.publicOrigin) {
        return sendError(reply, "csrf_refused", "The request did not come from the panel's origin.");
      }
    }
    return undefined;
  });

  for (const spec of ROUTES) {
    // The upload has its own scope below, so its raw body parser and limit never reach any other route.
    if (spec.id === "files.upload") continue;
    const handler: Handler = handlers[spec.id];
    app.route({
      method: spec.method,
      url: `${apiPrefix}${spec.path}`,
      // Identity runs before the body is read, so an anonymous caller cannot make the daemon buffer a large upload.
      onRequest: guardFor(spec, deps),
      // A body can take a while to arrive, so a mutating request is authorized again once it has been read.
      ...(MUTATING.has(spec.method) ? { preHandler: guardFor(spec, deps) } : {}),
      ...(spec.id === "files.write" ? { bodyLimit: TEXT_WRITE_BODY_LIMIT } : {}),
      handler: (request, reply) => handler(request, reply),
    });
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (reply.sent) return;
    const status = error.statusCode ?? 500;
    if (status === 413) return sendError(reply, "payload_too_large", "The request body is too large.");
    if (status === 415) return sendError(reply, "unsupported_media_type", "This route does not accept a request body in that format.");
    if (status >= 400 && status < 500) return sendError(reply, "invalid_request", "The request could not be read.");
    // Logged by name and code only: a message or a request body can carry something the panel must not write down.
    request.log.error({ name: error.name, code: error.code }, "request failed");
    return sendError(reply, "internal_error", "Something went wrong. The server log has the details.");
  });

  // The upload is the only route that takes a raw body. Its scope has no JSON parser, and an octet-stream body reaches the handler as a stream
  // rather than being read into memory, so every other route refuses a raw body without reading it and this route refuses anything else.
  // The handler requires the declared length; the bytes are counted as they arrive, and the permission is checked again before the file is replaced.
  const upload = ROUTES.find((spec) => spec.id === "files.upload");
  if (upload === undefined) throw new Error("the route table has no upload route");
  app.register((scope, _options, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
      done(null, payload);
    });
    scope.route({
      method: upload.method,
      url: `${apiPrefix}${upload.path}`,
      onRequest: guardFor(upload, deps),
      bodyLimit: UPLOAD_MAX_BYTES,
      handler: (request, reply) => handlers["files.upload"](request, reply),
    });
    done();
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith(apiPrefix)) {
      return sendError(reply, "not_found", "There is no such API route.");
    }
    if (deps.webDir !== undefined && request.method === "GET") {
      const asset = await readStatic(deps.webDir, deps.config.basePath, request.url.split("?")[0] ?? "");
      if (asset !== null) {
        return reply.header("cache-control", asset.cacheControl).type(asset.contentType).send(asset.body);
      }
    }
    return sendError(reply, "not_found", "Not found.");
  });

  return app;
}
