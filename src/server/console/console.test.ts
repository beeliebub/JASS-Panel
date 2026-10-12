import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, truncateSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify } from "./classify.js";
import { commandProblem, sendCommand } from "./fifo.js";
import { LogTail, MAX_LINE_BYTES, readHistory } from "./tail.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "test", "fixtures", "latest-log");
const fixtureLines = (name: string) => readFileSync(join(FIXTURES, name), "utf8").split("\n");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-console-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("classify, pinned to captured output", () => {
  function kindsOf(name: string): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const line of fixtureLines(name)) {
      const kind = classify(line).kind;
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    return counts;
  }

  it("finds joins, leaves and chat in the players capture", () => {
    const counts = kindsOf("players-main.txt");
    expect(counts.join ?? 0).toBeGreaterThan(0);
    expect(counts.leave ?? 0).toBeGreaterThan(0);
    expect(counts.chat ?? 0).toBeGreaterThan(0);
  });

  it("finds deaths and advancements in their captures", () => {
    expect(kindsOf("death-main.txt").death ?? 0).toBeGreaterThan(0);
    expect(kindsOf("advancements-main.txt").advancement ?? 0).toBeGreaterThan(0);
  });

  it("finds crash markers and warnings in the crash capture", () => {
    const counts = kindsOf("crash-markers-main.txt");
    expect(counts.crash ?? 0).toBeGreaterThan(0);
  });

  it("reads the level and thread of a prefixed line", () => {
    const parsed = classify("[17:00:22] [Worker-Main-1/WARN]: something is off");
    expect(parsed).toMatchObject({ kind: "warning", level: "WARN", thread: "Worker-Main-1", time: "17:00:22" });
  });

  it("recognises the console reply forms the server writes into the log", () => {
    expect(classify("[23:59:28] [Server thread/INFO]: [Not Secure] [Server] hello").kind).toBe("chat");
    expect(classify("[23:59:30] [Server thread/INFO]: System chat: Saved the game").kind).toBe("system");
  });
});

describe("LogTail", () => {
  it("starts at the end by default and returns only what is appended", () => {
    const file = join(root, "latest.log");
    writeFileSync(file, "old line\n");
    const tail = new LogTail(file);
    expect(tail.poll()).toEqual([]);
    appendFileSync(file, "new line\n");
    expect(tail.poll().map((line) => line.text)).toEqual(["new line"]);
  });

  it("holds back a partial line until its newline arrives", () => {
    const file = join(root, "latest.log");
    writeFileSync(file, "");
    const tail = new LogTail(file, "start");
    appendFileSync(file, "half");
    expect(tail.poll()).toEqual([]);
    appendFileSync(file, " done\n");
    expect(tail.poll().map((line) => line.text)).toEqual(["half done"]);
  });

  it("does not decode a UTF-8 character that is split across reads", () => {
    const file = join(root, "latest.log");
    writeFileSync(file, "");
    const tail = new LogTail(file, "start");
    const bytes = Buffer.from("café ok\n", "utf8");
    const split = bytes.indexOf(0xc3) + 1;
    appendFileSync(file, bytes.subarray(0, split));
    expect(tail.poll()).toEqual([]);
    appendFileSync(file, bytes.subarray(split));
    expect(tail.poll().map((line) => line.text)).toEqual(["café ok"]);
  });

  it("cuts a line over the cap, marks it, and keeps the next line intact", () => {
    const file = join(root, "latest.log");
    writeFileSync(file, "");
    const tail = new LogTail(file, "start");
    appendFileSync(file, `${"x".repeat(MAX_LINE_BYTES + 500)}\nnext\n`);
    const [long, next] = tail.poll();
    expect(long?.cut).toBe(true);
    expect(Buffer.byteLength(long?.text ?? "")).toBe(MAX_LINE_BYTES);
    expect(next).toMatchObject({ text: "next", cut: false });
  });

  it("restarts from the top after a rotation and marks those lines as a replay", () => {
    const file = join(root, "latest.log");
    writeFileSync(file, "first\n");
    const tail = new LogTail(file, "start");
    expect(tail.poll().map((line) => line.text)).toEqual(["first"]);
    renameSync(file, join(root, "latest.log.1"));
    writeFileSync(file, "after rotation\n");
    const lines = tail.poll();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: "after rotation", replay: true });
  });

  it("restarts from the top after a truncation", () => {
    const file = join(root, "latest.log");
    writeFileSync(file, "one\ntwo\n");
    const tail = new LogTail(file, "start");
    tail.poll();
    truncateSync(file, 0);
    appendFileSync(file, "again\n");
    expect(tail.poll()).toEqual([expect.objectContaining({ text: "again", replay: true })]);
  });

  it("gives every line an id made of the inode and the byte offset where it starts", () => {
    const file = join(root, "latest.log");
    writeFileSync(file, "");
    const tail = new LogTail(file, "start");
    appendFileSync(file, "aa\nbbb\n");
    const [first, second] = tail.poll();
    expect(first?.id).toMatch(/^\d+:0$/);
    expect(second?.id).toMatch(/^\d+:3$/);
  });

  it("reads a log that appears after the tail was attached from its top, without marking it as a replay", () => {
    const file = join(root, "late.log");
    const tail = new LogTail(file, "end");
    expect(tail.poll()).toEqual([]);
    writeFileSync(file, "first of a new log\n");
    const lines = tail.poll();
    expect(lines).toEqual([expect.objectContaining({ text: "first of a new log", replay: false })]);
  });

  it("returns nothing for a missing file and keeps its place", () => {
    const tail = new LogTail(join(root, "missing.log"));
    expect(tail.poll()).toEqual([]);
  });

  it("reads the last complete lines for history without a partial first line", () => {
    const file = join(root, "latest.log");
    writeFileSync(file, `${"y".repeat(300)}\nalpha\nbeta\n`);
    // The 40-byte window starts inside the long line, so that partial line is dropped and the two complete ones are kept.
    expect(readHistory(file, 10, 40).map((line) => line.text)).toEqual(["alpha", "beta"]);
    expect(readHistory(file, 10).map((line) => line.text)).toEqual(["y".repeat(300), "alpha", "beta"]);
  });
});

describe("sendCommand", () => {
  function fifo(): string {
    const path = join(root, "stdin.fifo");
    execFileSync("mkfifo", [path]);
    return path;
  }

  it("reports not running for a missing pipe, and creates nothing", () => {
    const path = join(root, "missing.fifo");
    expect(sendCommand(path, "list")).toEqual({ delivered: false, reason: "not_running" });
    expect(() => readFileSync(path)).toThrow();
  });

  it("reports not running for a regular file in place of the pipe, and writes nothing into it", () => {
    const path = join(root, "plain");
    writeFileSync(path, "keep\n");
    expect(sendCommand(path, "list")).toEqual({ delivered: false, reason: "not_running" });
    expect(readFileSync(path, "utf8")).toBe("keep\n");
  });

  it("reports not running for a pipe with no reader, since the open fails", () => {
    expect(sendCommand(fifo(), "list")).toEqual({ delivered: false, reason: "not_running" });
  });

  it("delivers one newline-terminated line to a reader", async () => {
    const path = fifo();
    const reader = spawn("/bin/sh", ["-c", `read line < "${path}"; printf '%s' "$line" > "${join(root, "got")}"`]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sendCommand(path, "say hello from the panel")).toEqual({ delivered: true });
    await new Promise<void>((resolve) => reader.on("exit", () => resolve()));
    expect(readFileSync(join(root, "got"), "utf8")).toBe("say hello from the panel");
  });

  it("refuses an empty line, control characters, line separators and a line over 1024 bytes", () => {
    expect(commandProblem("")).toBe("empty");
    expect(commandProblem("a\nb")).toBe("control_character");
    expect(commandProblem("a b")).toBe("control_character");
    expect(commandProblem("a\u0007b")).toBe("control_character");
    expect(commandProblem("x".repeat(1025))).toBe("too_long");
    expect(commandProblem("x".repeat(1024))).toBeNull();
    expect(commandProblem("say héllo")).toBeNull();
  });
});

describe("file handles", () => {
  it("opens a file for reading without changing it", () => {
    const file = join(root, "keep");
    writeFileSync(file, "x");
    closeSync(openSync(file, "r"));
    expect(readFileSync(file, "utf8")).toBe("x");
  });
});
