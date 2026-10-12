// The update path end to end without systemd: the control socket on a real unix socket, the generated update script run as a
// process, and the handler's refusal rules with systemd answering from a stub.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createControlHandler } from "../../src/server/control/handle.js";
import { ensureUpdateRequest } from "../../src/server/control/update-request.js";
import { startControlSocket } from "../../src/server/control/socket.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import type { Runner } from "../../src/server/systemd/run.js";
import type { Fetcher } from "../../src/server/plugins/updater.js";

/** Runs a child process without blocking this one: the socket server under test lives in this process. */
function run(program: string, args: readonly string[]): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", (status) => resolve({ status, stdout }));
  });
}

let root: string;
let config: PanelConfig;
let db: PanelDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-control-"));
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function unitStub(activeState: string): Runner {
  return () =>
    Promise.resolve({
      code: 0,
      signal: null,
      stdout: `Id=jass-mc-alpha.service\nActiveState=${activeState}\nSubState=x\nResult=success\n`,
      stderr: "",
    });
}

function addServer(updateOnStart: number): void {
  const directory = join(root, "alpha");
  mkdirSync(join(directory, "plugins"), { recursive: true });
  db.prepare(
    "INSERT INTO servers (id, display_name, directory, start_command, log_path, update_on_start, created_at, updated_at) VALUES ('alpha', 'Alpha', ?, ?, 'logs/latest.log', ?, 'now', 'now')",
  ).run(directory, JSON.stringify(["/bin/true"]), updateOnStart);
}

describe("the control socket", () => {
  it("answers one line on a socket only this account can open, and refuses a line that is too long", async () => {
    const socketPath = join(root, "control.sock");
    const seen: string[] = [];
    const control = await startControlSocket(socketPath, (line) => {
      seen.push(line);
      return Promise.resolve(`answer to ${line}`);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    const reply = await run("node", ["-e", `const n=require("net");const s=n.connect(process.argv[1]);s.on("connect",()=>s.write("update alpha\\n"));s.on("data",d=>{process.stdout.write(d);s.end()});`, socketPath]);
    expect(reply.stdout.trim()).toBe("answer to update alpha");
    const long = await run("node", ["-e", `const n=require("net");const s=n.connect(process.argv[1]);s.on("connect",()=>s.write("x".repeat(400)));s.on("data",d=>{process.stdout.write(d);s.end()});s.on("error",()=>process.exit(0))`, socketPath]);
    expect(long.stdout).toContain("too long");
    expect(seen).toEqual(["update alpha"]);
    await control.close();
    expect(readdirSync(root)).not.toContain("control.sock");
  });

  it("refuses to replace a path that holds something other than a socket", async () => {
    const path = join(root, "control.sock");
    writeFileSync(path, "not a socket");
    await expect(startControlSocket(path, () => Promise.resolve("x"))).rejects.toThrow(/not a socket/);
  });

  it("refuses a path too long for a Unix socket, with a message that says what to change", async () => {
    const long = join(root, "x".repeat(120), "control.sock");
    await expect(startControlSocket(long, () => Promise.resolve("x"))).rejects.toThrow(/PANEL_DATA_DIR/);
  });
});

describe("the update script", () => {
  it("asks the panel and exits 0 with the answer, and still exits 0 when the panel is not there", async () => {
    const socketPath = join(root, "answer.sock");
    const server = createServer((socket) => {
      socket.on("data", () => socket.end("updated to Plugin-2.0.jar\n"));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    const script = ensureUpdateRequest(root, process.execPath);
    const answered = await run(process.execPath, [script, socketPath, "alpha"]);
    expect(answered.status).toBe(0);
    expect(answered.stdout).toContain("updated to Plugin-2.0.jar");
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const missing = await run(process.execPath, [script, join(root, "absent.sock"), "alpha"]);
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain("not reachable");
  });

  it("refuses a bad server id before it touches the socket", async () => {
    const script = ensureUpdateRequest(root, process.execPath);
    const result = await run(process.execPath, [script, join(root, "x.sock"), "../escape"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bad arguments");
  });
});

describe("the control handler", () => {
  const FILE = "Plugin-2.0.jar";
  const JAR = Buffer.from("jar");
  const SHA = createHash("sha256").update(JAR).digest("hex");
  const fetcher: Fetcher = (url) => {
    if (url === "https://api.github.com/repos/x/y/releases/latest") {
      return Promise.resolve(new Response(JSON.stringify({ tag_name: "release-1", assets: [{ id: 7, name: FILE, updated_at: "2026-01-01T00:00:00Z", digest: `sha256:${SHA}` }] }), { status: 200 }));
    }
    return Promise.resolve(new Response(JAR, { status: 200 }));
  };

  it("refuses an unknown request, a missing server, and a server that is not starting", async () => {
    addServer(1);
    const handle = createControlHandler({ db, config, run: unitStub("inactive"), locks: new OperationLocks(), fetcher });
    expect(await handle("shutdown everything")).toMatch(/unknown request/);
    expect(await handle("update ghost")).toMatch(/no such server/);
    expect(await handle("update alpha")).toMatch(/only a server that is starting/);
  });

  it("skips when updates on start are off, and when a backup holds the server", async () => {
    addServer(0);
    expect(await createControlHandler({ db, config, run: unitStub("activating"), locks: new OperationLocks(), fetcher })("update alpha")).toMatch(/updates on start are off/);
    db.prepare("UPDATE servers SET update_on_start = 1 WHERE id = 'alpha'").run();
    const locks = new OperationLocks();
    locks.tryAcquire("alpha", "backup");
    expect(await createControlHandler({ db, config, run: unitStub("activating"), locks, fetcher })("update alpha")).toMatch(/backup or restore/);
  });

  it("installs the release when the server is starting, the source is set, and nothing holds it", async () => {
    addServer(1);
    db.prepare(`INSERT INTO plugin_sources (server_id, repo, plugins, plugin_dir, token) VALUES ('alpha', 'x/y', '["Plugin"]', 'plugins', NULL)`).run();
    const handle = createControlHandler({ db, config, run: unitStub("activating"), locks: new OperationLocks(), fetcher });
    expect(await handle("update alpha")).toBe("updated 1, current 0, failed 0");
    expect(readdirSync(join(root, "alpha", "plugins"))).toContain(FILE);
    expect(await handle("update alpha")).toMatch(/checked a few minutes ago/);
  });

  it("installs the release inside a panel start or restart, which holds the lock while its unit starts", async () => {
    addServer(1);
    db.prepare(`INSERT INTO plugin_sources (server_id, repo, plugins, plugin_dir, token) VALUES ('alpha', 'x/y', '["Plugin"]', 'plugins', NULL)`).run();
    for (const operation of ["start", "restart"] as const) {
      const locks = new OperationLocks();
      const release = locks.tryAcquire("alpha", operation);
      expect(release).not.toBeNull();
      const handle = createControlHandler({ db, config, run: unitStub("activating"), locks, fetcher });
      expect(await handle("update alpha")).toBe("updated 1, current 0, failed 0");
      // The step borrows the panel operation's lock; it does not take or drop it.
      expect(locks.holder("alpha")).toBe(operation);
      release?.();
      rmSync(join(root, "alpha", "plugins", FILE), { force: true });
    }
  });

  it("still skips when a manual plugin update holds the server, because a start-time step must wait its turn", async () => {
    addServer(1);
    db.prepare(`INSERT INTO plugin_sources (server_id, repo, plugins, plugin_dir, token) VALUES ('alpha', 'x/y', '["Plugin"]', 'plugins', NULL)`).run();
    const locks = new OperationLocks();
    locks.tryAcquire("alpha", "plugin-update");
    expect(await createControlHandler({ db, config, run: unitStub("activating"), locks, fetcher })("update alpha")).toMatch(/another operation is running/);
  });

  it("reports a plugin the release does not offer as failed, by name, and records the failure", async () => {
    addServer(1);
    db.prepare(`INSERT INTO plugin_sources (server_id, repo, plugins, plugin_dir, token) VALUES ('alpha', 'x/y', '["Missing"]', 'plugins', NULL)`).run();
    expect(await createControlHandler({ db, config, run: unitStub("activating"), locks: new OperationLocks(), fetcher })("update alpha")).toBe("updated 0, current 0, failed 1");
    const audit = db.prepare("SELECT outcome, details FROM audit WHERE action = 'plugins.update' ORDER BY id DESC LIMIT 1").get() as { outcome: string; details: string };
    expect(audit.outcome).toBe("failed");
    expect(audit.details).toContain("x/y Missing");
  });

  it("does not keep the next check closed when the clock steps back after a check", async () => {
    addServer(1);
    db.prepare(`INSERT INTO plugin_sources (server_id, repo, plugins, plugin_dir, token) VALUES ('alpha', 'x/y', '["Plugin"]', 'plugins', NULL)`).run();
    let at = 10_000_000_000;
    const handle = createControlHandler({ db, config, run: unitStub("activating"), locks: new OperationLocks(), fetcher, now: () => new Date(at) });
    await handle("update alpha");
    at -= 3_600_000;
    expect(await handle("update alpha")).not.toMatch(/checked a few minutes ago/);
  });

  it("does not hold the next check back after a run that failed before it began", async () => {
    addServer(1);
    mkdirSync(join(root, "outside"));
    // A plugin folder that is a link out of the server folder is refused by the jail before any release is read.
    symlinkSync(join(root, "outside"), join(root, "alpha", "escape"));
    db.prepare(`INSERT INTO plugin_sources (server_id, repo, plugins, plugin_dir, token) VALUES ('alpha', 'x/y', '["Plugin"]', 'escape', NULL)`).run();
    const handle = createControlHandler({ db, config, run: unitStub("activating"), locks: new OperationLocks(), fetcher });
    expect(await handle("update alpha")).toMatch(/^failed: /);
    expect(await handle("update alpha")).not.toMatch(/checked a few minutes ago/);
  });

  it("waits one minute after a check with a failed plugin, then two, four, eight and ten, and a clean check returns to ten", async () => {
    addServer(1);
    db.prepare(`INSERT INTO plugin_sources (server_id, repo, plugins, plugin_dir, token) VALUES ('alpha', 'x/y', '["Missing"]', 'plugins', NULL)`).run();
    let at = 10_000_000_000;
    const handle = createControlHandler({ db, config, run: unitStub("activating"), locks: new OperationLocks(), fetcher, now: () => new Date(at) });
    for (const minutes of [1, 2, 4, 8, 10, 10]) {
      expect(await handle("update alpha")).toBe("updated 0, current 0, failed 1");
      // One second before the wait ends, the next check is still held back; one second after, it runs.
      at += minutes * 60_000 - 1_000;
      expect(await handle("update alpha")).toMatch(/checked a few minutes ago/);
      at += 2_000;
    }
    db.prepare(`UPDATE plugin_sources SET plugins = '["Plugin"]' WHERE server_id = 'alpha'`).run();
    expect(await handle("update alpha")).toMatch(/failed 0/);
    at += 9 * 60_000;
    expect(await handle("update alpha")).toMatch(/checked a few minutes ago/);
    at += 61_000;
    expect(await handle("update alpha")).toMatch(/failed 0/);
  });

  it("checks a server added again under the same id at its first start, though its earlier self was checked just before", async () => {
    addServer(1);
    db.prepare(`INSERT INTO plugin_sources (server_id, repo, plugins, plugin_dir, token) VALUES ('alpha', 'x/y', '["Plugin"]', 'plugins', NULL)`).run();
    const handle = createControlHandler({ db, config, run: unitStub("activating"), locks: new OperationLocks(), fetcher, now: () => new Date(10_000_000_000) });
    expect(await handle("update alpha")).toMatch(/failed 0/);
    // The same id, a new server: its row carries a new creation time, and the hold kept for the earlier server does not apply to it.
    db.prepare("UPDATE servers SET created_at = 'later' WHERE id = 'alpha'").run();
    expect(await handle("update alpha")).toMatch(/failed 0/);
  });
});
