// Copies of a file's previous content, kept before every overwrite so a bad edit can be undone by hand. Each file keeps its newest
// ten copies, and the whole server keeps at most 512 MiB; the oldest copies go first. Nothing here touches the live file.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const VERSIONS_PER_FILE = 10;
export const SERVER_CAP_BYTES = 512 * 1024 * 1024;

// The prefix carries a hash of the real path: two paths that sanitise to the same readable name (a/b and a_b) must not share history.
function prefixOf(path: string): string {
  const readable = path.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `${readable}.${createHash("sha256").update(path).digest("hex").slice(0, 12)}`;
}

// The bytes each server's history holds. It is read from disk once and then kept current by the writes, so a save does not stat every copy
// the server has. Keyed by folder, and writes to one folder run one after another so the total is never updated by two of them at once.
const totals = new Map<string, number>();
const queues = new Map<string, Promise<void>>();

/** Keeps a copy of a file's previous content, taken from the file on disk, so a large file is never held in memory. */
export function keepHistory(historyRoot: string, serverId: string, path: string, previousPath: string, now: Date): Promise<void> {
  const folder = join(historyRoot, serverId);
  const run = (queues.get(folder) ?? Promise.resolve()).then(() => keepOne(folder, path, previousPath, now));
  queues.set(
    folder,
    run.catch(() => undefined),
  );
  return run;
}

async function keepOne(folder: string, path: string, previousPath: string, now: Date): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  const prefix = prefixOf(path);
  // A random tail keeps two copies made in the same millisecond apart, so the later one cannot overwrite the earlier.
  const name = `${prefix}.${stamp}-${randomBytes(3).toString("hex")}`;
  const file = join(folder, name);
  try {
    // Exclusive, so a copy is never written over an existing file.
    await copyFile(previousPath, file, constants.COPYFILE_EXCL);
    await chmod(file, 0o600);
    // The copy reaches the disk before the live file is replaced, so a crash cannot lose the version the rename is about to remove.
    const handle = await open(file, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // A partial copy must not stay under a normal name: it would count toward the cap and could later be taken as a previous version. A
    // name that already existed was not made here, so it is left alone.
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) await rm(file, { force: true });
    throw error;
  }
  const size = (await stat(file)).size;
  try {
    await prune(folder, prefix, name, size);
  } catch (error) {
    // The total is unknown after a prune that failed, so the next save reads it from disk again rather than trusting it.
    totals.delete(folder);
    throw error;
  }
}

/** The stamp at the end of a copy's name, with its random tail. Stamps are fixed-width ISO times, so they sort by age. */
function stampOf(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Removes one copy and returns the bytes it held. A copy another write has already removed holds none. */
async function remove(folder: string, name: string): Promise<number> {
  const size = await stat(join(folder, name)).then(
    (info) => info.size,
    (error: unknown) => {
      if (isMissing(error)) return 0;
      throw error;
    },
  );
  await rm(join(folder, name), { force: true });
  return size;
}

/** The bytes the server's history holds, read from disk once, when no total is known yet. */
async function sizeOf(folder: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(folder)) {
    total += await stat(join(folder, name)).then(
      (info) => info.size,
      (error: unknown) => {
        if (isMissing(error)) return 0;
        throw error;
      },
    );
  }
  return total;
}

async function prune(folder: string, prefix: string, keep: string, newBytes: number): Promise<void> {
  // A total read from disk already counts the copy just made, so the copy's bytes are added only to a total that was kept.
  const known = totals.get(folder);
  let total = known === undefined ? await sizeOf(folder) : known + newBytes;
  const copies = (await readdir(folder)).filter((name) => name.startsWith(`${prefix}.`) && /^\d{8}T\d+/.test(name.slice(prefix.length + 1))).sort();
  // The copy this write has just made is never pruned, even if a clock that stepped back makes it sort as the oldest.
  for (const old of copies.slice(0, Math.max(0, copies.length - VERSIONS_PER_FILE))) {
    if (old !== keep) total -= await remove(folder, old);
  }
  // The whole server keeps its newest copies, so the oldest go first by stamp, whichever file they belong to.
  if (total > SERVER_CAP_BYTES) {
    const oldestFirst = (await readdir(folder)).filter((name) => name !== keep).sort((a, b) => stampOf(a).localeCompare(stampOf(b)) || a.localeCompare(b));
    for (const name of oldestFirst) {
      if (total <= SERVER_CAP_BYTES) break;
      total -= await remove(folder, name);
    }
  }
  totals.set(folder, total);
}
