// Plugin updates from GitHub releases. Each repository's newest release is read, and each plugin a server names is installed from the
// release's jar of that name: the most recently uploaded one whose name is the plugin followed by a version, ignoring case. A jar is kept
// only when its sha256 matches the digest GitHub publishes for it, and a release without a digest is refused, since the download has
// nothing to be checked against. The token goes only to the API host over https, and a redirect is followed without it. Older jars of a
// plugin are removed once its new one is in place, so a failure leaves the old jar working.
import { createHash, randomBytes } from "node:crypto";
import { constants, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { sha256File } from "../backups/backup.js";

export class UpdateError extends Error {}

export type Fetcher = (url: string, init: { headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

/** A repository that a server takes plugins from: the plugins it names, and the token that reads the repository when there is one. */
export interface SourceRequest {
  readonly repo: string;
  readonly plugins: readonly string[];
  readonly token: string | null;
}

export interface PluginOutcome {
  readonly repo: string;
  readonly plugin: string;
  readonly status: "updated" | "current" | "failed";
  readonly asset: string | null;
  readonly removed: string[];
  readonly message: string | null;
}

const MAX_REDIRECTS = 5;
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
// A run starts no new repository or plugin once it has used this long, so one run cannot hold the server's update lock for long.
const RUN_LIMIT_MS = 10 * 60_000;
const OUT_OF_TIME = "the update ran out of time before this plugin was reached";
const JAR = /^[A-Za-z0-9._-]+\.jar$/;
// The version starts with digits, so `jass` does not claim `jass-2fa-1.0.jar`, whose plugin is `jass-2fa`. A qualifier such as SNAPSHOT is allowed.
const VERSIONED = "-\\d+(?:\\.\\d+)*(?:[-_][A-Za-z0-9.]+)?\\.jar$";
const releaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({ id: z.number().int(), name: z.string(), updated_at: z.string(), digest: z.string().nullable().optional() })),
});
type Release = z.infer<typeof releaseSchema>;
type Asset = Release["assets"][number];

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The plugin a jar belongs to: the name before its version, which is how a release names it. */
function pluginOf(assetName: string): string | null {
  if (!JAR.test(assetName)) return null;
  return new RegExp(`^(.+?)${VERSIONED}`).exec(assetName)?.[1] ?? null;
}

/** The jar a plugin installs from a release: the most recently uploaded one whose name is the plugin followed by a version, ignoring case. */
export function chooseAsset(assets: readonly Asset[], plugin: string): Asset | null {
  const pattern = new RegExp(`^${escapeForRegex(plugin)}${VERSIONED}`, "i");
  const matches = assets.filter((asset) => JAR.test(asset.name) && pattern.test(asset.name)).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  return matches[matches.length - 1] ?? null;
}

/** The plugins a release offers, each once, with the jar each installs from. */
export function catalogueOf(assets: readonly Asset[]): { name: string; asset: string }[] {
  const names = new Map<string, string>();
  for (const asset of assets) {
    const name = pluginOf(asset.name);
    if (name !== null && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return [...names.values()].flatMap((name) => {
    const asset = chooseAsset(assets, name);
    return asset === null ? [] : [{ name, asset: asset.name }];
  });
}

function requestHeaders(token: string | null): Record<string, string> {
  return { Accept: "application/vnd.github+json", "User-Agent": "jass-panel", ...(token === null ? {} : { Authorization: `Bearer ${token}` }) };
}

function withoutAuth(headers: Record<string, string>): Record<string, string> {
  const { Authorization: _dropped, ...rest } = headers;
  return rest;
}

/** Follows redirects by hand. Every address must be https; the headers go only to the API host on its default port, never to a redirect. */
async function follow(fetcher: Fetcher, url: string, headers: Record<string, string>): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = new URL(current);
    if (target.protocol !== "https:") throw new UpdateError("GitHub named an address that is not https, so it was not followed");
    const toApi = target.hostname === "api.github.com" && target.port === "";
    let response: Response;
    try {
      response = await fetcher(current, { headers: toApi ? headers : withoutAuth(headers), redirect: "manual", signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new UpdateError("GitHub could not be reached");
    }
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (location === null) throw new UpdateError("a download redirected without a destination");
    current = new URL(location, current).toString();
  }
  throw new UpdateError("a download redirected too many times");
}

async function newestRelease(fetcher: Fetcher, repo: string, token: string | null): Promise<Release> {
  const response = await follow(fetcher, `https://api.github.com/repos/${repo}/releases/latest`, requestHeaders(token));
  if (!response.ok) throw new UpdateError(`the release could not be read (HTTP ${response.status})`);
  const parsed = releaseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new UpdateError("the release listing was not in the expected shape");
  return parsed.data;
}

/** The plugins the newest release of a repository offers, for a person choosing which to install. */
export async function catalogue(fetcher: Fetcher, repo: string, token: string | null): Promise<{ repo: string; release: string; plugins: { name: string; asset: string }[] }> {
  const release = await newestRelease(fetcher, repo, token);
  return { repo, release: release.tag_name, plugins: catalogueOf(release.assets) };
}

/** Downloads a jar beside its target and renames it in only when its digest matches. Writes are awaited through a link-refusing file handle. */
async function download(fetcher: Fetcher, source: SourceRequest, asset: Asset, digest: string, target: string): Promise<void> {
  const headers = { ...requestHeaders(source.token), Accept: "application/octet-stream" };
  const response = await follow(fetcher, `https://api.github.com/repos/${source.repo}/releases/assets/${asset.id}`, headers);
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new UpdateError(`the jar could not be downloaded (HTTP ${response.status})`);
  }
  // The panel's own temporary name, so a download a death interrupted is swept at start-up and left out of backups like any other write.
  const partial = join(dirname(target), `.jass-panel-${randomBytes(6).toString("hex")}.partial`);
  rmSync(partial, { force: true });
  const hash = createHash("sha256");
  let bytes = 0;
  const file = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > MAX_ASSET_BYTES) throw new UpdateError("the jar is larger than the panel accepts");
      hash.update(chunk);
      for (let offset = 0; offset < chunk.byteLength; ) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten === 0) throw new UpdateError("the jar could not be written in full");
        offset += bytesWritten;
      }
    }
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    rmSync(partial, { force: true });
    throw error;
  }
  const written = await file.stat();
  await file.close();
  if (hash.digest("hex") !== digest) {
    rmSync(partial, { force: true });
    throw new UpdateError(`the downloaded ${asset.name} does not match its published digest, so it was not installed`);
  }
  // The bytes were written through this handle. A different file under the name now was swapped in, so the swapped file is not installed.
  const onDisk = lstatSync(partial, { throwIfNoEntry: false });
  if (onDisk === undefined || onDisk.dev !== written.dev || onDisk.ino !== written.ino) {
    throw new UpdateError(`the download of ${asset.name} was replaced before it was installed, so it was not installed`);
  }
  renameSync(partial, target);
}

/** Removes the other jars of a plugin, which the new one replaces. Only regular files named for the plugin's version are touched, so no other plugin or directory is. */
function removeOlder(folder: string, plugin: string, keep: string): string[] {
  const pattern = new RegExp(`^${escapeForRegex(plugin)}${VERSIONED}`, "i");
  const old = readdirSync(folder).filter((name) => name !== keep && pattern.test(name) && lstatSync(join(folder, name), { throwIfNoEntry: false })?.isFile() === true);
  for (const name of old) rmSync(join(folder, name), { force: true });
  return old;
}

/** Installs one plugin. A jar already in place with the published digest is kept; a directory, pipe or link under its name is refused. */
async function installOne(fetcher: Fetcher, source: SourceRequest, release: Release, plugin: string, folder: string): Promise<PluginOutcome> {
  const asset = chooseAsset(release.assets, plugin);
  if (asset === null) return { repo: source.repo, plugin, status: "failed", asset: null, removed: [], message: `the newest release has no jar for ${plugin}` };
  const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "")?.[1];
  if (digest === undefined) throw new UpdateError(`the release publishes no sha256 digest for ${asset.name}, so it is refused`);
  mkdirSync(folder, { recursive: true, mode: 0o755 });
  const target = join(folder, asset.name);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isFile()) throw new UpdateError(`${asset.name} is in the plugin folder and is not a regular file, so it was not replaced`);
  const current = existing !== undefined && (await sha256File(target)) === digest;
  if (!current) await download(fetcher, source, asset, digest, target);
  return { repo: source.repo, plugin, status: current ? "current" : "updated", asset: asset.name, removed: removeOlder(folder, plugin, asset.name), message: null };
}

/** What a failure says of itself: the reason for a known failure, and otherwise the system error code or the error's name, neither of which carries a path or a URL the way a message can. */
export function reasonOf(error: unknown): string {
  if (error instanceof UpdateError) return error.message;
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  const label = typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : error instanceof Error ? error.name : "unknown";
  return `unexpected error (${label})`;
}

/**
 * Updates the plugins a server names, from each repository in turn. A failure is reported against the plugin it concerns and does not stop
 * the others. A repository whose release cannot be read fails each of its plugins with the same reason.
 */
export async function updatePlugins(fetcher: Fetcher, sources: readonly SourceRequest[], folder: string): Promise<PluginOutcome[]> {
  const results: PluginOutcome[] = [];
  const limit = performance.now() + RUN_LIMIT_MS;
  for (const source of sources) {
    const fail = (plugin: string, message: string) => results.push({ repo: source.repo, plugin, status: "failed", asset: null, removed: [], message });
    let release: Release | null = null;
    let reason = "";
    try {
      if (performance.now() > limit) throw new UpdateError(OUT_OF_TIME);
      release = await newestRelease(fetcher, source.repo, source.token);
    } catch (error) {
      reason = reasonOf(error);
    }
    for (const plugin of source.plugins) {
      if (release === null) { fail(plugin, reason); continue; }
      if (performance.now() > limit) { fail(plugin, OUT_OF_TIME); continue; }
      try {
        results.push(await installOne(fetcher, source, release, plugin, folder));
      } catch (error) {
        fail(plugin, reasonOf(error));
      }
    }
  }
  return results;
}

/** The part of a run that goes to the audit log: what changed and what failed, by name. A token or a URL never goes there. */
export function summaryOf(results: readonly PluginOutcome[]): { updated: string[]; current: number; failed: string[] } {
  return {
    updated: results.filter((result) => result.status === "updated").map((result) => result.asset ?? result.plugin),
    current: results.filter((result) => result.status === "current").length,
    failed: results.filter((result) => result.status === "failed").map((result) => `${result.repo} ${result.plugin}`),
  };
}
