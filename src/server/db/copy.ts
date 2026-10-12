// A consistent copy of the panel's database, made at each start and once a day. The copies sit beside the copies a migration makes, under
// their own name, so neither set's pruning can remove the other's. The panel's database holds the server rows, grants, schedules and the
// audit trail, and the server backups do not include it, so this is the only copy of those.
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { PanelDatabase } from "./open.js";

const COPY_NAME = /^daily-\d{8}T\d{9}Z\.db$/;

/**
 * Writes a consistent copy of the database, mode 0600, and keeps the newest `keep` copies. Returns the path of the copy written, or null
 * when the newest copy is younger than `minAgeMs`, so that restarts cannot replace every retained copy with a recent one.
 */
export function copyDatabase(db: PanelDatabase, folder: string, now: Date, keep: number, minAgeMs = 0): string | null {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const before = listCopies(folder);
  const newest = before[before.length - 1];
  if (minAgeMs > 0 && newest !== undefined && now.getTime() - statSync(join(folder, newest)).mtimeMs < minAgeMs) return null;
  const target = join(folder, `daily-${now.toISOString().replace(/[-:.]/g, "")}.db`);
  // VACUUM INTO reads a consistent snapshot, so a copy taken while requests are running is never half-written.
  db.prepare("VACUUM INTO ?").run(target);
  chmodSync(target, 0o600);
  // The copy just written is never pruned, even when a clock that stepped back makes it sort as the oldest.
  const copies = listCopies(folder);
  const others = copies.filter((name) => name !== basename(target));
  for (const old of others.slice(0, Math.max(0, copies.length - keep))) rmSync(join(folder, old), { force: true });
  return target;
}

function listCopies(folder: string): string[] {
  return readdirSync(folder).filter((name) => COPY_NAME.test(name)).sort();
}
