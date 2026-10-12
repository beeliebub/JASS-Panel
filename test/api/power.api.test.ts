// The power routes over HTTP: a countdown is cancelled only by the person who started it, and the console refuses input until the server
// has printed its Done line. The unit is a stand-in, so nothing here starts or stops a real server.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/api/app.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { createSessionGate, type FetchLike } from "../../src/server/gate/session.js";
import { Countdown } from "../../src/server/power/countdown.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { Readiness } from "../../src/server/power/readiness.js";
import type { Runner, RunResult } from "../../src/server/systemd/run.js";

const OWNER = { id: "owner-power", email: "owner@example.net", name: "Owner", role: "OWNER" };
const ADMIN = { id: "admin-power", email: "admin@example.net", name: "Admin", role: "ADMIN" };
const USERS: Record<string, typeof OWNER | typeof ADMIN> = { owner: OWNER, admin: ADMIN };
const PANEL = { host: "example.net", origin: "https://example.net", "x-panel-request": "1", "content-type": "application/json" };
const INVOCATION = "0123456789abcdef0123456789abcdef";

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let app: FastifyInstance;
let locks: OperationLocks;

const website: FetchLike = (_url, init) => {
  const user = USERS[((init.headers as Record<string, string>).cookie ?? "").replace(/^session=/, "")];
  return Promise.resolve(
    user === undefined ? new Response(null, { status: 401 }) : new Response(JSON.stringify({ data: { user } }), { status: 200, headers: { "content-type": "application/json" } }),
  );
};

/** A unit that is active and has not printed Done: its journal is empty, so the console must refuse input. */
const loadingUnit: Runner = (argv): Promise<RunResult> => {
  const stdout = argv[0] === "journalctl" ? "" : `Id=jass-mc-alpha.service\nActiveState=active\nSubState=running\nResult=success\nMainPID=1\nActiveEnterTimestamp=x\nInvocationID=${INVOCATION}\n`;
  return Promise.resolve({ code: 0, signal: null, stdout, stderr: "" });
};

function sessionGate() {
  return createSessionGate({ siteOrigin: config.siteOrigin, fetch: website, positiveTtlMs: 0, negativeTtlMs: 0 });
}

function call(target: FastifyInstance, method: "GET" | "POST", url: string, who: "owner" | "admin", payload?: unknown) {
  // A JSON content type is sent only with a body, as the browser client does; Fastify refuses an empty JSON body.
  const { "content-type": _contentType, ...withoutType } = PANEL;
  return target.inject({
    method,
    url: `/panel/api/v1${url}`,
    headers: payload === undefined ? { ...withoutType, cookie: `session=${who}` } : { ...PANEL, cookie: `session=${who}` },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function errorCode(body: string): string | undefined {
  return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-power-api-"));
  mkdirSync(join(root, "alpha"), { recursive: true });
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  db.prepare("INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES ('alpha', 'Alpha', ?, ?, 'logs/latest.log', 'now', 'now')").run(
    join(root, "alpha"),
    JSON.stringify(["/bin/true"]),
  );
  // The admin may use power on this server, so a refusal in the tests below is the countdown's rule and not a missing grant.
  db.prepare("INSERT INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, 'alpha', 'power', 'test', 'now')").run(ADMIN.id);
  locks = new OperationLocks();
  app = createApp({ config, db, locks, sessionGate: sessionGate() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A cancel as the page sends it: it names the countdown the page was shown, which is the one running on alpha when there is one. */
function cancelAs(who: "owner" | "admin") {
  const shown = locks.countdowns.describe("alpha");
  return call(app, "POST", "/servers/alpha/power/cancel", who, { countdownId: shown?.id ?? "00000000-0000-4000-8000-000000000000" });
}

describe("cancelling a countdown over HTTP", () => {
  it("answers a cancel with a conflict when no countdown is running on the server", async () => {
    const response = await cancelAs("owner");
    expect(response.statusCode).toBe(409);
    expect(errorCode(response.body)).toBe("conflict");
  });

  it("refuses a cancel that does not name the countdown it cancels", async () => {
    const countdown = new Countdown("alpha", OWNER.id, "stop", false, { sent: 0, due: 0 });
    locks.countdowns.attach(countdown);
    try {
      const response = await call(app, "POST", "/servers/alpha/power/cancel", "owner", {});
      expect(response.statusCode).toBe(400);
      expect(errorCode(response.body)).toBe("invalid_request");
      expect(countdown.cancelled).toBe(false);
    } finally {
      locks.countdowns.detach(countdown);
    }
  });

  it("refuses a cancel that names an earlier countdown, and leaves the one running alone", async () => {
    const countdown = new Countdown("alpha", OWNER.id, "stop", false, { sent: 0, due: 0 });
    locks.countdowns.attach(countdown);
    try {
      const response = await call(app, "POST", "/servers/alpha/power/cancel", "owner", { countdownId: "00000000-0000-4000-8000-000000000000" });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response.body)).toBe("conflict");
      expect(countdown.cancelled).toBe(false);
    } finally {
      locks.countdowns.detach(countdown);
    }
  });

  it("refuses a cancel by a person who did not start the countdown, and leaves it running", async () => {
    const countdown = new Countdown("alpha", OWNER.id, "stop", false, { sent: 0, due: 0 });
    locks.countdowns.attach(countdown);
    try {
      const response = await cancelAs("admin");
      expect(response.statusCode).toBe(403);
      expect(errorCode(response.body)).toBe("forbidden");
      expect(countdown.cancelled).toBe(false);
    } finally {
      locks.countdowns.detach(countdown);
    }
  });

  it("cancels a countdown for the person who started it, and says so", async () => {
    const countdown = new Countdown("alpha", OWNER.id, "stop", false, { sent: 0, due: 0 });
    locks.countdowns.attach(countdown);
    try {
      const response = await cancelAs("owner");
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body) as unknown).toEqual({ data: { cancelled: true } });
      expect(countdown.cancelled).toBe(true);
    } finally {
      locks.countdowns.detach(countdown);
    }
  });

  it("lets any holder of power cancel a scheduled countdown, and names them as the one who cancelled it", async () => {
    const countdown = new Countdown("alpha", OWNER.id, "stop", true, { sent: 0, due: 0 });
    locks.countdowns.attach(countdown);
    try {
      const response = await cancelAs("admin");
      expect(response.statusCode).toBe(200);
      expect(countdown.cancelled).toBe(true);
      expect(countdown.cancelledBy).toBe(ADMIN.email);
    } finally {
      locks.countdowns.detach(countdown);
    }
  });

  it("refuses a cancel once the stop has begun", async () => {
    const countdown = new Countdown("alpha", OWNER.id, "stop", false, { sent: 0, due: 0 });
    locks.countdowns.attach(countdown);
    try {
      expect(countdown.beginStop()).toBe(true);
      const response = await cancelAs("owner");
      expect(response.statusCode).toBe(409);
      expect(errorCode(response.body)).toBe("conflict");
    } finally {
      locks.countdowns.detach(countdown);
    }
  });
});

describe("console input while a server is loading", () => {
  it("refuses a command until the server has printed its Done line, and says why", async () => {
    // This readiness check expects a Paper Done line from every server, as it does for servers made from the Paper preset.
    const loading = createApp({ config, db, run: loadingUnit, locks, readiness: new Readiness(), sessionGate: sessionGate() });
    await loading.ready();
    try {
      const response = await call(loading, "POST", "/servers/alpha/console", "owner", { line: "list" });
      expect(response.statusCode).toBe(409);
      const failure = JSON.parse(response.body) as { error: { message: string } };
      expect(failure.error.message).toMatch(/still loading/);
      const delivered = db.prepare("SELECT COUNT(*) AS count FROM audit WHERE action = 'console.send'").get() as { count: number };
      expect(delivered.count).toBe(0);
    } finally {
      await loading.close();
    }
  });
});

describe("the countdown a page is shown", () => {
  it("offers a scheduled countdown's cancel to every holder of power, and a person's own only to its starter", async () => {
    const shown = { action: "stop", warningsSent: 1, warningsDue: 3 };
    const scheduled = new Countdown("alpha", OWNER.id, "stop", true, { sent: 1, due: 3 });
    locks.countdowns.attach(scheduled);
    try {
      const owner = JSON.parse((await call(app, "GET", "/servers/alpha", "owner")).body) as { data: { server: { countdown: unknown } } };
      expect(owner.data.server.countdown).toEqual({ ...shown, id: scheduled.id, scheduled: true, cancellable: true });
      const admin = JSON.parse((await call(app, "GET", "/servers/alpha", "admin")).body) as { data: { server: { countdown: unknown } } };
      expect(admin.data.server.countdown).toEqual({ ...shown, id: scheduled.id, scheduled: true, cancellable: true });
    } finally {
      locks.countdowns.detach(scheduled);
    }
    const own = new Countdown("alpha", OWNER.id, "stop", false, { sent: 1, due: 3 });
    locks.countdowns.attach(own);
    try {
      const owner = JSON.parse((await call(app, "GET", "/servers/alpha", "owner")).body) as { data: { server: { countdown: unknown } } };
      expect(owner.data.server.countdown).toEqual({ ...shown, id: own.id, scheduled: false, cancellable: true });
      const admin = JSON.parse((await call(app, "GET", "/servers/alpha", "admin")).body) as { data: { server: { countdown: unknown } } };
      expect(admin.data.server.countdown).toEqual({ ...shown, id: own.id, scheduled: false, cancellable: false });
    } finally {
      locks.countdowns.detach(own);
    }
  });
});
