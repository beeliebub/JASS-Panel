import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allFixtureFiles, findFixtureProblems, findIdentifierProblems, FIXTURES_DIR, fixtureLines } from "./fixtures.js";

/** Sample values are built at run time so this file holds no address, UUID or id that the scan would flag. */
const sample = {
  ip: ["198", "18", "0", "5"].join("."),
  uuid: ["123e4567", "e89b", "42d3", "a456", "426614174000"].join("-"),
  snowflake: "1234567890".concat("12345678"),
};

function testTreeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : testTreeFiles(path);
    return /.(ts|txt|md)$/.test(name) ? [path] : [];
  });
}

describe("fixture privacy scan", () => {
  it("finds no public address, real UUID or long numeric id anywhere in the test tree, source included", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    for (const file of testTreeFiles(root)) {
      expect(findIdentifierProblems(readFileSync(file, "utf8")), relative(root, file)).toEqual([]);
    }
  });

  it("finds nothing that must not be committed in any fixture", () => {
    // Captured data only; the READMEs and the capture instructions describe what must not appear.
    const files = allFixtureFiles().filter((file) => file.endsWith(".txt"));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const problems = findFixtureProblems(readFileSync(file, "utf8"));
      expect(problems, relative(FIXTURES_DIR, file)).toEqual([]);
    }
  });

  it("would catch a leaked address, UUID, snowflake, credential or home path (the scan itself is tested)", () => {
    expect(findFixtureProblems(`player at ${sample.ip}:62517`)).toHaveLength(1);
    expect(findFixtureProblems(`UUID of player X is ${sample.uuid}`)).toHaveLength(1);
    expect(findFixtureProblems(`channel(${sample.snowflake})`)).toHaveLength(1);
    expect(findFixtureProblems("rcon.password=hunter2")).not.toHaveLength(0);
    expect(findFixtureProblems("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).not.toHaveLength(0);
    expect(findFixtureProblems("at /home/someone/Minecraft/Main")).toHaveLength(1);
    expect(findFixtureProblems("connect 127.0.0.1:25575 and 203.0.113.10")).toEqual([]);
  });
});

describe("fixtures hold the real formats the fake server must reproduce", () => {
  const startup = fixtureLines("latest-log/startup-main.txt");
  const players = fixtureLines("latest-log/players-main.txt");
  const shutdown = fixtureLines("latest-log/shutdown-main.txt");

  it("start-up ends its boot with the readiness line", () => {
    expect(startup.some((line) => /\[Server thread\/INFO\]: Done \(\d+\.\d{3}s\)! For help, type "help"$/.test(line))).toBe(true);
  });

  it("lines carry a time of day and no date", () => {
    const timed = startup.filter((line) => line.startsWith("["));
    expect(timed.length).toBeGreaterThan(30);
    for (const line of timed) expect(line).toMatch(/^\[\d\d:\d\d:\d\d\] \[[^\]]+\/(INFO|WARN|ERROR)\]: /);
  });

  it("has multi-line records: stack frames without a prefix", () => {
    expect(startup.some((line) => line.startsWith("\tat "))).toBe(true);
    expect(startup.some((line) => line.startsWith("Caused by: "))).toBe(true);
    expect(startup.some((line) => line.startsWith(" - "))).toBe(true);
  });

  it("logs joins and leaves twice, in two shapes", () => {
    expect(players.some((l) => l.endsWith("System chat: PlayerTwo left the game"))).toBe(true);
    // The plugins prefix a private-use glyph (a rank badge) before the name: parsers must tolerate it.
    expect(players.some((l) => /]: [-]? ?PlayerTwo joined$/.test(l))).toBe(true);
    expect(players.some((l) => /[-]/.test(l))).toBe(true);
  });

  it("logs chat from the async chat thread as <Name> message", () => {
    expect(players.some((l) => /\[Async Chat Thread - #\d+\/INFO\]: <PlayerOne> /.test(l))).toBe(true);
  });

  it("logs RCON clients starting and stopping", () => {
    expect(players.some((l) => /\[RCON Listener #\d+\/INFO\]: Thread RCON Client \/127\.0\.0\.1 started$/.test(l))).toBe(true);
    expect(players.some((l) => /\[RCON Client \/127\.0\.0\.1 #\d+\/INFO\]: Thread RCON Client \/127\.0\.0\.1 shutting down$/.test(l))).toBe(true);
  });

  it("shows that a stop begins with 'Stopping server' and ends without a closing line", () => {
    expect(shutdown.some((l) => l.endsWith("]: Stopping server"))).toBe(true);
    expect(shutdown.at(-1)).toMatch(/Awaiting termination of I\/O pool/);
  });
});

describe("console replies and restarts captured from a real Paper started by a user unit with a stdin FIFO", () => {
  const replies = fixtureLines("latest-log/console-replies-fifo.txt");
  const restart = fixtureLines("latest-log/in-game-restart.txt");

  it("prints a console command's reply as a 'System chat:' line, which is what a backup waits for", () => {
    expect(replies.some((line) => /\[Server thread\/INFO\]: System chat: Saved the game$/.test(line))).toBe(true);
    expect(replies.some((line) => /: System chat: Automatic saving is now disabled$/.test(line))).toBe(true);
    expect(replies.some((line) => /: System chat: Automatic saving is now enabled$/.test(line))).toBe(true);
    expect(replies.some((line) => /: System chat: Saving the game \(this may take a moment!\)$/.test(line))).toBe(true);
  });

  it("prints `say` as a [Server] line and `tps` as a plain line", () => {
    expect(replies.some((line) => /\]: \[Not Secure\] \[Server\] .+$/.test(line))).toBe(true);
    expect(replies.some((line) => /\]: TPS from last 1m, 5m, 15m: [\d.]+, [\d.]+, [\d.]+$/.test(line))).toBe(true);
  });

  it("shows an in-game /restart announcing the restart script, then stopping", () => {
    const at = restart.findIndex((line) => /\[org\.spigotmc\.RestartCommand\] Attempting to restart with \.\//.test(line));
    expect(at).toBeGreaterThan(0);
    expect(restart[at + 1]).toMatch(/\]: Stopping server$/);
  });
});

describe("what systemd hands ExecStopPost for each way a server unit ends", () => {
  const lines = fixtureLines("systemd/exec-stop-post-env.txt").filter((line) => !line.startsWith("#"));
  const by = new Map(lines.map((line) => [line.split(" ")[0], line] as const));

  it("keeps every graceful end a success and only a kill a failure", () => {
    expect(by.get("panel-stop")).toBe("panel-stop result=success code=exited status=143");
    expect(by.get("ingame-stop")).toBe("ingame-stop result=success code=exited status=0");
    expect(by.get("ingame-restart")).toBe("ingame-restart result=success code=exited status=0");
    expect(by.get("crash-sigkill")).toBe("crash-sigkill result=signal code=killed status=KILL");
  });
});
