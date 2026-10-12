// Opens the panel's database. The connection takes an exclusive lock before anything is read or written, so a second daemon
// pointed at the same data directory fails at start-up instead of running the schedules twice. The file is created mode 0600
// because it holds the same secrets as the backups of it.
//
// Nothing else in the daemon may open the database file with the filesystem API while the connection is open: closing any
// descriptor for a file releases every POSIX lock the process holds on it, which would drop the exclusive lock.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type PanelDatabase = Database.Database;

export class DatabaseLockedError extends Error {}

export function openDatabase(file: string): PanelDatabase {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) closeSync(openSync(file, "wx", 0o600));
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma("locking_mode = EXCLUSIVE");
    // A plain read does not keep the lock in exclusive mode; BEGIN EXCLUSIVE does, and it is what makes a second process
    // fail here, before it writes anything.
    db.exec("BEGIN EXCLUSIVE; COMMIT;");
  } catch (error) {
    db.close();
    throw new DatabaseLockedError(
      `The panel database at ${file} is in use by another panel process: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  db.pragma("foreign_keys = ON");
  chmodSync(file, 0o600);
  return db;
}
