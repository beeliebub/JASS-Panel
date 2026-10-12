import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRelativePath, JailError, listDirectory, MAX_READ_BYTES, readText, resolveInside, writeText } from "./jail.js";
import { keepHistory, VERSIONS_PER_FILE } from "./history.js";

let root: string;
let server: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-jail-"));
  server = join(root, "server");
  outside = join(root, "outside");
  mkdirSync(join(server, "config"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(server, "config", "a.yml"), "key: value\n");
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A file holding `text`, for a copy to be taken from: a history copy is made from the file on disk, not from memory. */
function sourceOf(text: string): string {
  const file = join(root, `source-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, text);
  return file;
}

describe("the path check", () => {
  it("refuses empty, NUL, absolute, dot-dot and empty-segment paths", () => {
    for (const path of ["", "a\0b", "/etc/passwd", "../outside/secret.txt", "config/../../outside", "config//a.yml", "config/"]) {
      expect(() => checkRelativePath(path), JSON.stringify(path)).toThrow(JailError);
    }
  });

  it("accepts an ordinary relative path", () => {
    expect(checkRelativePath("config/a.yml")).toBe("config/a.yml");
  });
});

describe("resolving inside the server directory", () => {
  it("refuses a symlink that points outside the directory", () => {
    symlinkSync(join(outside, "secret.txt"), join(server, "link.txt"));
    expect(() => resolveInside(server, "link.txt")).toThrow(/leaves the server directory/);
    expect(() => readText(server, "link.txt")).toThrow(JailError);
  });

  it("refuses a directory symlink whose target is outside, even for a file under it", () => {
    symlinkSync(outside, join(server, "escape"));
    expect(() => readText(server, "escape/secret.txt")).toThrow(JailError);
    expect(() => listDirectory(server, "escape")).toThrow(JailError);
  });

  it("refuses to read or write through a symlink placed in the final position", async () => {
    symlinkSync(join(outside, "secret.txt"), join(server, "config", "b.yml"));
    expect(() => readText(server, "config/b.yml")).toThrow(JailError);
    await expect(writeText(server, "config/b.yml", "overwritten")).rejects.toThrow(JailError);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("not yours\n");
  });

  it("requires the folder of a new file to exist, and never creates folders", async () => {
    await expect(writeText(server, "missing/new.txt", "x")).rejects.toThrow(/folder for that file does not exist/);
    expect(() => statSync(join(server, "missing"))).toThrow();
  });
});

describe("reading, listing and writing", () => {
  it("reads a file inside the directory and lists its folder", () => {
    expect(readText(server, "config/a.yml").text).toBe("key: value\n");
    expect(listDirectory(server, "config").entries.map((entry) => entry.name)).toEqual(["a.yml"]);
  });

  it("reads at most two MiB and says it was cut", () => {
    writeFileSync(join(server, "big.log"), "x".repeat(MAX_READ_BYTES + 10));
    const read = readText(server, "big.log");
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBe(MAX_READ_BYTES);
  });

  it("keeps the previous content before an overwrite, and leaves no temporary file behind", async () => {
    const history = join(root, "history");
    await writeText(server, "config/a.yml", "key: new\n", (previous) => keepHistory(history, "alpha", "config/a.yml", previous, new Date()));
    expect(readFileSync(join(server, "config", "a.yml"), "utf8")).toBe("key: new\n");
    const kept = readdirSync(join(history, "alpha"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(history, "alpha", kept[0] ?? ""), "utf8")).toBe("key: value\n");
    expect(readdirSync(join(server, "config")).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("keeps the history of two paths that sanitise to the same readable name apart", async () => {
    const history = join(root, "history");
    await keepHistory(history, "alpha", "a/b.txt", sourceOf("slash"), new Date(Date.UTC(2026, 0, 1)));
    await keepHistory(history, "alpha", "a_b.txt", sourceOf("underscore"), new Date(Date.UTC(2026, 0, 2)));
    const kept = readdirSync(join(history, "alpha"));
    expect(kept).toHaveLength(2);
    const contents = kept.map((name) => readFileSync(join(history, "alpha", name), "utf8")).sort();
    expect(contents).toEqual(["slash", "underscore"]);
  });

  it("keeps the newest ten copies of a file and prunes the rest", async () => {
    const history = join(root, "history");
    for (let round = 0; round < VERSIONS_PER_FILE + 3; round += 1) {
      await keepHistory(history, "alpha", "config/a.yml", sourceOf(`v${round}`), new Date(Date.UTC(2026, 0, 1, 0, 0, round)));
    }
    expect(readdirSync(join(history, "alpha"))).toHaveLength(VERSIONS_PER_FILE);
  });
});

describe("history copies", () => {
  it("keeps two copies made in the same millisecond apart, so neither overwrites the other", async () => {
    const history = join(root, "history");
    const same = new Date(Date.UTC(2026, 0, 1));
    await keepHistory(history, "alpha", "a.txt", sourceOf("first"), same);
    await keepHistory(history, "alpha", "a.txt", sourceOf("second"), same);
    const kept = readdirSync(join(history, "alpha")).map((name) => readFileSync(join(history, "alpha", name), "utf8")).sort();
    expect(kept).toEqual(["first", "second"]);
  });
});
