// The sources a server takes plugins from: what may be stored, what a save does to a repository's token, and what a stored row that does not
// parse does to a read.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginSourcesBodySchema, type PluginSourcesBody } from "../../shared/features.js";
import { bundledMigrationsDirectory, migrate } from "../db/migrate.js";
import { openDatabase, type PanelDatabase } from "../db/open.js";
import { JailError } from "../files/jail.js";
import { getSources, setSources, tokenOf } from "./sources.js";

let root: string;
let db: PanelDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-sources-"));
  db = openDatabase(join(root, "panel.db"));
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: join(root, "backups") });
  db.prepare("INSERT INTO servers (id, display_name, directory, start_command, log_path, created_at, updated_at) VALUES ('alpha', 'Alpha', ?, ?, 'logs/latest.log', 'now', 'now')").run(join(root, "alpha"), JSON.stringify(["/bin/true"]));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function body(sources: unknown[], pluginDir = "plugins"): PluginSourcesBody {
  return pluginSourcesBodySchema.parse({ pluginDir, sources });
}

describe("what may be stored", () => {
  it("refuses a repository listed twice, and a plugin named by two repositories whatever its case", () => {
    expect(pluginSourcesBodySchema.safeParse({ pluginDir: "plugins", sources: [{ repo: "a/b", plugins: [] }, { repo: "a/b", plugins: [] }] }).success).toBe(false);
    expect(pluginSourcesBodySchema.safeParse({ pluginDir: "plugins", sources: [{ repo: "a/b", plugins: ["Core"] }, { repo: "c/d", plugins: ["core"] }] }).success).toBe(false);
    expect(pluginSourcesBodySchema.safeParse({ pluginDir: "plugins", sources: [{ repo: "a/b", plugins: ["core", "core"] }] }).success).toBe(false);
  });

  it("allows eight repositories and sixteen plugins each, and no more", () => {
    const repos = Array.from({ length: 8 }, (_, index) => ({ repo: `owner/repo${index}`, plugins: [] }));
    expect(pluginSourcesBodySchema.safeParse({ pluginDir: "plugins", sources: repos }).success).toBe(true);
    expect(pluginSourcesBodySchema.safeParse({ pluginDir: "plugins", sources: [...repos, { repo: "owner/ninth", plugins: [] }] }).success).toBe(false);
    const plugins = Array.from({ length: 17 }, (_, index) => `plugin-${index}`);
    expect(pluginSourcesBodySchema.safeParse({ pluginDir: "plugins", sources: [{ repo: "a/b", plugins }] }).success).toBe(false);
  });

  it("refuses a repository name that is not owner/name, and a plugin name with a path in it", () => {
    for (const repo of ["owner", "a/b/c", "../x", "a b/c"]) {
      expect(pluginSourcesBodySchema.safeParse({ pluginDir: "plugins", sources: [{ repo, plugins: [] }] }).success, repo).toBe(false);
    }
    expect(pluginSourcesBodySchema.safeParse({ pluginDir: "plugins", sources: [{ repo: "a/b", plugins: ["../evil"] }] }).success).toBe(false);
  });

  it("refuses a plugin folder outside the server folder", () => {
    expect(() => setSources(db, "alpha", body([], "../elsewhere"))).toThrow(JailError);
    expect(() => setSources(db, "alpha", body([], "/etc"))).toThrow(JailError);
  });
});

describe("what a save does to a token", () => {
  it("keeps a repository's token when a save names no token, clears it on an empty token or null, and gives a new repository none", () => {
    setSources(db, "alpha", body([{ repo: "owner/one", plugins: ["jass-core"], token: "tok-one" }, { repo: "owner/two", plugins: ["jass-main"], token: "tok-two" }]));
    setSources(db, "alpha", body([{ repo: "owner/one", plugins: ["jass-core", "jass-connector"] }, { repo: "owner/two", plugins: ["jass-main"], token: "" }, { repo: "owner/three", plugins: [] }]));
    expect(tokenOf(db, "alpha", "owner/one")).toBe("tok-one");
    expect(tokenOf(db, "alpha", "owner/two")).toBeNull();
    expect(tokenOf(db, "alpha", "owner/three")).toBeNull();
    expect(getSources(db, "alpha")).toEqual({
      pluginDir: "plugins",
      sources: [
        { repo: "owner/one", plugins: ["jass-core", "jass-connector"], token: "tok-one" },
        { repo: "owner/two", plugins: ["jass-main"], token: null },
        { repo: "owner/three", plugins: [], token: null },
      ],
    });
  });

  it("drops a repository that a save no longer lists, together with its token", () => {
    setSources(db, "alpha", body([{ repo: "owner/one", plugins: [], token: "tok-one" }, { repo: "owner/two", plugins: [], token: "tok-two" }]));
    setSources(db, "alpha", body([{ repo: "owner/one", plugins: [] }]));
    expect(getSources(db, "alpha").sources.map((source) => source.repo)).toEqual(["owner/one"]);
    expect(tokenOf(db, "alpha", "owner/two")).toBeNull();
  });
});

describe("what a read does with a stored row it cannot parse", () => {
  it("throws rather than guessing a plugin list", () => {
    db.prepare("INSERT INTO plugin_sources (server_id, repo, plugins, plugin_dir, token) VALUES ('alpha', 'owner/one', '{not json', 'plugins', NULL)").run();
    expect(() => getSources(db, "alpha")).toThrow();
  });
});

describe("what a read does with a stored repository name", () => {
  it("refuses one that breaks the rule a saved name must keep", () => {
    db.prepare("INSERT INTO plugin_sources (server_id, repo, plugins, plugin_dir, token) VALUES ('alpha', '../x', '[]', 'plugins', NULL)").run();
    expect(() => getSources(db, "alpha")).toThrow();
  });
});
