// The restore record and the start-up reconciliation. Archives are made and restored with the real tar; systemctl is stubbed as
// stopped, so no unit is created. The interrupted cases are built on disk the way a death between two renames would leave them.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, leftoversOf, reconcileRestores, restoreBackup, restoreJournalOf, restoreJournalSchema, type RestoreJournal } from "../../src/server/backups/backup.js";
import { loadConfig, type PanelConfig } from "../../src/server/config/config.js";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";
import { OperationLocks } from "../../src/server/power/lock.js";
import { Readiness } from "../../src/server/power/readiness.js";
import { runProcess, type Runner } from "../../src/server/systemd/run.js";

const ACTOR = { id: "owner-journal", label: "owner@test" };
const STAMP = "20260103T000000000Z";

let root: string;
let config: PanelConfig;
let db: PanelDatabase;
let directory: string;

/** Answers every systemctl call as a stopped unit; everything else (tar in particular) runs for real. */
const stoppedSystemd: Runner = (argv, options) => {
  if (argv[0] === "systemctl") {
    return Promise.resolve({ code: 0, signal: null, stdout: "Id=jass-mc-alpha.service\nActiveState=inactive\nSubState=dead\nResult=success\n", stderr: "" });
  }
  return runProcess(argv, options);
};

function deps() {
  return { db, config, run: stoppedSystemd, locks: new OperationLocks(), readiness: new Readiness(), zstd: false, sleep: () => Promise.resolve() };
}

function writeWorld(content: string): void {
  mkdirSync(join(directory, "world"), { recursive: true });
  writeFileSync(join(directory, "world", "level.dat"), content);
}

function readWorld(folder = directory): string {
  return readFileSync(join(folder, "world", "level.dat"), "utf8");
}

function writeJournal(record: RestoreJournal | string): string {
  mkdirSync(config.paths.markers, { recursive: true, mode: 0o700 });
  const file = restoreJournalOf(config, "alpha");
  writeFileSync(file, typeof record === "string" ? record : JSON.stringify(restoreJournalSchema.parse(record)));
  return file;
}

function journalFor(): RestoreJournal {
  return { directory, staging: join(root, `.alpha.restore-${STAMP}`), aside: join(root, `alpha.before-restore-${STAMP}`), startedAt: "2026-01-03T00:00:00.000Z" };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-journal-"));
  directory = join(root, "alpha");
  writeWorld("original\n");
  config = loadConfig({ PANEL_PUBLIC_ORIGIN: "https://example.net", PANEL_DATA_DIR: join(root, "data") }, { uid: 1000 });
  db = openDatabase(config.paths.database);
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  db.prepare("INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES ('alpha', 'Alpha', ?, ?, 'logs/latest.log', 'now', 'now')").run(directory, JSON.stringify(["/bin/true"]));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a restore that finishes", () => {
  it("puts the backed-up tree in place, keeps the replaced folder aside, and leaves no record", async () => {
    const backup = await createBackup(deps(), "alpha", ACTOR, "manual");
    writeWorld("changed\n");
    await restoreBackup(deps(), "alpha", backup.id, ACTOR);

    expect(readWorld()).toBe("original\n");
    expect(existsRecord()).toBe(false);
    const leftovers = leftoversOf(directory);
    expect(leftovers.some((name) => name.startsWith("alpha.before-restore-"))).toBe(true);
    expect(readWorld(join(root, leftovers.find((name) => name.startsWith("alpha.before-restore-")) ?? ""))).toBe("changed\n");
  });

  it("restores into a folder that is missing, and moves nothing aside", async () => {
    const backup = await createBackup(deps(), "alpha", ACTOR, "manual");
    rmSync(directory, { recursive: true, force: true });
    await restoreBackup(deps(), "alpha", backup.id, ACTOR);

    expect(readWorld()).toBe("original\n");
    expect(leftoversOf(directory)).toEqual([]);
    expect(existsRecord()).toBe(false);
  });
});

describe("start-up after an interrupted restore", () => {
  it("puts back a folder that moved aside with nothing in its place, and clears the record", () => {
    const journal = journalFor();
    renameFolder(directory, journal.aside);
    writeJournal(journal);

    const problems = reconcileRestores({ db, config });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toMatch(/put back/);
    expect(readWorld()).toBe("original\n");
    expect(existsRecord()).toBe(false);
  });

  it("leaves a folder that is in place alone, and lists the staging folder beside it as a leftover", () => {
    const journal = journalFor();
    mkdirSync(journal.staging);
    writeJournal(journal);

    const problems = reconcileRestores({ db, config });
    expect(problems[0]?.message).toMatch(/did not complete/);
    expect(readWorld()).toBe("original\n");
    expect(existsRecord()).toBe(false);
    expect(leftoversOf(directory)).toContain(`.alpha.restore-${STAMP}`);
  });

  it("reports a record that does not match the server, and touches no folder", () => {
    const journal = { ...journalFor(), directory: join(root, "elsewhere") };
    const file = writeJournal(journal);
    renameFolder(directory, journal.aside);

    const problems = reconcileRestores({ db, config });
    expect(problems[0]?.message).toMatch(/does not match/);
    expect(readdirSync(root)).toContain(`alpha.before-restore-${STAMP}`);
    expect(readdirSync(root)).not.toContain("alpha");
    expect(readFileSync(file, "utf8")).toContain("elsewhere");
  });

  it("reports a record that cannot be read, and keeps it for a person to look at", () => {
    const file = writeJournal("{ not json");
    const problems = reconcileRestores({ db, config });
    expect(problems[0]?.message).toMatch(/does not match/);
    expect(readWorld()).toBe("original\n");
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("reports a folder that is missing with nothing to put back", () => {
    writeJournal(journalFor());
    rmSync(directory, { recursive: true, force: true });

    const problems = reconcileRestores({ db, config });
    expect(problems[0]?.message).toMatch(/missing/);
    expect(existsRecord()).toBe(false);
  });
});

function existsRecord(): boolean {
  try {
    readFileSync(restoreJournalOf(config, "alpha"));
    return true;
  } catch {
    return false;
  }
}

function renameFolder(from: string, to: string): void {
  // The rename is what a restore does to the folder; using fs directly keeps the setup independent of the code under test.
  renameSync(from, to);
}

describe("the checks before a restore touches a folder", () => {
  it("refuses to restore when the archive could not be listed in full, and extracts nothing", async () => {
    const backup = await createBackup(deps(), "alpha", ACTOR, "manual");
    const unreadable: Runner = (argv, options) =>
      argv.includes("-tf") || argv.includes("-tvf") ? Promise.resolve({ code: 2, signal: null, stdout: "", stderr: "" }) : stoppedSystemd(argv, options);
    await expect(restoreBackup({ ...deps(), run: unreadable }, "alpha", backup.id, ACTOR)).rejects.toThrow(/could not be listed in full/);
    expect(readWorld()).toBe("original\n");
    expect(leftoversOf(directory)).toEqual([]);
  });

  it("refuses to start while an earlier restore record has not been settled", async () => {
    const backup = await createBackup(deps(), "alpha", ACTOR, "manual");
    writeJournal(journalFor());
    await expect(restoreBackup(deps(), "alpha", backup.id, ACTOR)).rejects.toThrow(/left a record that start-up could not settle/);
    expect(readWorld()).toBe("original\n");
  });
});

describe("start-up after a restore that left no trace beside the folder", () => {
  it("reports the outcome as not known, and says the folder is in place, rather than claiming a restore completed", () => {
    writeJournal(journalFor());
    const problems = reconcileRestores({ db, config });
    expect(problems[0]?.message).toMatch(/does not show how far it got/);
    expect(readWorld()).toBe("original\n");
    expect(existsRecord()).toBe(false);
  });
});
