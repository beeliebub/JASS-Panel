// The updater against a fake GitHub: the newest release, its jars and their digests. Nothing reaches the network, and every request the
// updater makes is recorded, so the token can be checked to go only to the API host and never into a result.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256File } from "../backups/backup.js";
import { catalogue, catalogueOf, chooseAsset, updatePlugins, type Fetcher } from "./updater.js";

const REPO = "owner/plugins";
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const TOKEN = "ghp_updater_test_token";

interface Jar {
  readonly id: number;
  readonly name: string;
  readonly updated: string;
  readonly bytes: Buffer;
}

const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * A fake GitHub for one repository. The newest release lists the jars, and a jar comes from its API asset URL, or from a storage host the
 * API redirects to. `badDigest` publishes a digest that the served bytes do not match.
 */
function github(jars: readonly Jar[], options: { readonly digests?: boolean; readonly redirect?: boolean; readonly badDigest?: boolean; readonly plainRedirect?: boolean } = {}) {
  const requests: { url: string; headers: Record<string, string>; redirect: string }[] = [];
  const fetcher: Fetcher = (url, init) => {
    requests.push({ url, headers: init.headers, redirect: init.redirect });
    if (url === LATEST) {
      const assets = jars.map((jar) => ({
        id: jar.id,
        name: jar.name,
        updated_at: jar.updated,
        digest: options.digests === false ? null : digest(options.badDigest === true ? Buffer.from("not the jar") : jar.bytes),
      }));
      return Promise.resolve(new Response(JSON.stringify({ tag_name: "release-1", assets }), { status: 200 }));
    }
    const asset = /^https:\/\/api\.github\.com\/repos\/owner\/plugins\/releases\/assets\/(\d+)$/.exec(url);
    const storage = /^https:\/\/objects\.example\.net\/(\d+)$/.exec(url);
    const jar = jars.find((candidate) => candidate.id === Number((asset ?? storage)?.[1]));
    if (jar === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    if (asset !== null && options.redirect === true) {
      return Promise.resolve(new Response(null, { status: 302, headers: { location: `${options.plainRedirect === true ? "http" : "https"}://objects.example.net/${jar.id}` } }));
    }
    return Promise.resolve(new Response(jar.bytes, { status: 200 }));
  };
  return { fetcher, requests };
}

const ASSETS = [
  { id: 1, name: "Jass-Core-1.0.jar", updated_at: "2026-01-01T00:00:00Z", digest: null },
  { id: 2, name: "jass-core-1.1.jar", updated_at: "2026-02-01T00:00:00Z", digest: null },
  { id: 3, name: "jass-core.jar", updated_at: "2026-03-01T00:00:00Z", digest: null },
  { id: 4, name: "jass-core-notes.zip", updated_at: "2026-04-01T00:00:00Z", digest: null },
  { id: 5, name: "jass-coreX-2.0.jar", updated_at: "2026-05-01T00:00:00Z", digest: null },
];

let base: string;
let folder: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "jass-panel-updater-"));
  folder = join(base, "plugins");
  mkdirSync(folder);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("choosing what to install", () => {
  it("takes the most recently uploaded jar of a plugin, ignoring case, and only a jar with a version", () => {
    expect(chooseAsset(ASSETS, "jass-core")?.name).toBe("jass-core-1.1.jar");
    expect(chooseAsset(ASSETS, "JASS-CORE")?.name).toBe("jass-core-1.1.jar");
    expect(chooseAsset(ASSETS, "jass-coreX")?.name).toBe("jass-coreX-2.0.jar");
    expect(chooseAsset(ASSETS, "jass")).toBeNull();
  });

  it("keeps a longer plugin name apart, and takes a version with a qualifier", () => {
    const TWO_FACTOR = [
      { id: 6, name: "jass-2fa-1.0.jar", updated_at: "2026-05-01T00:00:00Z", digest: null },
      { id: 7, name: "jass-1.2-SNAPSHOT.jar", updated_at: "2026-04-01T00:00:00Z", digest: null },
    ];
    expect(chooseAsset(TWO_FACTOR, "jass")?.name).toBe("jass-1.2-SNAPSHOT.jar");
    expect(chooseAsset(TWO_FACTOR, "jass-2fa")?.name).toBe("jass-2fa-1.0.jar");
    expect(catalogueOf(TWO_FACTOR)).toEqual([
      { name: "jass-2fa", asset: "jass-2fa-1.0.jar" },
      { name: "jass", asset: "jass-1.2-SNAPSHOT.jar" },
    ]);
  });

  it("lists each plugin once, with the jar it installs from", () => {
    expect(catalogueOf(ASSETS)).toEqual([
      { name: "Jass-Core", asset: "jass-core-1.1.jar" },
      { name: "jass-coreX", asset: "jass-coreX-2.0.jar" },
    ]);
  });
});

describe("installing", () => {
  const CORE = Buffer.from("core 1.1");
  const MAIN = Buffer.from("main 2.0");
  const JARS: Jar[] = [
    { id: 10, name: "jass-core-1.1.jar", updated: "2026-02-01T00:00:00Z", bytes: CORE },
    { id: 11, name: "jass-main-2.0.jar", updated: "2026-02-01T00:00:00Z", bytes: MAIN },
  ];

  it("installs each named plugin from its verified jar, and removes the older jars of only those plugins", async () => {
    writeFileSync(join(folder, "jass-core-1.0.jar"), "old core");
    writeFileSync(join(folder, "jass-skyblock-3.0.jar"), "a plugin that is not named");
    const results = await updatePlugins(github(JARS).fetcher, [{ repo: REPO, plugins: ["jass-core", "jass-main"], token: null }], folder);
    expect(results).toEqual([
      { repo: REPO, plugin: "jass-core", status: "updated", asset: "jass-core-1.1.jar", removed: ["jass-core-1.0.jar"], message: null },
      { repo: REPO, plugin: "jass-main", status: "updated", asset: "jass-main-2.0.jar", removed: [], message: null },
    ]);
    expect(readFileSync(join(folder, "jass-core-1.1.jar"))).toEqual(CORE);
    expect(readdirSync(folder).sort()).toEqual(["jass-core-1.1.jar", "jass-main-2.0.jar", "jass-skyblock-3.0.jar"]);
  });

  it("removes an older jar of its own plugin only, and leaves a longer plugin name and a directory alone", async () => {
    writeFileSync(join(folder, "jass-0.9.jar"), "old jass");
    writeFileSync(join(folder, "jass-2fa-0.9.jar"), "two factor");
    mkdirSync(join(folder, "jass-0.8.jar"));
    const JASS = [{ id: 20, name: "jass-1.0.jar", updated: "2026-02-01T00:00:00Z", bytes: Buffer.from("jass 1.0") }];
    const results = await updatePlugins(github(JASS).fetcher, [{ repo: REPO, plugins: ["jass"], token: null }], folder);
    expect(results[0]).toMatchObject({ status: "updated", removed: ["jass-0.9.jar"] });
    expect(readdirSync(folder).sort()).toEqual(["jass-0.8.jar", "jass-1.0.jar", "jass-2fa-0.9.jar"]);
  });

  it("sends the token to the API host only, never to a storage host it redirects to, and keeps it out of the results", async () => {
    const { fetcher, requests } = github(JARS.slice(0, 1), { redirect: true });
    const results = await updatePlugins(fetcher, [{ repo: REPO, plugins: ["jass-core"], token: TOKEN }], folder);
    expect(results[0]?.status).toBe("updated");
    const api = requests.filter((request) => request.url.startsWith("https://api.github.com/"));
    const storage = requests.filter((request) => request.url.startsWith("https://objects.example.net/"));
    expect(api.every((request) => request.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(storage).toHaveLength(1);
    expect(storage.every((request) => request.headers.Authorization === undefined)).toBe(true);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
    expect(JSON.stringify(results)).not.toContain(TOKEN);
  });

  it("does not send the token to the API host on another port, which a redirect may name", async () => {
    const fake = github(JARS.slice(0, 1));
    const moved = "https://api.github.com:8443/blobs/10";
    const fetcher: Fetcher = (url, init) => {
      if (url === moved) {
        fake.requests.push({ url, headers: init.headers, redirect: init.redirect });
        return Promise.resolve(new Response(CORE, { status: 200 }));
      }
      if (url.includes("/releases/assets/")) {
        fake.requests.push({ url, headers: init.headers, redirect: init.redirect });
        return Promise.resolve(new Response(null, { status: 302, headers: { location: moved } }));
      }
      return fake.fetcher(url, init);
    };
    const results = await updatePlugins(fetcher, [{ repo: REPO, plugins: ["jass-core"], token: TOKEN }], folder);
    expect(results[0]?.status).toBe("updated");
    const onMoved = fake.requests.filter((request) => request.url === moved);
    expect(onMoved).toHaveLength(1);
    expect(onMoved[0]?.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(results)).not.toContain(TOKEN);
  });

  it("refuses a release with no digest, and a download that does not match its digest, and keeps the jar in place", async () => {
    writeFileSync(join(folder, "jass-core-1.0.jar"), "old core");
    const undigested = await updatePlugins(github(JARS, { digests: false }).fetcher, [{ repo: REPO, plugins: ["jass-core"], token: null }], folder);
    expect(undigested[0]?.status).toBe("failed");
    expect(undigested[0]?.message).toMatch(/no sha256 digest/);
    const mismatched = await updatePlugins(github(JARS, { badDigest: true }).fetcher, [{ repo: REPO, plugins: ["jass-core"], token: null }], folder);
    expect(mismatched[0]?.status).toBe("failed");
    expect(mismatched[0]?.message).toMatch(/does not match its published digest/);
    expect(readdirSync(folder).sort()).toEqual(["jass-core-1.0.jar"]);
    expect(readFileSync(join(folder, "jass-core-1.0.jar"), "utf8")).toBe("old core");
  });

  it("leaves a jar already in place with the published digest alone, and still removes its older versions", async () => {
    writeFileSync(join(folder, "jass-core-1.1.jar"), CORE);
    writeFileSync(join(folder, "jass-core-1.0.jar"), "old core");
    const { fetcher, requests } = github(JARS.slice(0, 1));
    const results = await updatePlugins(fetcher, [{ repo: REPO, plugins: ["jass-core"], token: null }], folder);
    expect(results).toEqual([{ repo: REPO, plugin: "jass-core", status: "current", asset: "jass-core-1.1.jar", removed: ["jass-core-1.0.jar"], message: null }]);
    expect(requests.some((request) => request.url.includes("/releases/assets/"))).toBe(false);
  });

  it("fails each plugin of a repository whose release cannot be read, and goes on with the other repository", async () => {
    const good = github(JARS).fetcher;
    const gone: Fetcher = (url, init) =>
      url.startsWith("https://api.github.com/repos/owner/gone/") ? Promise.resolve(new Response("nope", { status: 404 })) : good(url, init);
    const results = await updatePlugins(
      gone,
      [
        { repo: "owner/gone", plugins: ["jass-core", "jass-main"], token: null },
        { repo: REPO, plugins: ["jass-core"], token: null },
      ],
      folder,
    );
    expect(results.map((result) => [result.repo, result.plugin, result.status])).toEqual([
      ["owner/gone", "jass-core", "failed"],
      ["owner/gone", "jass-main", "failed"],
      [REPO, "jass-core", "updated"],
    ]);
    expect(results[0]?.message).toBe("the release could not be read (HTTP 404)");
  });

  it("reports a plugin the release does not offer, and a network failure, without the token in either", async () => {
    const missing = await updatePlugins(github(JARS).fetcher, [{ repo: REPO, plugins: ["jass-skyblock"], token: TOKEN }], folder);
    expect(missing[0]).toMatchObject({ status: "failed", message: "the newest release has no jar for jass-skyblock" });
    const down: Fetcher = () => Promise.reject(new TypeError(`connection failed while using ${TOKEN}`));
    const unreachable = await updatePlugins(down, [{ repo: REPO, plugins: ["jass-core"], token: TOKEN }], folder);
    expect(unreachable[0]?.message).toBe("GitHub could not be reached");
    expect(JSON.stringify([missing, unreachable])).not.toContain(TOKEN);
  });

  it("refuses a redirect to an address that is not https, and makes no request to it", async () => {
    const { fetcher, requests } = github(JARS.slice(0, 1), { redirect: true, plainRedirect: true });
    const results = await updatePlugins(fetcher, [{ repo: REPO, plugins: ["jass-core"], token: TOKEN }], folder);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.message).toMatch(/not https/);
    expect(requests.some((request) => request.url.startsWith("http://"))).toBe(false);
  });

  it("fails a plugin whose jar name is held by a directory, without reading it", async () => {
    mkdirSync(join(folder, "jass-core-1.1.jar"));
    const results = await updatePlugins(github(JARS.slice(0, 1)).fetcher, [{ repo: REPO, plugins: ["jass-core"], token: null }], folder);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.message).toMatch(/not a regular file/);
  });

  it("refuses a symlink or a pipe under a jar's name, and never reads through it", async () => {
    const outside = join(base, "outside.txt");
    writeFileSync(outside, "not a plugin");
    symlinkSync(outside, join(folder, "jass-core-1.1.jar"));
    const linked = await updatePlugins(github(JARS.slice(0, 1)).fetcher, [{ repo: REPO, plugins: ["jass-core"], token: null }], folder);
    expect(linked[0]?.message).toMatch(/not a regular file/);
    expect(readFileSync(outside, "utf8")).toBe("not a plugin");
    rmSync(join(folder, "jass-core-1.1.jar"));
    execFileSync("mkfifo", ["--", join(folder, "jass-core-1.1.jar")]);
    const piped = await updatePlugins(github(JARS.slice(0, 1)).fetcher, [{ repo: REPO, plugins: ["jass-core"], token: null }], folder);
    expect(piped[0]?.message).toMatch(/not a regular file/);
  });

  it("starts no repository once the run's time is spent, and fails its plugins with that reason", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const fake = github(JARS.slice(0, 1));
    // The first repository's download uses up the whole run, so the second repository must not be asked for anything.
    const fetcher: Fetcher = (url, init) => {
      if (url.includes("/releases/assets/")) elapsed = 10 * 60_000 + 1;
      return fake.fetcher(url, init);
    };
    try {
      const results = await updatePlugins(
        fetcher,
        [
          { repo: REPO, plugins: ["jass-core"], token: null },
          { repo: "owner/later", plugins: ["jass-core"], token: null },
        ],
        folder,
      );
      expect(results.map((result) => [result.repo, result.status])).toEqual([
        [REPO, "updated"],
        ["owner/later", "failed"],
      ]);
      expect(results[1]?.message).toMatch(/ran out of time/);
      expect(fake.requests.some((request) => request.url.includes("owner/later"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.skipIf(process.getuid?.() === 0)("keeps the old jar, and fails only that plugin, when the folder refuses the write", async () => {
    writeFileSync(join(folder, "jass-core-1.1.jar"), "an old copy that does not match");
    chmodSync(folder, 0o500);
    try {
      const results = await updatePlugins(github(JARS.slice(0, 1)).fetcher, [{ repo: REPO, plugins: ["jass-core"], token: null }], folder);
      expect(results[0]?.status).toBe("failed");
    } finally {
      chmodSync(folder, 0o700);
    }
    expect(readFileSync(join(folder, "jass-core-1.1.jar"), "utf8")).toBe("an old copy that does not match");
    expect(readdirSync(folder).some((name) => name.endsWith(".partial"))).toBe(false);
  });
});

describe("hashing a file under a name", () => {
  it("reads a pipe without waiting for a writer, and refuses a link instead of following it", async () => {
    const pipe = join(folder, "pipe.jar");
    execFileSync("mkfifo", ["--", pipe]);
    expect(await sha256File(pipe)).toBe(createHash("sha256").digest("hex"));
    const outside = join(base, "target.jar");
    writeFileSync(outside, "linked");
    symlinkSync(outside, join(folder, "linked.jar"));
    await expect(sha256File(join(folder, "linked.jar"))).rejects.toThrow();
  });
});

describe("the catalogue", () => {
  it("lists the plugins of a repository's newest release, with the release's name", async () => {
    const jars: Jar[] = [{ id: 10, name: "jass-core-1.1.jar", updated: "2026-02-01T00:00:00Z", bytes: Buffer.from("x") }];
    expect(await catalogue(github(jars).fetcher, REPO, null)).toEqual({ repo: REPO, release: "release-1", plugins: [{ name: "jass-core", asset: "jass-core-1.1.jar" }] });
  });
});
