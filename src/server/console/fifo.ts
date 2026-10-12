// Writes one console command to a server's stdin FIFO. The FIFO is opened without O_CREAT, so a missing pipe fails rather than
// becoming a regular file, and the open is checked to be a FIFO before anything is written. A successful write means the line was
// delivered to the server's input, not that the server has finished acting on it.
import { constants, closeSync, fstatSync, openSync, writeSync } from "node:fs";
import { hasControlCharacter } from "../../shared/text.js";

export const MAX_COMMAND_BYTES = 1024;

export type CommandProblem = "empty" | "too_long" | "control_character";

export function commandProblem(line: string): CommandProblem | null {
  if (line.length === 0) return "empty";
  if (Buffer.byteLength(line, "utf8") > MAX_COMMAND_BYTES) return "too_long";
  if (hasControlCharacter(line)) return "control_character";
  return null;
}

export type SendOutcome =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: "not_running" | "not_accepting" };

export function sendCommand(fifo: string, line: string): SendOutcome {
  let fd: number;
  try {
    fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch (error) {
    // ENXIO: no reader on the pipe. ENOENT: no pipe at all. Both mean the server is not taking input.
    const code = (error as NodeJS.ErrnoException).code;
    return { delivered: false, reason: code === "ENOENT" || code === "ENXIO" ? "not_running" : "not_accepting" };
  }
  try {
    if (!fstatSync(fd).isFIFO()) return { delivered: false, reason: "not_running" };
    const bytes = Buffer.from(`${line}\n`, "utf8");
    const written = writeSync(fd, bytes);
    return written === bytes.length ? { delivered: true } : { delivered: false, reason: "not_accepting" };
  } catch {
    return { delivered: false, reason: "not_accepting" };
  } finally {
    closeSync(fd);
  }
}
