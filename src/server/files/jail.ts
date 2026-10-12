// The file jail. Every path from a request is a relative POSIX path. It is refused when it is empty, contains NUL or a `..` segment,
// or is absolute. The target, or for a new file its parent, is resolved with realpath and must stay inside the realpath of the
// server directory. Reads open the final component with O_NOFOLLOW, so a symlink planted in that position is never followed even if it
// appears after the check. Writes resolve their path the same way, so a symlink inside the folder names its target, which must also lie
// inside the folder. The bytes go to a temporary sibling created with O_NOFOLLOW, and the rename replaces the resolved entry. An entry that
// is not a regular file is refused before anything is written.
import { closeSync, constants, type Dirent, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statfsSync, statSync, type Stats } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { SERVER_CAP_BYTES } from "./history.js";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const MAX_LISTING = 2000;
export const MAX_READ_BYTES = 2 * 1024 * 1024;

export class JailError extends Error {}

/** A file larger than the panel accepts. Refused as the bytes arrive, so nothing more than the limit is kept. */
export class FileTooLarge extends JailError {}

/** Room a write keeps free beyond its own size, so that a write which fits does not leave the disk with nothing for the panel's own files. */
export const WRITE_RESERVE_BYTES = 256 * 1024 * 1024;
/** How often the disk is checked while a file is being written, so a write cannot take the room the reserve keeps. */
const SPACE_CHECK_BYTES = 8 * 1024 * 1024;

export function checkRelativePath(path: string): string {
  if (path.length === 0) throw new JailError("the path is empty");
  if (path.includes("\0")) throw new JailError("the path contains a NUL character");
  if (isAbsolute(path) || path.startsWith("/")) throw new JailError("the path must be relative to the server directory");
  if (path.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new JailError("the path may not contain empty segments or '..'");
  }
  return path;
}

/** True when a path is the parent or lies inside it. A name that merely begins with two dots is inside; only a step up is outside. */
export function within(child: string, parent: string): boolean {
  const offset = relative(parent, child);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

/**
 * Resolves a relative path to an absolute one inside the server directory, or throws. With allowMissing, a path that does not exist
 * yet is accepted when its parent folder exists and is inside the directory.
 */
export function resolveInside(serverDir: string, path: string, options: { readonly allowMissing?: boolean } = {}): string {
  const relativePath = checkRelativePath(path);
  const root = realpathSync(serverDir);
  const target = join(root, relativePath);
  try {
    const real = realpathSync(target);
    if (!within(real, root)) throw new JailError("the path leaves the server directory");
    return real;
  } catch (error) {
    if (error instanceof JailError) throw error;
    if (options.allowMissing !== true) throw new JailError("that file or folder does not exist");
    let parent: string;
    try {
      parent = realpathSync(dirname(target));
    } catch {
      throw new JailError("the folder for that file does not exist");
    }
    if (!within(parent, root)) throw new JailError("the path leaves the server directory");
    return join(parent, relativePath.slice(relativePath.lastIndexOf("/") + 1));
  }
}

export interface Entry {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
  readonly size: number;
  readonly modified: string;
}

/** Lists a folder, at most MAX_LISTING entries. An empty path is the server directory itself. */
export function listDirectory(serverDir: string, path: string): { entries: Entry[]; truncated: boolean } {
  const directory = path === "" ? realpathSync(serverDir) : resolveInside(serverDir, path);
  if (!statSync(directory).isDirectory()) throw new JailError("that is not a folder");
  const names = readdirSync(directory).sort();
  const entries: Entry[] = names.slice(0, MAX_LISTING).map((name) => {
    const info = lstatSync(join(directory, name));
    return {
      name,
      kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      size: info.size,
      modified: info.mtime.toISOString(),
    };
  });
  return { entries, truncated: names.length > MAX_LISTING };
}

export interface FileRead {
  readonly text: string;
  readonly truncated: boolean;
  readonly size: number;
}

/** Reads at most MAX_READ_BYTES of a regular file, opened without following a symlink in the final position. */
export function readText(serverDir: string, path: string): FileRead {
  const file = resolveInside(serverDir, path);
  // O_NONBLOCK: a FIFO planted at this path must not hang the daemon on open. The type check below refuses anything not regular.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new JailError("that is not a file");
    const length = Math.min(info.size, MAX_READ_BYTES);
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const count = readSync(fd, buffer, filled, length - filled, filled);
      if (count === 0) break;
      filled += count;
    }
    return { text: buffer.subarray(0, filled).toString("utf8"), truncated: info.size > MAX_READ_BYTES, size: info.size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces a file's content. The previous content is copied first, so the copy exists before the change. The new content is written to a
 * temporary sibling and renamed into place, so a reader never sees half a file. The writes are asynchronous, so a large upload does not hold
 * the event loop: streams and countdown timers keep running while it is written.
 */
export async function writeText(serverDir: string, path: string, content: string, keepPrevious?: (previousPath: string) => Promise<void>): Promise<void> {
  await writeBytes(serverDir, path, Buffer.from(content, "utf8"), keepPrevious);
}

/** Replaces a file's bytes, with the same rules as writeText. Bytes are written as given, so a binary upload is stored exactly as it was sent. */
export async function writeBytes(serverDir: string, path: string, bytes: Buffer, keepPrevious?: (previousPath: string) => Promise<void>): Promise<void> {
  await writeStream(serverDir, path, [bytes], { maxBytes: bytes.length, expectedBytes: bytes.length, ...(keepPrevious === undefined ? {} : { keepPrevious }) });
}

/**
 * Replaces a file with the chunks of a stream, with the same rules as writeText, and returns the number of bytes written. Nothing is written
 * when the disk cannot hold the file beside the reserve, when more than `maxBytes` arrive or more than `expectedBytes`, or when `beforeCommit`
 * throws, which it does for a person whose permission changed while the bytes were arriving. The disk is checked again as the bytes arrive, so
 * a write cannot take the room the reserve keeps. `keepPrevious` is given the path of the file being replaced, so its copy is made without
 * reading the file into memory. It runs only once the write has been accepted, so a refused write leaves the file's history as it was.
 */
export async function writeStream(
  serverDir: string,
  path: string,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: {
    readonly maxBytes: number;
    readonly expectedBytes?: number | undefined;
    readonly keepPrevious?: (previousPath: string) => Promise<void>;
    readonly beforeCommit?: () => void | Promise<void>;
  },
): Promise<number> {
  const file = resolveInside(serverDir, path, { allowMissing: true });
  const folder = dirname(file);
  // The mode of a replaced file is kept, so an executable stays executable. A new file gets the usual mode.
  let mode = 0o644;
  // lstat, not stat: a dangling symlink in the way is refused as "not a regular file" instead of being replaced by the rename.
  const existing = await lstatIfPresent(file);
  if (existing !== null) {
    if (!existing.isFile()) throw new JailError("only a regular file can be overwritten");
    // A file larger than the history can keep is not replaced, since its previous version could not be kept.
    if (options.keepPrevious !== undefined && existing.size > SERVER_CAP_BYTES) throw new JailError("that file is too large to replace here; the previous version could not be kept");
    mode = existing.mode & 0o777;
  }
  // The disk must hold the file, and the reserve beyond it, before the first byte is written.
  if (freeBytesAt(folder) < (options.expectedBytes ?? 0) + WRITE_RESERVE_BYTES) throw new JailError("there is not enough free space on the disk for this file");
  const temporary = join(folder, `.jass-panel-${Math.random().toString(36).slice(2)}.partial`);
  let written = 0;
  let nextSpaceCheck = SPACE_CHECK_BYTES;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      // The umask would strip group and other bits from the mode, so the mode is set on the open file.
      await handle.chmod(mode);
      for await (const chunk of chunks) {
        written += chunk.byteLength;
        if (written > options.maxBytes) throw new FileTooLarge("the file is larger than the panel accepts");
        if (options.expectedBytes !== undefined && written > options.expectedBytes) throw new JailError("the file is longer than the length it declared");
        if (written >= nextSpaceCheck) {
          nextSpaceCheck += SPACE_CHECK_BYTES;
          if (freeBytesAt(folder) < WRITE_RESERVE_BYTES) throw new JailError("the disk is nearly full, so the file was not written");
        }
        // A single write may store part of a chunk, so the loop runs until every byte is down. A write that stores nothing ends it.
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten === 0) throw new JailError("the file could not be written in full; the old content is unchanged");
          offset += bytesWritten;
        }
      }
      // A stream that ends early must not be renamed over the live file as if it were complete.
      if (options.expectedBytes !== undefined && written !== options.expectedBytes) throw new JailError("the file could not be written in full; the old content is unchanged");
      // The bytes reach the disk before the rename makes them the file, so a crash cannot leave a short file under the real name.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforeCommit?.();
    if (existing !== null && options.keepPrevious !== undefined) {
      if (freeBytesAt(folder) < existing.size + WRITE_RESERVE_BYTES) throw new JailError("there is not enough free space on the disk to keep the previous version");
      await options.keepPrevious(file);
    }
    await rename(temporary, file);
  } catch (error) {
    // Nothing a failed write leaves behind is kept: an orphan would fill the disk and be swept into the next backup. A cleanup that fails
    // must not replace the error the write itself raised.
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return written;
}

// The names a writer gives its temporary files. The start-up sweep removes only files with these names.
export const PARTIAL_NAME = /^\.jass-panel-[a-z0-9]+\.partial$/;

/**
 * Removes the temporary files that writes left in a server folder when the daemon died during them. Only the names a writer gives its
 * temporary files are removed, and only regular files: links are not followed, so nothing a person made is touched.
 */
export async function sweepPartials(serverDir: string): Promise<number> {
  let removed = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && PARTIAL_NAME.test(entry.name)) {
        // A file that cannot be removed is left for a person. It must not stop the daemon from starting.
        try {
          await rm(path, { force: true });
          removed += 1;
        } catch {
          // Left in place; the sweep carries on with the rest of the folder.
        }
      }
    }
  };
  await walk(serverDir);
  return removed;
}

/** Bytes a non-root user may still write to the disk that holds `path`. */
function freeBytesAt(path: string): number {
  const space = statfsSync(path);
  return Number(space.bavail) * Number(space.bsize);
}

async function lstatIfPresent(file: string): Promise<Stats | null> {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

