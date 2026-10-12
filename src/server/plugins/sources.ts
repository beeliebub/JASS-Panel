// A server's plugin sources: the repositories its plugins come from, the plugins it installs from each, and the folder they go into. A
// token is a secret: it is written and read only here and by the updater, and the API reports only whether one is set. Tokens are kept per
// repository, so changing the plugins a repository supplies does not lose the token it is read with.
import { z } from "zod";
import type { PanelDatabase } from "../db/open.js";
import { checkRelativePath } from "../files/jail.js";
import { repoName, type PluginSourcesBody } from "../../shared/features.js";

export interface StoredSource {
  readonly repo: string;
  readonly plugins: string[];
  readonly token: string | null;
}

export interface StoredSources {
  readonly pluginDir: string | null;
  readonly sources: StoredSource[];
}

const storedRow = z.strictObject({ repo: repoName, plugins: z.string(), token: z.string().nullable(), pluginDir: z.string() });
const storedPlugins = z.array(z.string());

/** A server's sources as stored. A row that does not parse is an error: nothing is guessed from it. */
export function getSources(db: PanelDatabase, serverId: string): StoredSources {
  const rows = db
    .prepare("SELECT repo, plugins, token, plugin_dir AS pluginDir FROM plugin_sources WHERE server_id = ? ORDER BY id")
    .all(serverId)
    .map((row) => storedRow.parse(row));
  return {
    pluginDir: rows[0]?.pluginDir ?? null,
    sources: rows.map((row) => ({ repo: row.repo, plugins: storedPlugins.parse(JSON.parse(row.plugins)), token: row.token })),
  };
}

/** Replaces a server's sources. A source given without a token keeps the token stored for the same repository; an empty token clears it. */
export function setSources(db: PanelDatabase, serverId: string, body: PluginSourcesBody): void {
  checkRelativePath(body.pluginDir);
  db.transaction(() => {
    const kept = new Map(getSources(db, serverId).sources.map((source) => [source.repo, source.token] as const));
    db.prepare("DELETE FROM plugin_sources WHERE server_id = ?").run(serverId);
    const insert = db.prepare("INSERT INTO plugin_sources (server_id, repo, plugins, plugin_dir, token) VALUES (?, ?, ?, ?, ?)");
    for (const source of body.sources) {
      const token = source.token === undefined ? (kept.get(source.repo) ?? null) : source.token === null || source.token === "" ? null : source.token;
      insert.run(serverId, source.repo, JSON.stringify(source.plugins), body.pluginDir, token);
    }
  })();
}

/** The token stored for one repository of a server, or null when there is none. */
export function tokenOf(db: PanelDatabase, serverId: string, repo: string): string | null {
  return getSources(db, serverId).sources.find((source) => source.repo === repo)?.token ?? null;
}
