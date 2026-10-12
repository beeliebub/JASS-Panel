// The plugin sources over HTTP: a token is written and never returned, a repository is listed with its saved token, and an update answers
// each plugin on its own. GitHub is a fake, and each request it receives is recorded with the authorization it carried.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/api/app.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { createSessionGate, type FetchLike } from "../../src/server/gate/session.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import type { Fetcher } from "../../src/server/plugins/updater.js";

const OWNER = { id: "owner-plugins-api", email: "owner@example.net", name: "Owner", role: "OWNER" };
const ADMIN = { id: "admin-plugins-api", email: "admin@example.net", name: "Admin", role: "ADMIN" };
const USERS: Record<string, typeof OWNER | typeof ADMIN> = { owner: OWNER, admin: ADMIN };
const PANEL_HEADERS = { host: "example.net", origin: "https://example.net", "x-panel-request": "1" };
const TOKEN = "ghp_plugins_api_token";
const REPO = "owner/plugins";
const CORE = Buffer.from("core bytes");
const MAIN = Buffer.from("main bytes");
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const JARS = [
  { id: 21, name: "jass-core-1.1.jar", updated_at: "2026-02-01T00:00:00Z", bytes: CORE },
  { id: 22, name: "jass-main-2.0.jar", updated_at: "2026-02-01T00:00:00Z", bytes: MAIN },
];
const requests: { url: string; authorization: string | undefined }[] = [];

let root: string;
let directory: string;
let config: PanelConfig;
let db: PanelDatabase;
let app: FastifyInstance;

const website: FetchLike = (_url, init) => {
  const user = USERS[((init.headers as Record<string, string>).cookie ?? "").replace(/^session=/, "")];
  return Promise.resolve(
    user === undefined ? new Response(null, { status: 401 }) : new Response(JSON.stringify({ data: { user } }), { status: 200, headers: { "content-type": "application/json" } }),
  );
};

/** GitHub for one repository: a release that lists both jars, and their bytes. Each request is recorded with the authorization it carried. */
const github: Fetcher = (url, init) => {
  requests.push({ url, authorization: init.headers.Authorization });
  if (url === `https://api.github.com/repos/${REPO}/releases/latest`) {
    const assets = JARS.map((jar) => ({ id: jar.id, name: jar.name, updated_at: jar.updated_at, digest: digest(jar.bytes) }));
    return Promise.resolve(new Response(JSON.stringify({ tag_name: "release-7", assets }), { status: 200 }));
  }
  const jar = JARS.find((candidate) => url === `https://api.github.com/repos/${REPO}/releases/assets/${candidate.id}`);
  return Promise.resolve(jar === undefined ? new Response("not found", { status: 404 }) : new Response(jar.bytes, { status: 200 }));
};

function send(method: "PUT" | "POST", url: string, who: "owner" | "admin", payload: unknown) {
  return app.inject({ method, url: `/panel/api/v1${url}`, headers: { ...PANEL_HEADERS, "content-type": "application/json", cookie: `session=${who}` }, payload: JSON.stringify(payload) });
}

function read(url: string, who: "owner" | "admin") {
  return app.inject({ method: "GET", url: `/panel/api/v1${url}`, headers: { ...PANEL_HEADERS, cookie: `session=${who}` } });
}

/** The data of a successful answer, which the caller checks against what it expects. */
function dataOf(body: string): unknown {
  return (JSON.parse(body) as { data: unknown }).data;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-plugins-api-"));
  directory = join(root, "alpha");
  mkdirSync(directory, { recursive: true });
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  db.prepare("INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES ('alpha', 'Alpha', ?, ?, 'logs/latest.log', 'now', 'now')").run(directory, JSON.stringify(["/bin/true"]));
  app = createApp({ config, db, locks: new OperationLocks(), fetcher: github, sessionGate: createSessionGate({ siteOrigin: config.siteOrigin, fetch: website, positiveTtlMs: 0, negativeTtlMs: 0 }) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the plugin sources", () => {
  it("saves a repository with its token, and never returns the token", async () => {
    const saved = await send("PUT", "/servers/alpha/plugin-sources", "owner", { pluginDir: "plugins", sources: [{ repo: REPO, plugins: ["jass-core"], token: TOKEN }] });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(TOKEN);
    const listed = await read("/servers/alpha/plugin-sources", "owner");
    expect(listed.body).not.toContain(TOKEN);
    expect(dataOf(listed.body)).toEqual({ pluginDir: "plugins", sources: [{ repo: REPO, plugins: ["jass-core"], tokenConfigured: true }] });
  });

  it("keeps a repository's saved token when a later save names the repository without one", async () => {
    await send("PUT", "/servers/alpha/plugin-sources", "owner", { pluginDir: "plugins", sources: [{ repo: REPO, plugins: ["jass-core", "jass-main"] }] });
    const listed = await read("/servers/alpha/plugin-sources", "owner");
    expect(dataOf(listed.body)).toEqual({ pluginDir: "plugins", sources: [{ repo: REPO, plugins: ["jass-core", "jass-main"], tokenConfigured: true }] });
  });

  it("refuses a plugin named by two repositories, a folder outside the server, and a viewer without the capability", async () => {
    const twice = await send("PUT", "/servers/alpha/plugin-sources", "owner", { pluginDir: "plugins", sources: [{ repo: REPO, plugins: ["jass-core"] }, { repo: "other/one", plugins: ["Jass-Core"] }] });
    expect(twice.statusCode).toBe(400);
    const outside = await send("PUT", "/servers/alpha/plugin-sources", "owner", { pluginDir: "../elsewhere", sources: [] });
    expect(outside.statusCode).toBe(400);
    expect((await read("/servers/alpha/plugin-sources", "admin")).statusCode).toBe(403);
  });

  it("lists a repository's plugins with its saved token, and refuses a repository name that is not owner/name", async () => {
    const listed = await send("POST", "/servers/alpha/plugin-catalogue", "owner", { repo: REPO });
    expect(listed.statusCode).toBe(200);
    expect(dataOf(listed.body)).toEqual({
      repo: REPO,
      release: "release-7",
      plugins: [
        { name: "jass-core", asset: "jass-core-1.1.jar" },
        { name: "jass-main", asset: "jass-main-2.0.jar" },
      ],
    });
    expect(listed.body).not.toContain(TOKEN);
    expect(requests.filter((request) => request.url.endsWith("/releases/latest")).every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect((await send("POST", "/servers/alpha/plugin-catalogue", "owner", { repo: "not a repo" })).statusCode).toBe(400);
  });

  it("updates each plugin on its own, installs the jars, and records the audit row without the token", async () => {
    const updated = await app.inject({ method: "POST", url: "/panel/api/v1/servers/alpha/plugins/update", headers: { ...PANEL_HEADERS, cookie: "session=owner" } });
    expect(updated.statusCode).toBe(200);
    expect(dataOf(updated.body)).toEqual({
      results: [
        { repo: REPO, plugin: "jass-core", status: "updated", asset: "jass-core-1.1.jar", removed: [], message: null },
        { repo: REPO, plugin: "jass-main", status: "updated", asset: "jass-main-2.0.jar", removed: [], message: null },
      ],
    });
    expect(readdirSync(join(directory, "plugins")).sort()).toEqual(["jass-core-1.1.jar", "jass-main-2.0.jar"]);
    const audit = db.prepare("SELECT details FROM audit WHERE action = 'plugins.update' ORDER BY id DESC LIMIT 1").get() as { details: string };
    expect(audit.details).not.toContain(TOKEN);
    expect(requests.filter((request) => request.url.includes("/releases/assets/")).every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("asks for a source before an update when none is saved", async () => {
    await send("PUT", "/servers/alpha/plugin-sources", "owner", { pluginDir: "plugins", sources: [] });
    const refused = await app.inject({ method: "POST", url: "/panel/api/v1/servers/alpha/plugins/update", headers: { ...PANEL_HEADERS, cookie: "session=owner" } });
    expect(refused.statusCode).toBe(400);
    expect((JSON.parse(refused.body) as { error: { message: string } }).error.message).toBe("Add a plugin source first.");
  });
});
