// The countdown before a stop or restart, and the start that waits for Done. The unit-level tests write to a real FIFO with a reader
// held open, so each warning is read back exactly as a server's input would receive it. The echo of each warning is written into the
// log by a stand-in for Paper, as the server does. The real-unit test runs the fake Paper under the user manager and checks the
// warnings in its log. Units carry the jass-test- prefix and are removed in finally.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { Countdown, CountdownRegistry, type CancelResult } from "../../src/server/power/countdown.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { Readiness } from "../../src/server/power/readiness.js";
import { fifoPath, powerAction, warningMarks, type PowerDependencies } from "../../src/server/power/power.js";
import { addServer, Busy, removeServer, ServiceError } from "../../src/server/servers/service.js";
import { serviceFile, socketFile } from "../../src/server/servers/files.js";
import type { Runner, RunResult } from "../../src/server/systemd/run.js";
import { runProcess } from "../../src/server/systemd/run.js";

const FAKE_PAPER = fileURLToPath(new URL("../support/fake-paper.mjs", import.meta.url));
const ACTOR = { id: "owner-countdown", label: "owner@test" };

/** Cancels the countdown on alpha as the caller, naming it the way a page does: by the id the page was shown. */
function cancelShown(locks: OperationLocks, caller: { readonly id: string; readonly label: string }): CancelResult {
  return locks.countdowns.cancel("alpha", caller, locks.countdowns.describe("alpha")?.id ?? "no-countdown");
}
const INVOCATION = "0123456789abcdef0123456789abcdef";
const DONE = '[10:00:00 INFO]: Done (0.5s)! For help, type "help"';
const AVAILABLE = (() => {
  const out = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" }).stdout.trim();
  return out === "running" || out === "degraded";
})();

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let locks: OperationLocks;
let reader: number | null;

/** The unit's show block, as systemctl prints it for the server "alpha". */
function showBlock(activeState: string): string {
  return `Id=jass-mc-alpha.service\nActiveState=${activeState}\nSubState=x\nResult=success\nMainPID=1\nActiveEnterTimestamp=Sun 2026-10-11 08:00:00 CDT\nInvocationID=${INVOCATION}\n`;
}

/** A systemctl and journalctl stand-in: every call is recorded in order, and the unit reports the given active state. */
function fakeSystemd(activeState: string, events: string[], loaded = true): Runner {
  return (argv): Promise<RunResult> => {
    events.push(argv.join(" "));
    if (argv[0] === "journalctl") return Promise.resolve({ code: 0, signal: null, stdout: loaded ? `${DONE}\n` : "", stderr: "" });
    return Promise.resolve({ code: argv.includes("is-active") ? 3 : 0, signal: null, stdout: showBlock(activeState), stderr: "" });
  };
}

/** A unit that is inactive until it is started, then active, and prints Done (or not) when it is. */
function startingSystemd(events: string[], options: { loaded: boolean; afterStart?: string }): Runner {
  let running = false;
  return (argv): Promise<RunResult> => {
    events.push(argv.join(" "));
    if (argv[0] === "journalctl") return Promise.resolve({ code: 0, signal: null, stdout: options.loaded && running ? `${DONE}\n` : "", stderr: "" });
    if (argv.includes("start")) running = true;
    const state = running ? (options.afterStart ?? "active") : "inactive";
    return Promise.resolve({ code: argv.includes("is-active") ? 3 : 0, signal: null, stdout: showBlock(state), stderr: "" });
  };
}

/** A systemctl stand-in whose main process can be replaced between calls, as a crash restart or an in-game stop would do. */
function movingSystemd(events: string[], state: () => { activeState: string; mainPid: number }): Runner {
  return (argv): Promise<RunResult> => {
    events.push(argv.join(" "));
    if (argv[0] === "journalctl") return Promise.resolve({ code: 0, signal: null, stdout: `${DONE}\n`, stderr: "" });
    const current = state();
    const stdout = `Id=jass-mc-alpha.service\nActiveState=${current.activeState}\nSubState=x\nResult=success\nMainPID=${current.mainPid}\nActiveEnterTimestamp=Sun 2026-10-11 08:00:00 CDT\nInvocationID=${INVOCATION}\n`;
    return Promise.resolve({ code: argv.includes("is-active") ? 3 : 0, signal: null, stdout, stderr: "" });
  };
}

/** The power dependencies the unit-level tests share. The starter still holds the capability unless a test says otherwise. */
function powerDeps(run: Runner, extra: Partial<PowerDependencies> = {}): PowerDependencies {
  return {
    db,
    config,
    confirmWarning: false,
    run,
    locks,
    readiness: new Readiness(),
    sleep: () => Promise.resolve(),
    stillHolds: () => Promise.resolve({ holds: true }),
    ...extra,
  };
}

/** The open reader. A test that closes it on purpose calls closeReader, and any later use fails loudly rather than writing to fd -1. */
function readerFd(): number {
  if (reader === null) throw new Error("the test reader is already closed");
  return reader;
}

function closeReader(): void {
  if (reader !== null) closeSync(reader);
  reader = null;
}

/** Reads every line waiting in the FIFO without blocking. */
function drain(fd: number): string[] {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(4096);
  for (;;) {
    try {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") break;
      throw error;
    }
  }
  return Buffer.concat(chunks).toString("utf8").split("\n").filter((line) => line.length > 0);
}

/**
 * Stands in for Paper's reply to console input: each `say` is read from the FIFO and echoed into the log, as the server does, unless the
 * test skips that text. Returns the function that stops it.
 */
function echoingPaper(log: string, skip: (text: string) => boolean = () => false): () => void {
  const timer = setInterval(() => {
    for (const line of drain(readerFd())) {
      if (!line.startsWith("say ")) continue;
      const text = line.slice(4);
      if (!skip(text)) appendFileSync(log, `[10:00:00] [Server thread/INFO]: [Not Secure] [Server] ${text}\n`);
    }
  }, 5);
  return () => clearInterval(timer);
}

function auditRows(): { action: string; outcome: string; details: string | null }[] {
  return db.prepare("SELECT action, outcome, details FROM audit WHERE server_id = 'alpha' ORDER BY id").all() as {
    action: string;
    outcome: string;
    details: string | null;
  }[];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-countdown-"));
  mkdirSync(join(root, "run"), { recursive: true });
  mkdirSync(join(root, "alpha", "logs"), { recursive: true });
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data"), XDG_RUNTIME_DIR: join(root, "run") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  db.prepare(
    "INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES ('alpha', 'Alpha', ?, ?, 'logs/latest.log', 'now', 'now')",
  ).run(join(root, "alpha"), JSON.stringify(["/bin/true"]));
  locks = new OperationLocks();
  // A FIFO with a reader already open, so a write from the power path is delivered, as it is to a running server.
  const pipe = fifoPath(config.runtimeDir, "alpha");
  execFileSync("mkfifo", ["--", pipe]);
  reader = openSync(pipe, constants.O_RDONLY | constants.O_NONBLOCK);
});

afterEach(() => {
  closeReader();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the warning marks", () => {
  it("are the full countdown followed by the fixed marks below it", () => {
    expect(warningMarks(1)).toEqual([1]);
    expect(warningMarks(3)).toEqual([3, 2, 1]);
    expect(warningMarks(30)).toEqual([30, 10, 5, 4, 3, 2, 1]);
    expect(warningMarks(60)).toEqual([60, 30, 10, 5, 4, 3, 2, 1]);
    expect(warningMarks(300)).toEqual([300, 60, 30, 10, 5, 4, 3, 2, 1]);
  });
});

describe("a countdown before a stop or restart", () => {
  it("warns at each mark in order, waits between them, and only then stops the unit", async () => {
    const events: string[] = [];
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      events.push("sleep");
      return Promise.resolve();
    };
    const { outcome } = await powerAction(powerDeps(fakeSystemd("active", events), { sleep }), "alpha", "stop", ACTOR, { countdownSeconds: 3 });

    expect(outcome).toBe("done");
    expect(drain(readerFd())).toEqual(["say Server stopping in 3 seconds.", "say Server stopping in 2 seconds.", "say Server stopping in 1 second."]);
    expect(sleeps).toEqual([1000, 1000, 1000]);
    const lastSleep = events.lastIndexOf("sleep");
    const stop = events.findIndex((event) => event.includes("systemctl --user stop"));
    expect(stop).toBeGreaterThan(lastSleep);
    expect(auditRows().map((row) => `${row.action} ${row.outcome}`)).toEqual(["power.stop started", "power.stop ok"]);
    expect(JSON.parse(auditRows()[1]?.details ?? "null")).toEqual({ countdownSeconds: 3, warningsSent: 3, warningsDue: 3 });
  });

  it("holds the server's lock for the whole countdown, so a second operation is refused while players are warned", async () => {
    const events: string[] = [];
    let refusal: unknown = null;
    const sleep = async () => {
      if (refusal === null) {
        refusal = await powerAction(powerDeps(fakeSystemd("active", events)), "alpha", "restart", ACTOR).catch((error: unknown) => error);
      }
    };
    await powerAction(powerDeps(fakeSystemd("active", events), { sleep }), "alpha", "stop", ACTOR, { countdownSeconds: 2 });
    expect(refusal).toBeInstanceOf(ServiceError);
    expect((refusal as ServiceError).message).toMatch(/Another operation \(stop\)/);
  });

  it("refuses when the first warning cannot be delivered, and stops nothing", async () => {
    closeReader();
    const events: string[] = [];
    await expect(powerAction(powerDeps(fakeSystemd("active", events)), "alpha", "stop", ACTOR, { countdownSeconds: 5 })).rejects.toThrow(/could not be warned/);
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(false);
    expect(auditRows().map((row) => `${row.action} ${row.outcome}`)).toEqual(["power.stop started", "power.stop failed"]);
  });

  it("refuses to stop when a later warning cannot be delivered, and counts the warnings it did send", async () => {
    const events: string[] = [];
    let first = true;
    const sleep = () => {
      if (first) {
        first = false;
        drain(readerFd());
        closeReader();
      }
      return Promise.resolve();
    };
    await expect(powerAction(powerDeps(fakeSystemd("active", events), { sleep }), "alpha", "stop", ACTOR, { countdownSeconds: 3 })).rejects.toThrow(/could not be warned/);
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(false);
    expect(JSON.parse(auditRows()[1]?.details ?? "null")).toEqual({ countdownSeconds: 3, warningsSent: 1, warningsDue: 3 });
  });

  it("restarts with the same warnings, then starts the unit again, and reports the restart as done once it has loaded", async () => {
    const events: string[] = [];
    const { outcome } = await powerAction(powerDeps(fakeSystemd("active", events)), "alpha", "restart", ACTOR, { countdownSeconds: 2 });
    expect(outcome).toBe("done");
    expect(drain(readerFd())).toEqual(["say Server restarting in 2 seconds.", "say Server restarting in 1 second."]);
    const stop = events.findIndex((event) => event.includes("systemctl --user stop"));
    const start = events.findIndex((event) => event.includes("systemctl --user start"));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(stop);
  });

  it("refuses a countdown on a server that is not running", async () => {
    await expect(powerAction(powerDeps(fakeSystemd("inactive", [])), "alpha", "stop", ACTOR, { countdownSeconds: 5 })).rejects.toThrow(/not running/);
  });

  it("refuses a countdown on a start", async () => {
    await expect(powerAction(powerDeps(fakeSystemd("inactive", [])), "alpha", "start", ACTOR, { countdownSeconds: 5 })).rejects.toBeInstanceOf(ServiceError);
  });

  it("refuses a countdown on a server that has not printed its Done line, and warns nobody", async () => {
    await expect(powerAction(powerDeps(fakeSystemd("active", [], false)), "alpha", "stop", ACTOR, { countdownSeconds: 5 })).rejects.toThrow(/still loading/);
    expect(drain(readerFd())).toEqual([]);
  });
});

describe("confirming each warning", () => {
  it("stops only after every warning has been echoed in the server's log", async () => {
    const log = join(root, "alpha", "logs", "latest.log");
    const stopEcho = echoingPaper(log);
    try {
      const { outcome } = await powerAction(powerDeps(fakeSystemd("active", []), { confirmWarning: true }), "alpha", "stop", ACTOR, { countdownSeconds: 3 });
      expect(outcome).toBe("done");
    } finally {
      stopEcho();
    }
    const echoed = readFileSync(log, "utf8");
    expect(echoed).toContain("[Not Secure] [Server] Server stopping in 3 seconds.");
    expect(echoed).toContain("[Not Secure] [Server] Server stopping in 2 seconds.");
    expect(echoed).toContain("[Not Secure] [Server] Server stopping in 1 second.");
    expect(JSON.parse(auditRows()[1]?.details ?? "null")).toEqual({ countdownSeconds: 3, warningsSent: 3, warningsDue: 3 });
  });

  it("refuses to stop when a later warning is not echoed, and says why", async () => {
    const log = join(root, "alpha", "logs", "latest.log");
    const stopEcho = echoingPaper(log, (text) => text === "Server stopping in 2 seconds.");
    const events: string[] = [];
    try {
      await expect(
        powerAction(powerDeps(fakeSystemd("active", events), { confirmWarning: true, warningEchoMs: 200 }), "alpha", "stop", ACTOR, { countdownSeconds: 3 }),
      ).rejects.toThrow(/did not show the warning/);
    } finally {
      stopEcho();
    }
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(false);
    expect(JSON.parse(auditRows()[1]?.details ?? "null")).toEqual({ countdownSeconds: 3, warningsSent: 2, warningsDue: 3 });
  });
});

describe("cancelling a countdown", () => {
  it("a cancel during the wait stops nothing, tells the players, and answers cancelled", async () => {
    const events: string[] = [];
    let cancelResult: string | null = null;
    const sleep = () => {
      cancelResult = cancelShown(locks, { id: ACTOR.id, label: ACTOR.label });
      return Promise.resolve();
    };
    const { outcome } = await powerAction(powerDeps(fakeSystemd("active", events), { sleep }), "alpha", "stop", ACTOR, { countdownSeconds: 3 });

    expect(cancelResult).toBe("cancelled");
    expect(outcome).toBe("cancelled");
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(false);
    expect(drain(readerFd())).toEqual(["say Server stopping in 3 seconds.", "say The planned stop was cancelled."]);
    expect(auditRows().map((row) => `${row.action} ${row.outcome}`)).toEqual(["power.stop started", "power.stop cancelled"]);
    expect(JSON.parse(auditRows()[1]?.details ?? "null")).toEqual({ countdownSeconds: 3, warningsSent: 1, warningsDue: 3, cancelledBy: ACTOR.label });
    expect(locks.holder("alpha")).toBeNull();
    expect(cancelShown(locks, { id: ACTOR.id, label: ACTOR.label })).toBe("none");
  });

  it("lets any holder of power cancel a scheduled countdown, and the audit row names who did", async () => {
    const events: string[] = [];
    let cancelResult: string | null = null;
    const sleep = () => {
      cancelResult = cancelShown(locks, { id: "power-holder", label: "holder@test" });
      return Promise.resolve();
    };
    const { outcome } = await powerAction(powerDeps(fakeSystemd("active", events), { sleep }), "alpha", "stop", ACTOR, { countdownSeconds: 3, scheduled: true });
    expect(cancelResult).toBe("cancelled");
    expect(outcome).toBe("cancelled");
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(false);
    expect(JSON.parse(auditRows()[1]?.details ?? "null")).toMatchObject({ cancelledBy: "holder@test" });
  });

  it("a cancel by someone who did not start the countdown is refused, and the countdown goes on", async () => {
    const events: string[] = [];
    let other: string | null = null;
    const sleep = () => {
      other = cancelShown(locks, { id: "someone-else", label: "someone@test" });
      return Promise.resolve();
    };
    const { outcome } = await powerAction(powerDeps(fakeSystemd("active", events), { sleep }), "alpha", "stop", ACTOR, { countdownSeconds: 2 });
    expect(other).toBe("not_starter");
    expect(outcome).toBe("done");
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(true);
  });

  it("a cancel that names an earlier countdown is stale, and the countdown running on the server goes on", async () => {
    const events: string[] = [];
    let stale: CancelResult | null = null;
    const sleep = () => {
      stale = locks.countdowns.cancel("alpha", { id: ACTOR.id, label: ACTOR.label }, "00000000-0000-4000-8000-000000000000");
      return Promise.resolve();
    };
    const { outcome } = await powerAction(powerDeps(fakeSystemd("active", events), { sleep }), "alpha", "stop", ACTOR, { countdownSeconds: 2 });
    expect(stale).toBe("stale");
    expect(outcome).toBe("done");
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(true);
  });

  it("a cancel that arrives once the stop has begun is refused, and the stop is not undone", async () => {
    const events: string[] = [];
    const base = fakeSystemd("active", events);
    let late: string | null = null;
    const run: Runner = (argv, options) => {
      if (argv.includes("stop")) late = cancelShown(locks, { id: ACTOR.id, label: ACTOR.label });
      return base(argv, options);
    };
    const { outcome } = await powerAction(powerDeps(run), "alpha", "stop", ACTOR, { countdownSeconds: 1 });
    expect(late).toBe("too_late");
    expect(outcome).toBe("done");
  });

  it("the registry answers for a countdown only while it is attached, and only for its starter", () => {
    const registry = new CountdownRegistry();
    const countdown = new Countdown("alpha", ACTOR.id, "stop", false, { sent: 0, due: 0 });
    expect(registry.cancel("alpha", { id: ACTOR.id, label: ACTOR.label }, countdown.id)).toBe("none");
    registry.attach(countdown);
    expect(registry.cancel("alpha", { id: ACTOR.id, label: ACTOR.label }, "not-the-countdown")).toBe("stale");
    expect(registry.cancel("alpha", { id: "someone-else", label: "someone@test" }, countdown.id)).toBe("not_starter");
    expect(countdown.beginStop()).toBe(true);
    expect(registry.cancel("alpha", { id: ACTOR.id, label: ACTOR.label }, countdown.id)).toBe("too_late");
    registry.detach(countdown);
    expect(registry.cancel("alpha", { id: ACTOR.id, label: ACTOR.label }, countdown.id)).toBe("none");
  });
});

describe("the end of a countdown", () => {
  it("does not stop a server when the starter no longer holds the capability, and tells the players", async () => {
    const events: string[] = [];
    const deps = powerDeps(fakeSystemd("active", events), { stillHolds: () => Promise.resolve({ holds: false, reason: "the person no longer holds the needed capability" }) });
    const failure = await powerAction(deps, "alpha", "stop", ACTOR, { countdownSeconds: 2 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceError);
    expect((failure as ServiceError).code).toBe("forbidden");
    expect((failure as ServiceError).message).toMatch(/no longer holds/);
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(false);
    expect(drain(readerFd())).toEqual(["say Server stopping in 2 seconds.", "say Server stopping in 1 second.", "say The planned stop was cancelled."]);
    expect(auditRows().map((row) => `${row.action} ${row.outcome}`)).toEqual(["power.stop started", "power.stop denied"]);
  });

  it("asks the panel whether the starter still holds the capability, for the starter and nobody else", async () => {
    const asked: string[] = [];
    await powerAction(powerDeps(fakeSystemd("active", []), { stillHolds: (userId) => (asked.push(userId), Promise.resolve({ holds: true })) }), "alpha", "stop", ACTOR, {
      countdownSeconds: 1,
    });
    expect(asked).toEqual([ACTOR.id]);
  });
});

describe("a countdown that cannot be trusted to finish", () => {
  it("refuses when the first warning never appears in the server's log, and stops nothing", async () => {
    const events: string[] = [];
    await expect(
      powerAction(powerDeps(fakeSystemd("active", events), { confirmWarning: true, warningEchoMs: 300 }), "alpha", "stop", ACTOR, { countdownSeconds: 3 }),
    ).rejects.toThrow(/did not show the warning/);
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(false);
    expect(JSON.parse(auditRows()[1]?.details ?? "null")).toEqual({ countdownSeconds: 3, warningsSent: 1, warningsDue: 3 });
  });

  it("does not stop a server whose main process changed during the wait", async () => {
    const events: string[] = [];
    let pid = 111;
    const sleep = () => {
      pid = 222;
      return Promise.resolve();
    };
    await expect(
      powerAction(powerDeps(movingSystemd(events, () => ({ activeState: "active", mainPid: pid })), { sleep }), "alpha", "stop", ACTOR, { countdownSeconds: 2 }),
    ).rejects.toThrow(/changed during the countdown/);
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(false);
    expect(auditRows().map((row) => row.outcome)).toEqual(["started", "failed"]);
  });

  it("is abandoned when the daemon stops during the countdown, and the server keeps running", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const sleep = () => {
      controller.abort();
      return Promise.resolve();
    };
    await expect(
      powerAction(powerDeps(fakeSystemd("active", events), { sleep }), "alpha", "stop", ACTOR, { countdownSeconds: 60, signal: controller.signal }),
    ).rejects.toThrow(/abandoned/);
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(false);
    expect(JSON.parse(auditRows()[1]?.details ?? "null")).toEqual({ countdownSeconds: 60, warningsSent: 1, warningsDue: 8 });
    expect(locks.holder("alpha")).toBeNull();
  });
});

describe("a countdown whose server stops on its own", () => {
  it("writes no later warning, because a write into the socket would start the stopped server again", async () => {
    const events: string[] = [];
    let active = true;
    const run: Runner = (argv): Promise<RunResult> => {
      events.push(argv.join(" "));
      if (argv[0] === "journalctl") return Promise.resolve({ code: 0, signal: null, stdout: `${DONE}\n`, stderr: "" });
      const state = active ? "active" : "inactive";
      const stdout = `Id=jass-mc-alpha.service\nActiveState=${state}\nSubState=x\nResult=success\nMainPID=1\nActiveEnterTimestamp=Sun 2026-10-11 08:00:00 CDT\nInvocationID=${INVOCATION}\n`;
      return Promise.resolve({ code: argv.includes("is-active") ? 3 : 0, signal: null, stdout, stderr: "" });
    };
    const sleep = () => {
      active = false;
      return Promise.resolve();
    };
    await expect(powerAction(powerDeps(run, { sleep }), "alpha", "stop", ACTOR, { countdownSeconds: 3 })).rejects.toThrow(/changed during the countdown/);
    expect(drain(readerFd())).toEqual(["say Server stopping in 3 seconds."]);
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(false);
  });
});

describe("a start and its Done line", () => {
  it("returns done once the run has printed its Done line", async () => {
    const events: string[] = [];
    const { outcome, state } = await powerAction(powerDeps(startingSystemd(events, { loaded: true })), "alpha", "start", ACTOR);
    expect(outcome).toBe("done");
    expect(state.known && state.state.loaded).toBe(true);
    expect(auditRows().map((row) => `${row.action} ${row.outcome}`)).toEqual(["power.start started", "power.start ok"]);
  });

  it("returns done when the Done line appears on a later poll, not only the first", async () => {
    const events: string[] = [];
    let running = false;
    let journalCalls = 0;
    const run: Runner = (argv): Promise<RunResult> => {
      events.push(argv.join(" "));
      if (argv[0] === "journalctl") {
        journalCalls += 1;
        return Promise.resolve({ code: 0, signal: null, stdout: journalCalls >= 3 ? `${DONE}\n` : "", stderr: "" });
      }
      if (argv.includes("start")) running = true;
      return Promise.resolve({ code: argv.includes("is-active") ? 3 : 0, signal: null, stdout: showBlock(running ? "active" : "inactive"), stderr: "" });
    };
    // Each look is later than the window in which a run that has not loaded is not asked about again.
    let clock = 0;
    const { outcome } = await powerAction(powerDeps(run, { readiness: new Readiness({ now: () => (clock += 3000) }), loadPollMs: 1 }), "alpha", "start", ACTOR);
    expect(outcome).toBe("done");
    expect(journalCalls).toBe(3);
  });

  it("reports not_loaded when no Done line comes within the window, and leaves the unit running", async () => {
    const events: string[] = [];
    const { outcome, state } = await powerAction(
      powerDeps(startingSystemd(events, { loaded: false }), { loadWindowMs: 30, loadPollMs: 5 }),
      "alpha",
      "start",
      ACTOR,
    );
    expect(outcome).toBe("not_loaded");
    expect(state.known && state.state.activeState).toBe("active");
    expect(state.known && state.state.loaded).toBe(false);
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(false);
    expect(auditRows().map((row) => `${row.action} ${row.outcome} ${row.details ?? ""}`)).toEqual(["power.start started ", 'power.start ok {"loaded":false}']);
  });

  it("is refused when the unit stops while it is still loading, because it will never print Done", async () => {
    const events: string[] = [];
    await expect(powerAction(powerDeps(startingSystemd(events, { loaded: false, afterStart: "failed" }), { loadPollMs: 5 }), "alpha", "start", ACTOR)).rejects.toThrow(
      /stopped while it was starting/,
    );
  });
});

describe.skipIf(!AVAILABLE)("a countdown against a real unit", () => {
  it("delivers the warnings to the server's input, then stops it, and the server exits 143", async () => {
    const id = "jass-test-countdown";
    const realConfig = loadConfig(
      {
        PANEL_PUBLIC_ORIGIN: "https://example.net",
        PANEL_DATA_DIR: join(root, "data"),
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "/tmp", ".config"),
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`,
      },
      { uid: process.getuid?.() ?? 0 },
    );
    const directory = join(root, id);
    mkdirSync(directory, { recursive: true });
    mkdirSync(realConfig.unitDir, { recursive: true });
    const spec = {
      id,
      displayName: id,
      directory,
      logPath: "logs/latest.log",
      autostart: false,
      command: { kind: "custom" as const, argv: [process.execPath, FAKE_PAPER] },
    };
    const deps = { db, config: realConfig, run: runProcess, locks, readiness: new Readiness(), stillHolds: () => Promise.resolve({ holds: true as const }) };
    try {
      await addServer({ db, config: realConfig, run: runProcess }, spec, ACTOR);
      await powerAction(deps, id, "start", ACTOR);
      const { state } = await powerAction(deps, id, "stop", ACTOR, { countdownSeconds: 2 });
      expect(state.known && state.state.activeState).toBe("inactive");
      const log = readFileSync(join(directory, "logs", "latest.log"), "utf8");
      expect(log).toContain("[Server] Server stopping in 2 seconds.");
      expect(log).toContain("[Server] Server stopping in 1 second.");
    } finally {
      await removeServer({ db, config: realConfig, run: runProcess, now: () => new Date() }, id, ACTOR).catch(() => undefined);
      await runProcess(["systemctl", "--user", "stop", "--", `jass-mc-${id}.service`], { timeoutMs: 130_000 });
      await runProcess(["systemctl", "--user", "disable", "--", `jass-mc-${id}.service`]);
      rmSync(serviceFile(realConfig.unitDir, id), { force: true });
      rmSync(socketFile(realConfig.unitDir, id), { force: true });
      await runProcess(["systemctl", "--user", "daemon-reload"]);
    }
  }, 60_000);
});

describe("a stop that ends a start still waiting for its Done line", () => {
  it("ends the wait, refuses the start, and lets the stop go ahead once the start has released the lock", async () => {
    const events: string[] = [];
    const base = startingSystemd(events, { loaded: false });
    const stops: Promise<unknown>[] = [];
    // The stop arrives while the start is waiting. It is started here and not awaited: it waits for the start to release the lock.
    const sleep = (): Promise<void> => {
      if (stops.length === 0) stops.push(powerAction(powerDeps(base), "alpha", "stop", ACTOR));
      return Promise.resolve();
    };
    const start = await powerAction(powerDeps(base, { sleep, loadPollMs: 1, loadWindowMs: 60_000 }), "alpha", "start", ACTOR).catch((error: unknown) => error);
    expect(start).toBeInstanceOf(ServiceError);
    expect((start as ServiceError).message).toMatch(/ended the start/);

    const stopped = (await stops[0]) as { outcome: string };
    expect(stopped.outcome).toBe("done");
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(true);
    expect(auditRows().map((row) => `${row.action} ${row.outcome}`)).toEqual(["power.start started", "power.start failed", "power.stop started", "power.stop ok"]);
    expect(JSON.parse(auditRows()[1]?.details ?? "null")).toEqual({ interruptedLoad: true });
    expect(JSON.parse(auditRows()[3]?.details ?? "null")).toEqual({ interruptedLoad: true });
    expect(locks.holder("alpha")).toBeNull();
  });

  it("does not interrupt a start for a stop that carries a warning, which the server could not take while loading", async () => {
    const events: string[] = [];
    const base = startingSystemd(events, { loaded: false });
    let refused: unknown = null;
    const sleep = async (): Promise<void> => {
      if (refused === null) refused = await powerAction(powerDeps(base), "alpha", "stop", ACTOR, { countdownSeconds: 30 }).catch((error: unknown) => error);
    };
    const start = await powerAction(powerDeps(base, { sleep, loadPollMs: 1, loadWindowMs: 40 }), "alpha", "start", ACTOR);
    expect(start.outcome).toBe("not_loaded");
    expect(refused).toBeInstanceOf(Busy);
    expect(events.some((event) => event.includes("systemctl --user stop"))).toBe(false);
  });
});

describe("a stop that arrives as the server finishes loading", () => {
  it("does not count the start as cut short when the server had already printed its Done line", async () => {
    const events: string[] = [];
    let printed = false;
    let started = false;
    // The claim is kept in a variable that the sleep sets, so the type is asserted rather than narrowed to null.
    let handed = null as Promise<{ readonly release: () => void; readonly cutShort: boolean } | null> | null;
    const run: Runner = (argv) => {
      events.push(argv.join(" "));
      if (argv[0] === "journalctl") return Promise.resolve({ code: 0, signal: null, stdout: printed ? `${DONE}\n` : "", stderr: "" });
      if (argv.includes("start")) started = true;
      const code = argv.includes("is-active") ? 3 : 0;
      return Promise.resolve({ code, signal: null, stdout: showBlock(started ? "active" : "inactive"), stderr: "" });
    };
    // The start reads the journal, finds no Done line, and sleeps. During that sleep the server prints Done and a stop claims the wait.
    const sleep = () => {
      printed = true;
      handed = locks.interruptLoadWait("alpha", "stop");
      return Promise.resolve();
    };
    const { outcome } = await powerAction(powerDeps(run, { sleep, loadWindowMs: 60_000 }), "alpha", "start", ACTOR);
    expect(outcome).toBe("done");
    const stop = await handed;
    expect(stop?.cutShort).toBe(false);
    stop?.release();
    expect(auditRows().map((row) => `${row.action} ${row.outcome}`)).toEqual(["power.start started", "power.start ok"]);
    expect(auditRows()[1]?.details).toBeNull();
  });
});

describe("a start whose start command fails", () => {
  it("is a failure of work that began, not a refusal, so a schedule that fires it reports a failure", async () => {
    const events: string[] = [];
    const base = fakeSystemd("inactive", events, false);
    const run: Runner = (argv, options) =>
      argv.includes("start") ? Promise.resolve({ code: 1, signal: null, stdout: "", stderr: "" }) : base(argv, options);
    await expect(powerAction(powerDeps(run), "alpha", "start", ACTOR)).rejects.toMatchObject({ code: "conflict", began: true });
    expect(auditRows().at(-1)?.outcome).toBe("failed");
  });
});

describe("the countdown a page is shown", () => {
  it("tells a scheduled countdown from a person's, and counts the warnings sent so far", async () => {
    const events: string[] = [];
    let seen: unknown = null;
    // The first wait is the one that sees the first warning, so only its answer is kept.
    const sleep = () => {
      if (seen === null) seen = locks.countdowns.describe("alpha");
      return Promise.resolve();
    };
    await powerAction(powerDeps(fakeSystemd("active", events), { sleep }), "alpha", "stop", ACTOR, { countdownSeconds: 2, scheduled: true });
    expect(seen).toMatchObject({ action: "stop", scheduled: true, starterId: ACTOR.id, warningsSent: 1, warningsDue: 2 });
    expect(locks.countdowns.describe("alpha")).toBeNull();
  });
});
