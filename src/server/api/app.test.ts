import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type PanelConfig } from "../config/config.js";
import { bundledMigrationsDirectory, migrate } from "../db/migrate.js";
import type { PanelDatabase } from "../db/open.js";
import { ROUTES } from "../authz/routes.js";
import { createSessionGate, type FetchLike, type SessionGate } from "../gate/session.js";
import { createApp } from "./app.js";
import type { FastifyInstance } from "fastify";

const OWNER = { id: "owner-1", email: "owner@example.net", name: "Owner", role: "OWNER" };
const ADMIN = { id: "admin-1", email: "admin@example.net", name: "Admin", role: "ADMIN" };
const COOKIE = "__Secure-authjs.session-token=good";
const PANEL_HEADERS = { "x-panel-request": "1", origin: "https://example.net" };

let db: PanelDatabase;
let config: PanelConfig;
let root: string;
let app: FastifyInstance;
let siteAnswer: (cookie: string) => Response;
let siteCalls: number;

function fakeSite(): FetchLike {
  return (_input, init) => {
    siteCalls += 1;
    const cookie = (init.headers as Record<string, string>).cookie ?? "";
    return Promise.resolve(siteAnswer(cookie));
  };
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

function errorBody(response: { readonly body: string }): ErrorBody {
  return JSON.parse(response.body) as ErrorBody;
}

function userResponse(user: typeof OWNER | typeof ADMIN): Response {
  return new Response(JSON.stringify({ data: { user } }), { status: 200, headers: { "content-type": "application/json" } });
}

async function build(options: { webDir?: string; gate?: SessionGate } = {}): Promise<void> {
  const gate = options.gate ?? createSessionGate({ siteOrigin: config.siteOrigin, fetch: fakeSite(), negativeTtlMs: 0, positiveTtlMs: 0 });
  app = createApp({
    config,
    db,
    sessionGate: gate,
    ...(options.webDir !== undefined ? { webDir: options.webDir } : {}),
  });
  await app.ready();
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-app-"));
  db = new Database(":memory:");
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: join(root, "b") });
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: root, PANEL_BASE_PATH: "/panel" });
  siteCalls = 0;
  siteAnswer = (cookie) => (cookie === COOKIE ? userResponse(OWNER) : new Response(null, { status: 401 }));
  await build();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const ME = "/panel/api/v1/me";

describe("a request whose body stalls", () => {
  it("is answered at the limit in the panel's envelope, and its connection is closed", async () => {
    const limited = createApp({
      config,
      db,
      sessionGate: createSessionGate({ siteOrigin: config.siteOrigin, fetch: fakeSite(), negativeTtlMs: 0, positiveTtlMs: 0 }),
      requestTimeoutMs: 50,
    });
    await limited.ready();
    // A body that never ends, from an owner who is signed in and allowed to add a server: the wait is for the body, not for the answer.
    const body = new PassThrough();
    try {
      const response = await limited.inject({
        method: "POST",
        url: "/panel/api/v1/servers",
        headers: { host: "example.net", cookie: COOKIE, "content-type": "application/json", ...PANEL_HEADERS },
        payload: body,
      });
      expect(response.statusCode).toBe(408);
      expect(response.headers.connection).toBe("close");
      expect(errorBody(response).error.code).toBe("request_timeout");
    } finally {
      body.destroy();
      await limited.close();
    }
  });
});

describe("identity on API routes", () => {
  it("answers 401 unauthenticated with no cookie, without calling the website", async () => {
    const response = await app.inject({ method: "GET", url: ME, headers: { host: "example.net" } });
    expect(response.statusCode).toBe(401);
    expect(errorBody(response).error.code).toBe("unauthenticated");
    expect(siteCalls).toBe(0);
  });

  it("answers 401 when the website says the session is not valid", async () => {
    const response = await app.inject({ method: "GET", url: ME, headers: { host: "example.net", cookie: "bad=1" } });
    expect(response.statusCode).toBe(401);
    expect(errorBody(response).error.code).toBe("unauthenticated");
  });

  it("answers 403 no_access for a signed-in account the website refuses", async () => {
    siteAnswer = () => new Response(null, { status: 403 });
    await app.close();
    await build();
    const response = await app.inject({ method: "GET", url: ME, headers: { host: "example.net", cookie: COOKIE } });
    expect(response.statusCode).toBe(403);
    expect(errorBody(response).error.code).toBe("no_access");
  });

  it("answers 503 unavailable, never a redirect, when the website cannot be asked", async () => {
    siteAnswer = () => new Response(null, { status: 500 });
    await app.close();
    await build();
    const response = await app.inject({ method: "GET", url: ME, headers: { host: "example.net", cookie: COOKIE } });
    expect(response.statusCode).toBe(503);
    expect(errorBody(response).error.code).toBe("unavailable");
    expect(response.headers.location).toBeUndefined();
  });

  it("returns the caller for a signed-in OWNER, with no-store", async () => {
    const response = await app.inject({ method: "GET", url: ME, headers: { host: "example.net", cookie: COOKIE } });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body) as unknown).toEqual({ data: { user: OWNER, ownerOrOperator: true } });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("refuses a signed-in ADMIN with no grants on every route, with the no-access answer", async () => {
    siteAnswer = () => userResponse(ADMIN);
    await app.close();
    await build();
    for (const url of ["/panel/api/v1/me", "/panel/api/v1/servers"]) {
      const response = await app.inject({ method: "GET", url, headers: { host: "example.net", cookie: "a=1" } });
      expect(response.statusCode).toBe(403);
      expect(errorBody(response).error.code).toBe("no_access");
    }
  });

  it("maps an internal failure to a generic internal_error that leaks no detail", async () => {
    const gate: SessionGate = {
      lookup: () => Promise.reject(new Error("secret detail /home/someone/panel.db")),
    };
    await app.close();
    await build({ gate });
    const response = await app.inject({ method: "GET", url: ME, headers: { host: "example.net", cookie: COOKIE } });
    expect(response.statusCode).toBe(500);
    expect(errorBody(response).error.code).toBe("internal_error");
    expect(response.body).not.toContain("secret detail");
    expect(response.body).not.toContain("/home/someone");
  });
});

describe("request checks", () => {
  it("refuses a Host that is neither the public host nor loopback, before anything else", async () => {
    const response = await app.inject({ method: "GET", url: ME, headers: { host: "evil.example", cookie: COOKIE } });
    expect(response.statusCode).toBe(403);
    expect(errorBody(response).error.code).toBe("wrong_host");
    expect(siteCalls).toBe(0);
  });

  it("accepts loopback as the Host", async () => {
    const response = await app.inject({ method: "GET", url: ME, headers: { host: "127.0.0.1:29200", cookie: COOKIE } });
    expect(response.statusCode).toBe(200);
  });

  it("refuses a mutating request without the panel's request header", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/panel/api/v1/servers",
      headers: { host: "example.net", cookie: COOKIE, origin: "https://example.net" },
      payload: "{}",
    });
    expect(response.statusCode).toBe(403);
    expect(errorBody(response).error.code).toBe("csrf_refused");
  });

  it("refuses a mutating request whose Origin is not the public origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/panel/api/v1/servers",
      headers: { host: "example.net", cookie: COOKIE, "x-panel-request": "1", origin: "https://attacker.example" },
      payload: "{}",
    });
    expect(response.statusCode).toBe(403);
    expect(errorBody(response).error.code).toBe("csrf_refused");
  });

  it("answers an unknown API route with the envelope", async () => {
    const response = await app.inject({ method: "GET", url: "/panel/api/v1/nope", headers: { host: "example.net", cookie: COOKIE } });
    expect(response.statusCode).toBe(404);
    expect(errorBody(response).error.code).toBe("not_found");
  });

  it("refuses an oversized body with payload_too_large", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/panel/api/v1/servers",
      headers: { host: "example.net", cookie: COOKIE, ...PANEL_HEADERS, "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(errorBody(response).error.code).toBe("payload_too_large");
  });

  it("registers exactly the routes in the table", () => {
    for (const route of ROUTES) {
      expect(app.hasRoute({ method: route.method, url: `/panel/api/v1${route.path}` }), route.id).toBe(true);
    }
  });
});

describe("response hardening", () => {
  it("sends the panel's content security policy and framing refusal on every response", async () => {
    const response = await app.inject({ method: "GET", url: ME, headers: { host: "example.net", cookie: COOKIE } });
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["content-security-policy"]).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.headers["x-robots-tag"]).toBe("noindex");
  });
});

describe("static single-page app", () => {
  function webDirWithApp(): string {
    const web = join(root, "web");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(
      join(web, "index.html"),
      '<meta name="panel-base" content="__PANEL_BASE__" /><script src="/__PANEL_BASE__/assets/app.js"></script>',
    );
    writeFileSync(join(web, "assets", "app.js"), "console.log('panel');");
    writeFileSync(join(root, "secret.txt"), "not for the browser");
    return web;
  }

  it("serves the index with the configured base path substituted", async () => {
    await app.close();
    await build({ webDir: webDirWithApp() });
    const response = await app.inject({ method: "GET", url: "/panel/", headers: { host: "example.net" } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('src="/panel/assets/app.js"');
    expect(response.body).not.toContain("//panel");
    expect(response.body).toContain('content="/panel"');
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("serves a hashed asset as immutable and falls back to the index for an app route", async () => {
    await app.close();
    await build({ webDir: webDirWithApp() });
    const asset = await app.inject({ method: "GET", url: "/panel/assets/app.js", headers: { host: "example.net" } });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const route = await app.inject({ method: "GET", url: "/panel/servers/alpha", headers: { host: "example.net" } });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain("/panel/assets/app.js");
  });

  it("never reads a file outside the build directory", async () => {
    await app.close();
    await build({ webDir: webDirWithApp() });
    for (const url of ["/panel/%2e%2e/secret.txt", "/panel/..%2fsecret.txt", "/panel/assets/%00.js"]) {
      const response = await app.inject({ method: "GET", url, headers: { host: "example.net" } });
      expect(response.body, url).not.toContain("not for the browser");
    }
  });
});
