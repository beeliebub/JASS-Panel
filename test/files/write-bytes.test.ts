// Replacing a file's bytes inside a server folder: the mode of a replaced file survives, and a file too large to keep a copy of is
// refused rather than read whole. Each test uses its own temporary folder.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVER_CAP_BYTES } from "../../src/server/files/history.js";
import { JailError, writeBytes } from "../../src/server/files/jail.js";

let root: string;
let server: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-bytes-"));
  server = join(root, "server");
  mkdirSync(server);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writing bytes into a server folder", () => {
  it("keeps the mode of a file it replaces, so an executable stays executable", async () => {
    const file = join(server, "run.sh");
    writeFileSync(file, "old");
    chmodSync(file, 0o755);
    await writeBytes(server, "run.sh", Buffer.from("new"));
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });

  it("refuses to replace a file too large for the history to keep a copy of, and leaves it untouched", async () => {
    const file = join(server, "big.db");
    writeFileSync(file, "");
    truncateSync(file, SERVER_CAP_BYTES + 1);
    await expect(writeBytes(server, "big.db", Buffer.from("x"), () => Promise.resolve())).rejects.toThrow(JailError);
    expect(statSync(file).size).toBe(SERVER_CAP_BYTES + 1);
  });
});
