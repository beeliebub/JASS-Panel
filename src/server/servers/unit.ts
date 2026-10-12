// Renders the user units for a game server, and the constant script they call when they end. One function renders every value,
// so the rules that keep a value from becoming a second directive live in one place: a NUL or a line break is refused outright,
// and every literal % or $ is doubled so systemd does not expand it. The only specifier left is %t, the runtime directory, where
// the stdin FIFO is meant to live.
import { createHash } from "node:crypto";
import { serviceUnit, socketUnit } from "../systemd/user.js";

export interface UnitServer {
  readonly id: string;
  readonly directory: string;
  readonly startCommand: readonly string[];
}

export class UnitRenderError extends Error {}

import { SERVER_ID_PATTERN as SERVER_ID } from "./ids.js";

function plain(label: string, value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new UnitRenderError(`${label} contains a NUL or a line break, which cannot appear in a unit file`);
  }
  return value;
}

// A replacement string treats "$$" as one literal dollar, so the doubling uses a function, which inserts its text unchanged.
function expansionSafe(value: string): string {
  return value.replaceAll("%", () => "%%").replaceAll("$", () => "$$");
}

/** A plain value that systemd reads as a whole line: only the % and $ expansions need doubling. */
export function unitValue(label: string, value: string): string {
  // systemd reads a backslash at the end of a line as a continuation, which would swallow the next directive.
  if (plain(label, value).endsWith("\\")) throw new UnitRenderError(`${label} may not end in a backslash`);
  return expansionSafe(value);
}

/** One ExecStart argument: double-quoted, with backslash and quote escaped first, then the expansions. */
export function unitArgument(value: string): string {
  const escaped = plain("a command argument", value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${expansionSafe(escaped)}"`;
}

export function assertServerId(id: string): void {
  if (!SERVER_ID.test(id)) throw new UnitRenderError(`the server id ${JSON.stringify(id)} is not a valid slug`);
}

export interface UnitOptions {
  /** When set, the unit runs the update request before each start, with the leading "-" so a failure never blocks the start. */
  readonly updateOnStart?: { readonly nodePath: string; readonly script: string; readonly socket: string };
}

export function renderServiceUnit(server: UnitServer, dataDir: string, options: UnitOptions = {}): string {
  assertServerId(server.id);
  if (server.startCommand.length === 0) throw new UnitRenderError("the start command is empty");
  const [program] = server.startCommand;
  if (program === undefined || !program.startsWith("/")) {
    throw new UnitRenderError("the start command must begin with an absolute program path");
  }
  const socket = socketUnit(server.id);
  const stopEvent = `${dataDir}/bin/stop-event`;
  const lines = [
    `# ${serviceUnit(server.id)}`,
    "[Unit]",
    `Description=Minecraft server ${server.id} (managed by JASS Panel)`,
    "After=network.target",
    `Requires=${socket}`,
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${unitValue("the server directory", server.directory)}`,
    ...(options.updateOnStart === undefined
      ? []
      : [
          `ExecStartPre=-${[options.updateOnStart.nodePath, options.updateOnStart.script, options.updateOnStart.socket, server.id]
            .map(unitArgument)
            .join(" ")}`,
        ]),
    `ExecStart=${server.startCommand.map(unitArgument).join(" ")}`,
    `ExecStopPost=-${unitArgument(plain("the stop-event path", stopEvent))} ${unitArgument(server.id)}`,
    `Sockets=${socket}`,
    "StandardInput=socket",
    "StandardOutput=journal",
    "StandardError=journal",
    "Restart=on-failure",
    "RestartSec=5",
    // A stop is SIGTERM and Paper exits 143 after saving; that is a clean stop, not a failure.
    "SuccessExitStatus=143",
    "TimeoutStartSec=300",
    "TimeoutStopSec=120",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

/** The socket owns the FIFO. PartOf= stops the socket with the service, so a stopped server cannot be woken by a write. */
export function renderSocketUnit(id: string): string {
  assertServerId(id);
  return [
    `# ${socketUnit(id)}`,
    "[Unit]",
    `PartOf=${serviceUnit(id)}`,
    "",
    "[Socket]",
    `ListenFIFO=%t/jass-mc-${id}.stdin`,
    "SocketMode=0600",
    "RemoveOnStop=true",
    "",
  ].join("\n");
}

/**
 * The script systemd runs after a server's unit ends. It is the same text for every server and never built from data: the
 * server id arrives as one argument and is checked against the slug alphabet. It always exits 0, because a failing ExecStopPost
 * would turn an otherwise clean stop into a failed unit.
 */
export const STOP_EVENT_SCRIPT = [
  "#!/bin/sh",
  "# Written by JASS Panel. Appends how a server's unit ended to the events file the panel reads. Always exits 0.",
  'case "$1" in',
  "  ''|-*|*[!a-z0-9-]*) exit 0 ;;",
  "esac",
  'dir=$(dirname "$0")',
  'printf \'result=%s code=%s status=%s\\n\' "$SERVICE_RESULT" "$EXIT_CODE" "$EXIT_STATUS" >> "$dir/../events/$1.log" 2>/dev/null',
  "exit 0",
  "",
].join("\n");

export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
