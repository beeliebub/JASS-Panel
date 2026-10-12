import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PanelPaths } from "../config/config.js";
import { readLastEnd } from "./state.js";

let events: string;

beforeEach(() => {
  events = mkdtempSync(join(tmpdir(), "jass-panel-events-"));
});

afterEach(() => {
  rmSync(events, { recursive: true, force: true });
});

describe("the last end of a server's events file", () => {
  it("reads the last line of a file far longer than the part that is read", () => {
    // Several hundred kilobytes of earlier lines, so the read starts well inside the file and its first piece is a cut line.
    const earlier = "result=exited code=0 status=0 at=2026-10-01\n".repeat(12_000);
    writeFileSync(join(events, "alpha.log"), `${earlier}result=failed code=137 status=9 at=2026-10-11\n`);
    expect(readLastEnd({ events } as PanelPaths, "alpha")).toEqual({ result: "failed", code: "137", status: "9" });
  });

  it("answers null for a file with no line in it, and for one that does not exist", () => {
    writeFileSync(join(events, "beta.log"), "\n\n");
    expect(readLastEnd({ events } as PanelPaths, "beta")).toBeNull();
    expect(readLastEnd({ events } as PanelPaths, "gamma")).toBeNull();
  });
});
