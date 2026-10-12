// The script a server's unit runs before it starts when "update plugins on start" is on. It asks the daemon, over the control socket,
// to update that one server, and waits for the answer. It always exits 0: the unit runs it with a leading "-", and a failed update
// must never stop a server from starting. It is written once into the data directory; nothing in it comes from a request.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../servers/files.js";

export const UPDATE_REQUEST_NAME = "update-request";

export function updateRequestScript(nodePath: string): string {
  return [
    `#!${nodePath}`,
    "// Written by JASS Panel. Asks the panel to update one server's plugins before it starts. Always exits 0.",
    'import { connect } from "node:net";',
    "const [socketPath, id] = process.argv.slice(2);",
    "const finish = (message) => { console.log(message); process.exit(0); };",
    'if (!socketPath || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id ?? "")) finish("plugin update skipped: bad arguments");',
    "const socket = connect(socketPath);",
    "const timer = setTimeout(() => finish(\"plugin update skipped: the panel did not answer\"), 110000);",
    'let reply = "";',
    'socket.on("connect", () => socket.write(`update ${id}\\n`));',
    'socket.on("data", (chunk) => { reply += chunk.toString("utf8"); if (reply.includes("\\n")) { clearTimeout(timer); finish(`plugin update: ${reply.trim()}`); } });',
    'socket.on("error", () => { clearTimeout(timer); finish("plugin update skipped: the panel is not reachable"); });',
    'socket.on("close", () => { clearTimeout(timer); finish(`plugin update: ${reply.trim() || "no answer"}`); });',
    "",
  ].join("\n");
}

export function ensureUpdateRequest(dataDir: string, nodePath: string): string {
  const target = join(dataDir, "bin", UPDATE_REQUEST_NAME);
  mkdirSync(join(dataDir, "bin"), { recursive: true, mode: 0o700 });
  writeAtomic(target, updateRequestScript(nodePath), 0o700);
  return target;
}
