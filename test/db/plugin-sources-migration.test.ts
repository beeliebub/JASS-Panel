// The move from one prefix per server to a list of plugins per repository: a row that exists keeps its token, and its prefix becomes the
// first entry of its list. A repository cannot appear twice for one server afterwards.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundledMigrationsDirectory, migrate } from "../../src/server/db/migrate.js";
import { openDatabase, type PanelDatabase } from "../../src/server/db/open.js";

let root: string;
let db: PanelDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-plugin-migration-"));
  db = openDatabase(join(root, "panel.db"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the plugin sources migration", () => {
  it("keeps the source as the first entry of its plugin list, with its token, and refuses a second row for the same repository", () => {
    const first = join(root, "first");
    mkdirSync(first);
    copyFileSync(join(bundledMigrationsDirectory(), "0001_initial.sql"), join(first, "0001_initial.sql"));
    migrate(db, { dir: first, backupDir: join(root, "backups") });
    db.prepare("INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES ('alpha', 'Alpha', ?, ?, 'logs/latest.log', 'now', 'now')").run(join(root, "alpha"), JSON.stringify(["/bin/true"]));
    db.prepare("INSERT INTO plugin_sources (server_id, repo, asset_prefix, plugin_dir, token) VALUES ('alpha', 'owner/plugins', 'jass-core', 'plugins', 'kept-token')").run();

    const result = migrate(db, { dir: bundledMigrationsDirectory(), backupDir: join(root, "backups") });
    expect(result.applied).toEqual(["0002_plugin_sources_many.sql", "0003_autostart_matches_units.sql"]);
    expect(db.prepare("SELECT repo, plugins, token FROM plugin_sources WHERE server_id = 'alpha'").all()).toEqual([
      { repo: "owner/plugins", plugins: '["jass-core"]', token: "kept-token" },
    ]);
    expect(() => db.prepare("INSERT INTO plugin_sources (server_id, repo, plugins, plugin_dir, token) VALUES ('alpha', 'owner/plugins', '[]', 'plugins', NULL)").run()).toThrow(/UNIQUE/);
  });
});
