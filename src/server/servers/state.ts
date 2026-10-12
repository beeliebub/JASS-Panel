// What the panel shows for each server: the unit's state from one systemctl call, how the last run ended from the stop-event
// file, and whether the unit file still matches what the panel wrote. Each part can be unknown on its own, and unknown is shown
// as unknown.
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import type { PanelPaths, PanelConfig } from "../config/config.js";
import type { ObservedState } from "../systemd/user.js";
import { observeServers, type Readiness } from "../power/readiness.js";
import type { Runner } from "../systemd/run.js";
import { unitMatchesRecord } from "./files.js";
import type { ServerRecord } from "./store.js";

export interface LastEnd {
  readonly result: string;
  readonly code: string;
  readonly status: string;
}

export interface ServerView {
  readonly id: string;
  readonly displayName: string;
  readonly directory: string;
  readonly logPath: string;
  readonly autostart: boolean;
  readonly updateOnStart: boolean;
  readonly memory: ServerRecord["memory"];
  readonly startCommand: readonly string[];
  readonly state: ObservedState;
  readonly lastEnd: LastEnd | null;
  readonly unitEdited: boolean;
}

// Only the end of the events file is read, so a long history costs a list no more than a short one.
const TAIL_BYTES = 64 * 1024;

/** The last non-empty line of a file, read from its end. */
function lastLine(file: string): string | undefined {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n").filter((line) => line.length > 0);
    // Unless the read began at the start of the file, its first piece may be the end of a line that the read cut short.
    if (start > 0) lines.shift();
    return lines.at(-1);
  } finally {
    closeSync(fd);
  }
}

export function readLastEnd(paths: PanelPaths, id: string): LastEnd | null {
  const file = `${paths.events}/${id}.log`;
  if (!existsSync(file)) return null;
  const last = lastLine(file);
  if (last === undefined) return null;
  const fields = Object.fromEntries(
    last.split(" ").map((pair) => {
      const equals = pair.indexOf("=");
      return [pair.slice(0, equals), pair.slice(equals + 1)];
    }),
  );
  if (typeof fields.result !== "string" || typeof fields.code !== "string" || typeof fields.status !== "string") return null;
  return { result: fields.result, code: fields.code, status: fields.status };
}

export async function viewServers(run: Runner, config: Pick<PanelConfig, "unitDir" | "paths">, servers: readonly ServerRecord[], readiness: Readiness): Promise<ServerView[]> {
  const states = await observeServers(run, readiness, servers.map((server) => server.id));
  return servers.map((server) => ({
    id: server.id,
    displayName: server.displayName,
    directory: server.directory,
    logPath: server.logPath,
    autostart: server.autostart,
    updateOnStart: server.updateOnStart,
    memory: server.memory,
    startCommand: server.startCommand,
    state: states.get(server.id) ?? { known: false, reason: "the state could not be read" },
    lastEnd: readLastEnd(config.paths, server.id),
    unitEdited: !unitMatchesRecord({ unitDir: config.unitDir, paths: config.paths }, server.id, server.unitDigest, server.socketDigest),
  }));
}
