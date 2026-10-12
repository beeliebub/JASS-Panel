import { execFileSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type PanelDatabase } from "./open.js";
import { bundledMigrationsDirectory, listMigrationBackups, migrate, MigrationError } from "./migrate.js";

let root: string;
const open: PanelDatabase[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-db-"));
});

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
});

function track(db: PanelDatabase): PanelDatabase {
  open.push(db);
  return db;
}

function migrationDir(files: Record<string, string>): string {
  const dir = join(root, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe("openDatabase", () => {
  it("creates the file with mode 0600 inside a 0700 directory", () => {
    const file = join(root, "data", "panel.db");
    track(openDatabase(file));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "data")).mode & 0o777).toBe(0o700);
  });

  it("refuses a second process on the same file before it writes anything", () => {
    // SQLite's exclusive lock is held per process: a second connection in this process would share the lock and succeed,
    // so the second opener has to be a separate process, as a second daemon would be. This Node build cannot run TypeScript
    // directly, so the module is bundled to a temporary file first. The test must not read the database file itself while
    // the lock is held: closing any descriptor for a file releases every POSIX lock the process holds on it.
    const file = join(root, "panel.db");
    track(openDatabase(file));
    const bundle = join(root, "open-bundle.mjs");
    // The bundle resolves better-sqlite3 from its own location, so the temporary directory borrows the project's modules.
    symlinkSync(join(import.meta.dirname, "..", "..", "..", "node_modules"), join(root, "node_modules"), "dir");
    buildSync({
      entryPoints: [join(import.meta.dirname, "open.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: bundle,
      external: ["better-sqlite3"],
      logLevel: "silent",
    });
    const script = `
      const { openDatabase } = await import(${JSON.stringify(pathToFileURL(bundle).href)});
      try { openDatabase(process.argv[1]); console.log("OPENED"); }
      catch (error) { console.log("REFUSED " + error.constructor.name); }
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(output.trim()).toBe("REFUSED DatabaseLockedError");
  });
});

describe("migrate", () => {
  it("applies the bundled initial schema to a fresh database, once", () => {
    const db = track(openDatabase(join(root, "panel.db")));
    const backups = join(root, "db-backups");
    const first = migrate(db, { dir: bundledMigrationsDirectory(), backupDir: backups });
    expect(first.applied).toEqual(["0001_initial.sql", "0002_plugin_sources_many.sql", "0003_autostart_matches_units.sql"]);
    expect(first.backup).toBeNull();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining(["servers", "grants", "known_users", "schedules", "backups", "plugin_sources", "settings", "audit"]),
    );
    const second = migrate(db, { dir: bundledMigrationsDirectory(), backupDir: backups });
    expect(second).toEqual({ applied: [], backup: null });
  });

  it("refuses an applied migration that was edited, and changes nothing", () => {
    const dir = migrationDir({ "0001_one.sql": "CREATE TABLE one (id INTEGER);" });
    const db = track(openDatabase(join(root, "panel.db")));
    migrate(db, { dir, backupDir: join(root, "b") });
    writeFileSync(join(dir, "0001_one.sql"), "CREATE TABLE one (id INTEGER, extra TEXT);");
    expect(() => migrate(db, { dir, backupDir: join(root, "b") })).toThrow(/was edited after it ran/);
  });

  it("refuses when an applied migration file is missing", () => {
    const dir = migrationDir({ "0001_one.sql": "CREATE TABLE one (id INTEGER);" });
    const db = track(openDatabase(join(root, "panel.db")));
    migrate(db, { dir, backupDir: join(root, "b") });
    rmSync(join(dir, "0001_one.sql"));
    expect(() => migrate(db, { dir, backupDir: join(root, "b") })).toThrow(MigrationError);
  });

  it("rolls back a failing migration and leaves the earlier ones in place", () => {
    const dir = migrationDir({ "0001_one.sql": "CREATE TABLE one (id INTEGER);" });
    const db = track(openDatabase(join(root, "panel.db")));
    migrate(db, { dir, backupDir: join(root, "b") });
    writeFileSync(join(dir, "0002_broken.sql"), "CREATE TABLE two (id INTEGER); THIS IS NOT SQL;");
    expect(() => migrate(db, { dir, backupDir: join(root, "b") })).toThrow();
    const names = db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[];
    expect(names.map((row) => row.name)).toEqual(["0001_one.sql"]);
    const two = db.prepare("SELECT name FROM sqlite_master WHERE name = 'two'").get();
    expect(two).toBeUndefined();
  });

  it("writes a 0600 verified copy before a migration on a populated database, and keeps the newest five", () => {
    const dir = migrationDir({ "0001_one.sql": "CREATE TABLE one (id INTEGER);" });
    const backups = join(root, "db-backups");
    const db = track(openDatabase(join(root, "panel.db")));
    migrate(db, { dir, backupDir: backups });
    for (let n = 2; n <= 7; n += 1) {
      const name = `000${n}_step_${n}.sql`;
      writeFileSync(join(dir, name), `CREATE TABLE step_${n} (id INTEGER);`);
      const result = migrate(db, { dir, backupDir: backups });
      expect(result.backup).not.toBeNull();
    }
    const kept = listMigrationBackups(backups);
    expect(kept).toHaveLength(5);
    for (const name of kept) expect(statSync(join(backups, name)).mode & 0o777).toBe(0o600);
    expect(readdirSync(backups).every((name) => name.endsWith(".db"))).toBe(true);
  });

  it("does not write a backup for the very first migration of an empty database", () => {
    const dir = migrationDir({ "0001_one.sql": "CREATE TABLE one (id INTEGER);" });
    const backups = join(root, "db-backups");
    const db = track(openDatabase(join(root, "panel.db")));
    expect(migrate(db, { dir, backupDir: backups }).backup).toBeNull();
    expect(listMigrationBackups(backups)).toEqual([]);
  });

  it("refuses two migrations that share a number", () => {
    const dir = migrationDir({ "0001_a.sql": "SELECT 1;", "0001_b.sql": "SELECT 1;" });
    const db = track(openDatabase(join(root, "panel.db")));
    expect(() => migrate(db, { dir, backupDir: join(root, "b") })).toThrow(/share the number 1/);
  });

  it("keeps the migration history readable as stored text", () => {
    const db = track(openDatabase(join(root, "panel.db")));
    migrate(db, { dir: bundledMigrationsDirectory(), backupDir: join(root, "b") });
    const row = db.prepare("SELECT checksum FROM schema_migrations WHERE name = '0001_initial.sql'").get() as { checksum: string };
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(bundledMigrationsDirectory(), "0001_initial.sql"), "utf8")).toContain("CREATE TABLE servers");
  });
});
