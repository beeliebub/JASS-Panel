// Follows latest.log. Lines are split on the byte 0x0a, which never occurs inside a multi-byte UTF-8 sequence, so a line is only
// decoded once it is complete and a character split across two reads is never decoded early. Each line's id is its inode and the
// byte offset where it starts, so an offset is never applied to a file that has since been rotated: a rotation or truncation
// restarts from the top and marks those lines as a replay, which the UI shows as history.
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";

export const MAX_LINE_BYTES = 8192;
const NEWLINE = 0x0a;
const MAX_CARRY_BYTES = MAX_LINE_BYTES * 8;

export interface TailLine {
  readonly id: string;
  readonly text: string;
  readonly cut: boolean;
  readonly replay: boolean;
}

export type StartPoint = "start" | "end";

export class LogTail {
  readonly #file: string;
  #inode: number | null = null;
  #position = 0;
  #lineStart = 0;
  #carry: Buffer = Buffer.alloc(0);
  #carryCut = false;
  #replay = false;
  #started = false;
  readonly #startAt: StartPoint;

  constructor(file: string, startAt: StartPoint = "end") {
    this.#file = file;
    this.#startAt = startAt;
  }

  /** Reads what has been appended since the last call. A missing file yields nothing and keeps the position. */
  poll(): TailLine[] {
    let info;
    try {
      info = statSync(this.#file);
    } catch {
      // A file that does not exist yet has nothing in it to skip: if the tail is meant to start at the end, it starts at the top
      // of the file that appears later, so the first lines of a new log are not lost.
      if (!this.#started && this.#startAt === "end") {
        this.#started = true;
        this.#inode = null;
        this.#position = 0;
      }
      return [];
    }
    if (!this.#started) {
      this.#started = true;
      this.#inode = info.ino;
      this.#position = this.#startAt === "end" ? info.size : 0;
      this.#lineStart = this.#position;
    } else if (this.#inode === null) {
      // The file appeared after the tail was attached: everything in it is new, so it is read from the top, not replayed.
      this.#inode = info.ino;
      this.#position = 0;
      this.#lineStart = 0;
    } else if (info.ino !== this.#inode || info.size < this.#position) {
      this.#inode = info.ino;
      this.#position = 0;
      this.#lineStart = 0;
      this.#carry = Buffer.alloc(0);
      this.#carryCut = false;
      this.#replay = true;
    }
    if (info.size <= this.#position) return [];

    const bytes = this.#readRange(this.#position, info.size);
    const from = this.#position;
    this.#position = info.size;
    return this.#split(bytes, from);
  }

  #readRange(from: number, to: number): Buffer {
    // Non-blocking open and a regular-file check: a FIFO named like the log must not stall the daemon.
    const fd = openSync(this.#file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) return Buffer.alloc(0);
      const length = to - from;
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const count = readSync(fd, buffer, filled, length - filled, from + filled);
        if (count === 0) break;
        filled += count;
      }
      return buffer.subarray(0, filled);
    } finally {
      closeSync(fd);
    }
  }

  #split(bytes: Buffer, from: number): TailLine[] {
    const lines: TailLine[] = [];
    const inode = this.#inode ?? 0;
    let start = 0;
    let index = bytes.indexOf(NEWLINE, start);
    while (index !== -1) {
      const segment = bytes.subarray(start, index);
      const lineBytes = this.#carry.length === 0 ? segment : Buffer.concat([this.#carry, segment]);
      const cut = this.#carryCut || lineBytes.length > MAX_LINE_BYTES;
      const kept = lineBytes.subarray(0, MAX_LINE_BYTES);
      lines.push({
        id: `${inode}:${this.#lineStart}`,
        text: kept.toString("utf8"),
        cut,
        replay: this.#replay,
      });
      this.#carry = Buffer.alloc(0);
      this.#carryCut = false;
      this.#lineStart = from + index + 1;
      start = index + 1;
      index = bytes.indexOf(NEWLINE, start);
    }
    // The unfinished tail waits for its newline. Past the cap it is kept only up to the cap and marked, so memory stays bounded.
    const rest = bytes.subarray(start);
    if (rest.length > 0) {
      const combined = Buffer.concat([this.#carry, rest]);
      if (combined.length > MAX_CARRY_BYTES) {
        this.#carry = combined.subarray(0, MAX_CARRY_BYTES);
        this.#carryCut = true;
      } else {
        this.#carry = combined;
      }
    }
    return lines;
  }

  get replaying(): boolean {
    return this.#replay;
  }
}

/** The last complete lines of a log, for showing history when a console opens. Reads at most maxBytes from the end. */
export function readHistory(file: string, maxLines: number, maxBytes = 256 * 1024): TailLine[] {
  let info;
  try {
    info = statSync(file);
  } catch {
    return [];
  }
  // A pipe or device at the log path is never read: a read that waits for a writer would hold the daemon's event loop.
  if (!info.isFile()) return [];
  const from = Math.max(0, info.size - maxBytes);
  const fd = openSync(file, "r");
  try {
    const length = info.size - from;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, from);
    const stat = fstatSync(fd);
    const lines: TailLine[] = [];
    let position = from;
    let skip = from > 0;
    for (let index = buffer.indexOf(NEWLINE); index !== -1; index = buffer.indexOf(NEWLINE, index + 1)) {
      if (skip) {
        skip = false;
        position = from + index + 1;
        continue;
      }
      const line = buffer.subarray(position - from, index);
      lines.push({ id: `${stat.ino}:${position}`, text: line.subarray(0, MAX_LINE_BYTES).toString("utf8"), cut: line.length > MAX_LINE_BYTES, replay: false });
      position = from + index + 1;
    }
    return lines.slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}
