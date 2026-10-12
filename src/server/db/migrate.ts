// Forward-only migrations. Each numbered SQL file is applied once, in its own transaction, with its checksum recorded. On start the
// runner refuses when an applied file is missing or was edited, because a database built from different SQL than the code
// carries is not the database the code was written against. Before a migration touches a database that already holds data, a
// verified copy is written next to it, so a bad migration on a live panel can be rolled back by hand.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { PanelDatabase } from "./open.js";

export class MigrationError extends Error {}

const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const BACKUP_NAME = /^panel-\d{8}T\d{6}Z-.+\.db$/;
const KEEP_BACKUPS = 5;

export interface MigrationOptions {
  readonly dir: string;
  readonly backupDir: string;
  readonly now?: () => Date;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly backup: string | null;
}

export function bundledMigrationsDirectory(): string {
  return fileURLToPath(new URL("./migrations/", import.meta.url));
}

interface MigrationFile {
  readonly name: string;
  readonly prefix: number;
  readonly sql: string;
  readonly checksum: string;
}

function readMigrations(dir: string): MigrationFile[] {
  const names = readdirSync(dir).filter((name) => MIGRATION_NAME.test(name)).sort();
  const seen = new Set<number>();
  return names.map((name) => {
    const prefix = Number(MIGRATION_NAME.exec(name)?.[1]);
    if (seen.has(prefix)) throw new MigrationError(`two migrations share the number ${prefix}`);
    seen.add(prefix);
    const sql = readFileSync(join(dir, name), "utf8");
    return { name, prefix, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Writes a verified copy of the database, mode 0600, and keeps only the newest few copies. */
function backupBeforeMigration(db: PanelDatabase, backupDir: string, label: string, now: Date): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const target = join(backupDir, `panel-${timestamp(now)}-${label}.db`);
  if (existsSync(target)) throw new MigrationError(`refusing to overwrite the backup ${target}`);
  db.prepare("VACUUM INTO ?").run(target);
  chmodSync(target, 0o600);
  const copy = new Database(target, { readonly: true, fileMustExist: true });
  try {
    const check = copy.pragma("integrity_check", { simple: true });
    if (check !== "ok") throw new MigrationError(`the backup ${target} failed its integrity check: ${String(check)}`);
  } finally {
    copy.close();
  }
  const copies = readdirSync(backupDir).filter((name) => BACKUP_NAME.test(name)).sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - KEEP_BACKUPS))) {
    rmSync(join(backupDir, old));
  }
  return target;
}

/** Applies every pending migration. Throws MigrationError, having changed nothing, when the history does not match the files. */
export function migrate(db: PanelDatabase, options: MigrationOptions): MigrationResult {
  const now = options.now ?? (() => new Date());
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const files = readMigrations(options.dir);
  const byName = new Map(files.map((file) => [file.name, file]));
  const applied = db.prepare("SELECT name, checksum FROM schema_migrations ORDER BY name").all() as {
    name: string;
    checksum: string;
  }[];

  for (const row of applied) {
    const file = byName.get(row.name);
    if (file === undefined) throw new MigrationError(`the applied migration ${row.name} is missing from ${basename(options.dir)}`);
    if (file.checksum !== row.checksum) {
      throw new MigrationError(`the applied migration ${row.name} was edited after it ran; add a new migration instead`);
    }
  }

  const appliedNames = new Set(applied.map((row) => row.name));
  const pending = files.filter((file) => !appliedNames.has(file.name));
  const newestApplied = applied.at(-1)?.name ?? "";
  const outOfOrder = pending.find((file) => file.name < newestApplied);
  if (outOfOrder !== undefined) {
    throw new MigrationError(`the migration ${outOfOrder.name} sorts before one that already ran`);
  }
  if (pending.length === 0) return { applied: [], backup: null };

  const backup = applied.length > 0 ? backupBeforeMigration(db, options.backupDir, pending[0]?.name.replace(/\.sql$/, "") ?? "", now()) : null;
  const insert = db.prepare("INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)");
  for (const file of pending) {
    db.transaction(() => {
      db.exec(file.sql);
      insert.run(file.name, file.checksum, now().toISOString());
    })();
  }
  return { applied: pending.map((file) => file.name), backup };
}

/** Lists the backups the runner wrote, newest last; used by tests and by the health panel. */
export function listMigrationBackups(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => BACKUP_NAME.test(name) && statSync(join(backupDir, name)).isFile())
    .sort();
}
