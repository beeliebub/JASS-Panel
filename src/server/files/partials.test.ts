import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepPartials } from "./jail.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-sweep-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sweeping a server folder after an interrupted write", () => {
  it("removes only the panel's own temporary files, at any depth, and never follows a link", async () => {
    mkdirSync(join(root, "world", "region"), { recursive: true });
    writeFileSync(join(root, ".jass-panel-abc123.partial"), "left by a death");
    writeFileSync(join(root, "world", "region", ".jass-panel-z9y8x7.partial"), "left by a death");
    writeFileSync(join(root, "server.properties"), "kept");
    writeFileSync(join(root, ".partial-by-hand"), "kept");
    writeFileSync(join(root, "elsewhere.txt"), "the link points here");
    symlinkSync(join(root, "elsewhere.txt"), join(root, ".jass-panel-link0.partial"));

    expect(await sweepPartials(root)).toBe(2);

    expect(existsSync(join(root, ".jass-panel-abc123.partial"))).toBe(false);
    expect(existsSync(join(root, "world", "region", ".jass-panel-z9y8x7.partial"))).toBe(false);
    expect(readFileSync(join(root, "server.properties"), "utf8")).toBe("kept");
    expect(readFileSync(join(root, ".partial-by-hand"), "utf8")).toBe("kept");
    expect(readFileSync(join(root, "elsewhere.txt"), "utf8")).toBe("the link points here");
    expect(lstatSync(join(root, ".jass-panel-link0.partial")).isSymbolicLink()).toBe(true);
  });

  it("finds nothing in a folder that is missing, and goes on past a folder it cannot read", async () => {
    expect(await sweepPartials(join(root, "missing"))).toBe(0);
  });
});
