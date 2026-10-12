// The daily copy of the panel's database: a copy that opens and holds the rows, private to its owner, and only the newest copies kept.
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyDatabase } from "../../src/server/db/copy.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";

let root: string;
let db: PanelDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-db-copy-"));
  db = openDatabase(join(root, "panel.db"));
  db.exec("CREATE TABLE marks (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
  db.prepare("INSERT INTO marks (note) VALUES (?)").run("kept");
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("copyDatabase", () => {
  it("writes a copy that opens with its rows, private to the owner, and keeps only the newest copies", () => {
    const folder = join(root, "db-backups");
    const days = [new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 2)), new Date(Date.UTC(2026, 0, 3))];
    for (const day of days) copyDatabase(db, folder, day, 2);
    expect(readdirSync(folder).sort()).toEqual(["daily-20260102T000000000Z.db", "daily-20260103T000000000Z.db"]);
    const newest = join(folder, "daily-20260103T000000000Z.db");
    expect(statSync(newest).mode & 0o777).toBe(0o600);
    const copy = new Database(newest, { readonly: true });
    try {
      expect(copy.prepare("SELECT note FROM marks").all()).toEqual([{ note: "kept" }]);
    } finally {
      copy.close();
    }
  });

  it("writes no copy while the newest one is younger than the minimum age", () => {
    const folder = join(root, "db-backups");
    expect(copyDatabase(db, folder, new Date(), 7, 24 * 60 * 60_000)).not.toBeNull();
    expect(copyDatabase(db, folder, new Date(), 7, 24 * 60 * 60_000)).toBeNull();
    expect(readdirSync(folder)).toHaveLength(1);
  });

  it("keeps the copy it has just written when a clock that stepped back makes it the oldest", () => {
    const folder = join(root, "db-backups");
    copyDatabase(db, folder, new Date(Date.UTC(2026, 0, 2)), 2);
    copyDatabase(db, folder, new Date(Date.UTC(2026, 0, 3)), 2);
    expect(copyDatabase(db, folder, new Date(Date.UTC(2026, 0, 1)), 2)).not.toBeNull();
    expect(readdirSync(folder).sort()).toEqual(["daily-20260101T000000000Z.db", "daily-20260103T000000000Z.db"]);
  });
});
