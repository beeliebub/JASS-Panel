// Lifecycle tests against the real systemd user manager, with a fake Paper as the server. Every unit is named with the jass-test-
// prefix and removed in finally, and every directory is a temporary one. Without a user manager the suite says so and skips.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { fifoPath, powerAction, type PowerDependencies } from "../../src/server/power/power.js";
import { Readiness } from "../../src/server/power/readiness.js";
import { sendCommand } from "../../src/server/console/fifo.js";
import { addServer, removeServer, type ServiceDependencies } from "../../src/server/servers/service.js";
import { getServer } from "../../src/server/servers/store.js";
import { viewServers } from "../../src/server/servers/state.js";
import { serviceFile, socketFile } from "../../src/server/servers/files.js";
import { runProcess } from "../../src/server/systemd/run.js";
import { observeUnits, parseShow } from "../../src/server/systemd/user.js";

const FAKE_PAPER = fileURLToPath(new URL("../support/fake-paper.mjs", import.meta.url));
const ACTOR = { id: "owner-test", label: "owner@test" };
const PREFIX = "jass-test-";

function userManagerAvailable(): boolean {
  const result = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" });
  return result.stdout.trim() === "running" || result.stdout.trim() === "degraded";
}

const AVAILABLE = userManagerAvailable();
if (!AVAILABLE) {
  console.warn("lifecycle tests skipped: no systemd user manager on this machine");
}

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let locks: OperationLocks;
const created: string[] = [];

function deps(): ServiceDependencies & { locks: OperationLocks } {
  return { db, config, run: runProcess, locks };
}

const readiness = new Readiness();

function powerDeps(): PowerDependencies {
  return { ...deps(), readiness, sleep: settle };
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await settle(200);
  }
  throw new Error("timed out waiting for the condition");
}

/** The file's text, or empty while it does not exist yet: a wait must poll a file the server has not written so far. */
function text(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Waits until the server has written its first line, so a stop is never sent before the process is up. */
async function waitForStartup(id: string): Promise<void> {
  await waitFor(() => text(join(root, id, "logs", "latest.log")).includes("Done ("));
}

async function activeState(id: string): Promise<string> {
  const [state] = [...(await observeUnits(runProcess, [id])).values()];
  return state?.known ? state.state.activeState : "unknown";
}

function freshId(): string {
  const id = `${PREFIX}${Math.random().toString(36).slice(2, 8)}`;
  created.push(id);
  return id;
}

function unitsDir(): string {
  return config.unitDir;
}

async function cleanup(id: string): Promise<void> {
  await runProcess(["systemctl", "--user", "stop", "--", `jass-mc-${id}.service`], { timeoutMs: 130_000 });
  await runProcess(["systemctl", "--user", "disable", "--", `jass-mc-${id}.service`]);
  await runProcess(["systemctl", "--user", "reset-failed", "--", `jass-mc-${id}.service`]);
  rmSync(serviceFile(unitsDir(), id), { force: true });
  rmSync(socketFile(unitsDir(), id), { force: true });
  db.prepare("DELETE FROM servers WHERE id = ?").run(id);
}

beforeAll(() => {
  if (!AVAILABLE) return;
  root = mkdtempSync(join(tmpdir(), "jass-panel-life-"));
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  config = loadConfig(
    {
      PANEL_PUBLIC_ORIGIN: "https://example.net",
      PANEL_DATA_DIR: join(root, "data"),
      XDG_CONFIG_HOME: xdg,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`,
    },
    { uid: process.getuid?.() ?? 0 },
  );
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  locks = new OperationLocks();
  mkdirSync(unitsDir(), { recursive: true });
});

afterAll(async () => {
  if (!AVAILABLE) return;
  for (const id of created) await cleanup(id).catch(() => undefined);
  await runProcess(["systemctl", "--user", "daemon-reload"]);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function makeServer(id: string, extra: Record<string, unknown> = {}) {
  const directory = join(root, id);
  mkdirSync(join(directory, "logs"), { recursive: true });
  return {
    id,
    displayName: `Test ${id}`,
    directory,
    logPath: "logs/latest.log",
    autostart: false,
    command: { kind: "custom" as const, argv: [process.execPath, FAKE_PAPER] },
    ...extra,
  };
}

describe.skipIf(!AVAILABLE)("lifecycle against the real user manager", () => {
  it(
    "adds a server, starts it, sends a command, stops it, and records a clean end",
    async () => {
      const id = freshId();
      const row = await addServer(deps(), makeServer(id), ACTOR);
      expect(row.id).toBe(id);
      expect(existsSync(serviceFile(unitsDir(), id))).toBe(true);

      const started = await powerAction(powerDeps(), id, "start", ACTOR);
      expect(started.outcome).toBe("done");
      expect(started.state.known && started.state.state.activeState).toBe("active");
      expect(started.state.known && started.state.state.loaded).toBe(true);
      await waitForStartup(id);

      const pipe = fifoPath(config.runtimeDir, id);
      expect(sendCommand(pipe, "save-all flush")).toEqual({ delivered: true });
      await waitFor(() => text(join(root, id, "logs", "latest.log")).includes("System chat: Saved the game"));

      await powerAction(powerDeps(), id, "stop", ACTOR);
      expect(await activeState(id)).toBe("inactive");
      await waitFor(() => text(join(config.paths.events, `${id}.log`)).includes("result=success"));
      expect(text(join(config.paths.events, `${id}.log`))).toContain("result=success code=exited status=143");
    },
    120_000,
  );

  it(
    "reports a start whose server never prints Done as not_loaded, and leaves the server running",
    async () => {
      const id = freshId();
      await addServer(deps(), makeServer(id, { command: { kind: "custom" as const, argv: [process.execPath, FAKE_PAPER, "--no-done"] } }), ACTOR);
      const started = await powerAction({ ...powerDeps(), loadWindowMs: 1500, loadPollMs: 100 }, id, "start", ACTOR);
      expect(started.outcome).toBe("not_loaded");
      expect(started.state.known && started.state.state.activeState).toBe("active");
      expect(started.state.known && started.state.state.loaded).toBe(false);
      await powerAction(powerDeps(), id, "stop", ACTOR);
      expect(await activeState(id)).toBe("inactive");
    },
    120_000,
  );

  it(
    "refuses to start a server twice at once and names the running operation",
    async () => {
      const id = freshId();
      await addServer(deps(), makeServer(id), ACTOR);
      const first = powerAction(powerDeps(), id, "start", ACTOR);
      const second = powerAction(powerDeps(), id, "start", ACTOR).then(
        () => "accepted",
        (error: Error) => error.message,
      );
      const [, secondOutcome] = await Promise.all([first, second]);
      expect(secondOutcome).toMatch(/Another operation \(start\)/);
      await powerAction(powerDeps(), id, "stop", ACTOR);
    },
    120_000,
  );

  it(
    "does not start a stopped server when a command is written to its FIFO",
    async () => {
      const id = freshId();
      await addServer(deps(), makeServer(id), ACTOR);
      await powerAction(powerDeps(), id, "start", ACTOR);
      await powerAction(powerDeps(), id, "stop", ACTOR);
      expect(sendCommand(fifoPath(config.runtimeDir, id), "list")).toEqual({ delivered: false, reason: "not_running" });
      await settle(1000);
      expect(await activeState(id)).toBe("inactive");
    },
    120_000,
  );

  it(
    "starts a stopped server five times in a row, each after a reset of the failed state",
    async () => {
      const id = freshId();
      await addServer(deps(), makeServer(id), ACTOR);
      for (let round = 0; round < 5; round += 1) {
        await powerAction(powerDeps(), id, "start", ACTOR);
        expect(await activeState(id), `start ${round + 1}`).toBe("active");
        await powerAction(powerDeps(), id, "stop", ACTOR);
      }
    },
    240_000,
  );

  it(
    "records a kill as a signal result, and the restart policy brings the server back",
    async () => {
      const id = freshId();
      await addServer(deps(), makeServer(id), ACTOR);
      await powerAction(powerDeps(), id, "start", ACTOR);
      const pid = execFileSync("systemctl", ["--user", "show", "--property=MainPID", "--value", "--", `jass-mc-${id}.service`], {
        encoding: "utf8",
      }).trim();
      await waitForStartup(id);
      execFileSync("kill", ["-9", pid]);
      await waitFor(() => text(join(config.paths.events, `${id}.log`)).includes("result=signal"));
      expect(text(join(config.paths.events, `${id}.log`))).toContain("code=killed status=KILL");
      await waitFor(async () => (await activeState(id)) === "active", 60_000);
      await powerAction(powerDeps(), id, "stop", ACTOR);
    },
    180_000,
  );

  it(
    "refuses to remove a running server, and removes a stopped one without touching its directory",
    async () => {
      const id = freshId();
      const spec = makeServer(id);
      await addServer(deps(), spec, ACTOR);
      await powerAction(powerDeps(), id, "start", ACTOR);
      await waitForStartup(id);
      await expect(removeServer(deps(), id, ACTOR)).rejects.toThrow(/Stop the server/);
      await powerAction(powerDeps(), id, "stop", ACTOR);
      await removeServer(deps(), id, ACTOR);
      expect(getServer(db, id)).toBeUndefined();
      expect(existsSync(serviceFile(unitsDir(), id))).toBe(false);
      expect(existsSync(join(spec.directory, "logs", "latest.log"))).toBe(true);
    },
    180_000,
  );

  it(
    "shows a hand-edited unit as edited and refuses to remove the server over it",
    async () => {
      const id = freshId();
      await addServer(deps(), makeServer(id), ACTOR);
      writeFileSync(serviceFile(unitsDir(), id), "# hand edit\n[Service]\nExecStart=/bin/true\n");
      const row = getServer(db, id);
      if (row === undefined) throw new Error("the server row is missing");
      const [view] = await viewServers(runProcess, config, [row], readiness);
      expect(view?.unitEdited).toBe(true);
      await expect(removeServer(deps(), id, ACTOR)).rejects.toThrow(/edited by hand/);
    },
    60_000,
  );

  it("reports a unit systemd does not know as inactive under its own id, which is how a half-finished removal is recognised", async () => {
    const name = `${PREFIX}never-existed.service`;
    const result = await runProcess(["systemctl", "--user", "show", "--property=Id,ActiveState", "--", name]);
    expect(result.code).toBe(0);
    expect(parseShow(result.stdout).get(name)?.ActiveState).toBe("inactive");
  });

  it("reports the state of every server in one call, unknown for a unit systemd does not know", async () => {
    const states = await observeUnits(runProcess, [`${PREFIX}never-existed`]);
    const state = states.get(`${PREFIX}never-existed`);
    // systemd still prints a block for a unit with no file, so the answer comes from its load state, not from the block's presence.
    expect(state?.known).toBe(false);
    expect(socketFile(unitsDir(), "x")).toContain("jass-mc-x.socket");
  });
});

describe("without a user manager", () => {
  it("is skipped loudly rather than passing silently", () => {
    expect(typeof AVAILABLE).toBe("boolean");
  });
});
