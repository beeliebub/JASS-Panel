// Where a server's plugins come from: the repositories they are read from, the plugins installed from each, and whether they are updated
// when the server starts. A repository's plugins are listed from its newest release, so they can be chosen by name. A token is write-only:
// the page says whether one is saved for a repository and never shows it.
import { useEffect, useState, type FormEvent } from "react";
import { PLUGIN_SOURCES_MAX, pluginCatalogueSchema, pluginSourcesSchema, pluginUpdateSchema } from "@shared/features.js";
import { z } from "zod";
import { PanelApiError, type ApiClient } from "../../api/client";
import { StateMessage } from "../../components/StateMessage";

const field = "w-full rounded-panel border border-panel-line bg-panel-soft px-3 py-2 text-sm";
const savedSchema = z.strictObject({ saved: z.literal(true) });
const onStartSchema = z.strictObject({ updateOnStart: z.boolean() });
type Results = z.infer<typeof pluginUpdateSchema>["results"];
type Result = Results[number];

/** One repository as the form holds it. A typed token is sent with the next request; a saved one is kept unless it is removed. */
interface Draft {
  readonly key: number;
  readonly repo: string;
  readonly plugins: readonly string[];
  readonly offered: readonly string[] | null;
  readonly tokenSaved: boolean;
  readonly token: string;
  readonly removeToken: boolean;
}

function problem(failure: unknown, fallback: string): string {
  return failure instanceof PanelApiError ? failure.message : fallback;
}

/** The token part of a request: null to remove the saved token, the typed one, or nothing, which keeps the saved one. */
function tokenPart(draft: Draft): { token?: string | null } {
  if (draft.removeToken) return { token: null };
  return draft.token.length > 0 ? { token: draft.token } : {};
}

function resultText(result: Result): string {
  if (result.status === "failed") return `not updated: ${result.message ?? "the update failed"}`;
  if (result.status === "current") return `already current (${result.asset ?? ""})`;
  const removed = result.removed.length > 0 ? `; removed ${result.removed.join(", ")}` : "";
  return `installed ${result.asset ?? ""}${removed}`;
}

export function PluginsTab({ client, serverId, canWrite }: { readonly client: ApiClient; readonly serverId: string; readonly canWrite: boolean }) {
  const base = `/api/v1/servers/${encodeURIComponent(serverId)}`;
  const [pluginDir, setPluginDir] = useState("plugins");
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [nextKey, setNextKey] = useState(1);
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    client
      .get(`${base}/plugin-sources`, pluginSourcesSchema, controller.signal)
      .then((loaded) => {
        setPluginDir(loaded.pluginDir ?? "plugins");
        setDrafts(loaded.sources.map((source, index) => ({ key: index + 1, repo: source.repo, plugins: source.plugins, offered: null, tokenSaved: source.tokenConfigured, token: "", removeToken: false })));
        setNextKey(loaded.sources.length + 1);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(problem(failure, "The plugin sources could not be loaded."));
      });
    return () => controller.abort();
  }, [client, base, version]);

  function patch(key: number, change: Partial<Draft>): void {
    setDrafts((current) => current?.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)) ?? current);
  }

  function addSource(): void {
    setDrafts((current) =>
      current === null || current.length >= PLUGIN_SOURCES_MAX
        ? current
        : [...current, { key: nextKey, repo: "", plugins: [], offered: null, tokenSaved: false, token: "", removeToken: false }],
    );
    setNextKey((count) => count + 1);
  }

  function togglePlugin(draft: Draft, name: string): void {
    patch(draft.key, { plugins: draft.plugins.includes(name) ? draft.plugins.filter((plugin) => plugin !== name) : [...draft.plugins, name] });
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (drafts === null) return;
    setError(null);
    setMessage(null);
    try {
      await client.put(`${base}/plugin-sources`, savedSchema, {
        pluginDir,
        sources: drafts.map((draft) => ({ repo: draft.repo.trim(), plugins: [...draft.plugins], ...tokenPart(draft) })),
      });
      setMessage("The plugin sources are saved.");
      setVersion((count) => count + 1);
    } catch (failure) {
      setError(problem(failure, "The plugin sources were not saved."));
    }
  }

  async function listPlugins(draft: Draft): Promise<void> {
    setError(null);
    try {
      const listed = await client.post(`${base}/plugin-catalogue`, pluginCatalogueSchema, { repo: draft.repo.trim(), ...tokenPart(draft) });
      patch(draft.key, { offered: listed.plugins.map((plugin) => plugin.name) });
      setMessage(`Listed the plugins in ${listed.repo}, release ${listed.release}.`);
    } catch (failure) {
      setError(problem(failure, "The plugins could not be listed."));
    }
  }

  async function updateNow(): Promise<void> {
    setError(null);
    setMessage(null);
    try {
      const updated = await client.post(`${base}/plugins/update`, pluginUpdateSchema, {});
      setResults(updated.results);
      setMessage(updated.results.some((result) => result.status === "failed") ? "The update finished, with some plugins not updated." : "The update finished.");
    } catch (failure) {
      setError(problem(failure, "The update did not finish."));
    }
  }

  async function setOnStart(enabled: boolean): Promise<void> {
    setError(null);
    try {
      await client.put(`${base}/update-on-start`, onStartSchema, { enabled });
      setMessage(enabled ? "Plugins will be checked each time the server starts." : "Plugins are no longer checked at start.");
    } catch (failure) {
      setError(problem(failure, "The setting was not saved."));
    }
  }

  return (
    <section aria-label="Plugins" className="grid gap-4">
      {error !== null && <StateMessage title="Something did not work" tone="error">{error}</StateMessage>}
      {message !== null && <p className="text-sm text-panel-good" role="status">{message}</p>}
      {drafts === null && error === null && <StateMessage title="Loading the plugin sources" />}
      {drafts !== null && (
        <form className="grid gap-4" onSubmit={(event) => void save(event)}>
          <label className="grid gap-1 text-sm font-bold" htmlFor="plugin-dir">
            Plugin folder inside the server folder
            <input className={field} disabled={!canWrite} id="plugin-dir" onChange={(event) => setPluginDir(event.target.value)} value={pluginDir} />
          </label>
          {drafts.map((draft, index) => (
            <fieldset key={draft.key} className="grid gap-3 rounded-panel border border-panel-line bg-panel-surface p-4" disabled={!canWrite}>
              <legend className="px-1 text-sm font-bold">Repository {index + 1}</legend>
              <label className="grid gap-1 text-sm font-bold" htmlFor={`plugin-repo-${draft.key}`}>
                GitHub repository (owner/name)
                <input className={field} id={`plugin-repo-${draft.key}`} onChange={(event) => patch(draft.key, { repo: event.target.value, offered: null })} value={draft.repo} />
              </label>
              <label className="grid gap-1 text-sm font-bold" htmlFor={`plugin-token-${draft.key}`}>
                Access token (optional; {draft.tokenSaved && !draft.removeToken ? "one is saved for this repository" : "none is saved"})
                <input
                  autoComplete="off"
                  className={field}
                  id={`plugin-token-${draft.key}`}
                  onChange={(event) => patch(draft.key, { token: event.target.value, removeToken: false })}
                  placeholder={draft.tokenSaved ? "Leave empty to keep the saved token" : ""}
                  type="password"
                  value={draft.token}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button className="button button-secondary" disabled={draft.repo.trim() === ""} onClick={() => void listPlugins(draft)} type="button">
                  List its plugins
                </button>
                {draft.tokenSaved && !draft.removeToken && (
                  <button className="button button-secondary" onClick={() => patch(draft.key, { removeToken: true, token: "" })} type="button">
                    Remove the saved token
                  </button>
                )}
                {draft.removeToken && (
                  <button className="button button-secondary" onClick={() => patch(draft.key, { removeToken: false })} type="button">
                    Keep the saved token
                  </button>
                )}
                <button className="button button-secondary" onClick={() => setDrafts((current) => current?.filter((item) => item.key !== draft.key) ?? current)} type="button">
                  Remove this repository
                </button>
              </div>
              {draft.offered !== null && (
                <fieldset className="grid gap-2">
                  <legend className="text-sm font-bold">Plugins to install from this repository</legend>
                  {draft.offered.length === 0 && <p className="text-sm">The newest release has no plugin jars.</p>}
                  {draft.offered.map((name) => (
                    <label key={name} className="flex items-center gap-2 text-sm">
                      <input checked={draft.plugins.includes(name)} onChange={() => togglePlugin(draft, name)} type="checkbox" />
                      {name}
                    </label>
                  ))}
                </fieldset>
              )}
              <p className="text-sm">Installed from this repository: {draft.plugins.length > 0 ? draft.plugins.join(", ") : "none"}</p>
            </fieldset>
          ))}
          {canWrite && (
            <div className="flex flex-wrap justify-between gap-2">
              <button className="button button-secondary" disabled={drafts.length >= PLUGIN_SOURCES_MAX} onClick={addSource} type="button">
                Add a repository
              </button>
              <button className="button button-primary" type="submit">
                Save plugin sources
              </button>
            </div>
          )}
        </form>
      )}
      {canWrite && drafts !== null && (
        <div className="grid gap-3">
          <p className="text-sm">Updates use the saved sources, so save any change before updating.</p>
          <div className="flex flex-wrap items-center gap-3">
            <button className="button button-secondary" onClick={() => void updateNow()} type="button">Update plugins now</button>
            <button className="button button-secondary" onClick={() => void setOnStart(true)} type="button">Update on every start</button>
            <button className="button button-secondary" onClick={() => void setOnStart(false)} type="button">Stop updating on start</button>
          </div>
        </div>
      )}
      {results !== null && (
        <section aria-label="Last update" className="grid gap-2 rounded-panel border border-panel-line bg-panel-surface p-4">
          <h3 className="font-bold">Last update</h3>
          <ul className="grid gap-1 text-sm">
            {results.map((result) => (
              <li key={`${result.repo}/${result.plugin}`}>
                <span className="font-bold">{result.plugin}</span> from {result.repo}: {resultText(result)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
