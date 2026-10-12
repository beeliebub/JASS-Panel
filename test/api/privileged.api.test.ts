// The privileged-action route with a fake sudo. The fake records the argv and a hash of what it received on standard input, never
// the password itself, and it deliberately echoes the password on success so output scrubbing is exercised. No test runs sudo.
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/api/app.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { createSessionGate, type FetchLike } from "../../src/server/gate/session.js";
import { PasswordLockout } from "../../src/server/privileged/lockout.js";
import { runProcess } from "../../src/server/systemd/run.js";
import type { FastifyInstance } from "fastify";

const GOOD = "correct-horse-battery";
const OWNER = { id: "owner-priv", email: "owner@example.net", name: "Owner", role: "OWNER" };
const ACCOUNT = "tester-account";
const PANEL = { host: "example.net", origin: "https://example.net", "x-panel-request": "1", cookie: "session=owner", "content-type": "application/json" };

let root: string;
let record: string;
let sudo: string;
let db: PanelDatabase;
let config: PanelConfig;
let app: FastifyInstance;
let lockout: PasswordLockout;

const websiteOwner: FetchLike = () =>
  Promise.resolve(new Response(JSON.stringify({ data: { user: OWNER } }), { status: 200, headers: { "content-type": "application/json" } }));

const FAKE_SUDO = `#!/bin/bash
# Records the argv and a hash of standard input, then checks the password. Echoes the password on success, to test scrubbing.
printf '%s\\0' "$@" > "${"$"}FAKE_SUDO_RECORD.argv"
IFS= read -r password
printf '%s' "$password" | sha256sum | cut -d' ' -f1 > "${"$"}FAKE_SUDO_RECORD.stdin-hash"
if [ "$password" != "${GOOD}" ]; then echo "Sorry, try again." >&2; exit 1; fi
echo "ran the catalogue command as root"
echo "the password was $password"
exit 0
`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-priv-"));
  record = join(root, "record");
  sudo = join(root, "sudo");
  writeFileSync(sudo, FAKE_SUDO.replace("${GOOD}", GOOD));
  chmodSync(sudo, 0o755);
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  lockout = new PasswordLockout();
  app = createApp({
    config,
    db,
    sessionGate: createSessionGate({ siteOrigin: config.siteOrigin, fetch: websiteOwner, positiveTtlMs: 0, negativeTtlMs: 0 }),
    run: runProcess,
    sudo,
    account: ACCOUNT,
    lockout,
  });
  await app.ready();
  process.env.FAKE_SUDO_RECORD = record;
});

afterAll(async () => {
  delete process.env.FAKE_SUDO_RECORD;
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function act(action: string, body: unknown) {
  return app.inject({ method: "POST", url: `/panel/api/v1/privileged/${action}`, headers: PANEL, payload: JSON.stringify(body) });
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("privileged actions", () => {
  it("runs the catalogue command for the daemon's own account, with the password on standard input only", async () => {
    const response = await act("enable-lingering", { password: GOOD });
    expect(response.statusCode).toBe(200);
    const argv = readFileSync(`${record}.argv`, "utf8").split("\0").filter((part, index, all) => index < all.length - 1);
    expect(argv).toEqual(["-S", "-k", "-p", "", "--", "loginctl", "enable-linger", ACCOUNT]);
    expect(readFileSync(`${record}.stdin-hash`, "utf8").trim()).toBe(sha(GOOD));
    expect(argv.join(" ")).not.toContain(GOOD);
  });

  it("never returns or audits the password, even when the command prints it", () => {
    const rows = db.prepare("SELECT details, action FROM audit WHERE action LIKE 'privileged.%'").all() as { details: string | null; action: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.details ?? "").not.toContain(GOOD);
  });

  it("returns the command output with the password removed", async () => {
    const response = await act("enable-lingering", { password: GOOD });
    const body = JSON.parse(response.body) as { data: { output: string } };
    expect(body.data.output).toContain("ran the catalogue command as root");
    expect(body.data.output).not.toContain(GOOD);
  });

  it("refuses a wrong password with forbidden and audits it without the value", async () => {
    const response = await act("enable-lingering", { password: "wrong-one" });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("wrong-one");
    const denied = db.prepare("SELECT details FROM audit WHERE outcome = 'denied' ORDER BY id DESC LIMIT 1").get() as { details: string };
    expect(denied.details).not.toContain("wrong-one");
  });

  it("disables the actions for the lock period after two consecutive wrong passwords, even for the right one", async () => {
    lockout = new PasswordLockout();
    const locked = createApp({
      config,
      db,
      sessionGate: createSessionGate({ siteOrigin: config.siteOrigin, fetch: websiteOwner, positiveTtlMs: 0, negativeTtlMs: 0 }),
      run: runProcess,
      sudo,
      account: ACCOUNT,
      lockout,
    });
    await locked.ready();
    const attempt = (password: string) =>
      locked.inject({ method: "POST", url: "/panel/api/v1/privileged/enable-lingering", headers: PANEL, payload: JSON.stringify({ password }) });
    expect((await attempt("nope-1")).statusCode).toBe(403);
    expect((await attempt("nope-2")).statusCode).toBe(403);
    const blocked = await attempt(GOOD);
    expect(blocked.statusCode).toBe(429);
    expect((JSON.parse(blocked.body) as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(lockout.remaining()).toBeGreaterThan(0);
    const lockRows = db.prepare("SELECT action FROM audit WHERE action = 'privileged.lockout'").all();
    expect(lockRows.length).toBeGreaterThan(0);
    await locked.close();
  });

  it("refuses a body that tries to add a command, and an action outside the catalogue", async () => {
    const extra = await act("enable-lingering", { password: GOOD, argv: ["/bin/sh", "-c", "id"] });
    expect(extra.statusCode).toBe(400);
    const unknown = await act("rm-everything", { password: GOOD });
    expect(unknown.statusCode).toBe(404);
  });

  it("refuses a Java package outside the allowlist", async () => {
    const response = await act("install-java", { password: GOOD, javaPackage: "malware; rm -rf /" });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("malware");
  });
});
