#!/usr/bin/env node
// A stand-in for Paper for the lifecycle tests. It writes Paper-shaped lines to logs/latest.log in its working directory and to standard
// output, which the user manager's journal records for the unit, reads console commands from standard input the way the server does,
// and on SIGTERM writes the shutdown lines and exits 143, as the JVM does after its shutdown hooks. --no-done keeps it from printing the
// line that says it has loaded. It is not Paper: it proves the plumbing, and a real Paper run is the other half of the check.
import { appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = "logs/latest.log";
mkdirSync("logs", { recursive: true });

function stamp() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

function log(level, text) {
  appendFileSync(LOG, `[${stamp()}] [Server thread/${level}]: ${text}\n`);
}

// The journal copy of a console line has no thread name, which is what the panel's readiness check matches.
function journal(level, text) {
  process.stdout.write(`[${stamp()} ${level}]: ${text}\n`);
}

function shutdown(code) {
  log("INFO", "Stopping server");
  log("INFO", "Saving players");
  process.exit(code);
}

if (!process.argv.includes("--no-done")) {
  log("INFO", 'Done (0.5s)! For help, type "help"');
  journal("INFO", 'Done (0.5s)! For help, type "help"');
}
process.on("SIGTERM", () => shutdown(143));

// --silent reads commands and answers none of them: a server whose save confirmations never arrive.
const silent = process.argv.includes("--silent");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (silent) return;
  const command = line.trim();
  if (command === "stop") shutdown(0);
  if (command === "save-all flush") {
    log("INFO", "System chat: Saving the game (this may take a moment!)");
    log("INFO", "System chat: Saved the game");
  } else if (command === "save-off") {
    log("INFO", "System chat: Automatic saving is now disabled");
  } else if (command === "save-on") {
    log("INFO", "System chat: Automatic saving is now enabled");
  } else if (command.startsWith("say ")) {
    log("INFO", `[Not Secure] [Server] ${command.slice(4)}`);
  } else if (command === "list") {
    log("INFO", "System chat: There are 0 of a max of 2 players online:");
  }
});

// Keep the process alive without busy-waiting; a signal or a stop line ends it.
setInterval(() => undefined, 1 << 30);
