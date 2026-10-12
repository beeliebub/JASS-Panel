// Streamed file writes: the bytes that reach the file, the refusals that leave the old file and no partial behind, and the copy of the
// previous content that is taken from the file on disk.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTooLarge, JailError, writeStream } from "../../src/server/files/jail.js";

let root: string;
let server: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jass-panel-stream-write-"));
  server = join(root, "server");
  mkdirSync(server);
  writeFileSync(join(server, "a.txt"), "old");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function* chunksOf(...parts: string[]): Generator<Buffer> {
  for (const part of parts) yield Buffer.from(part);
}

function unchanged(): void {
  expect(readFileSync(join(server, "a.txt"), "utf8")).toBe("old");
  expect(readdirSync(server).filter((name) => name.endsWith(".partial"))).toEqual([]);
}

describe("streamed writes", () => {
  it("stores the chunks in order, copies the previous content first, and returns the bytes written", async () => {
    const kept: string[] = [];
    const written = await writeStream(server, "a.txt", chunksOf("new ", "content"), {
      maxBytes: 100,
      expectedBytes: 11,
      keepPrevious: (previous) => {
        kept.push(readFileSync(previous, "utf8"));
        return Promise.resolve();
      },
    });
    expect(written).toBe(11);
    expect(kept).toEqual(["old"]);
    expect(readFileSync(join(server, "a.txt"), "utf8")).toBe("new content");
  });

  it("refuses a stream larger than the limit, and leaves the old file and no partial behind", async () => {
    await expect(writeStream(server, "a.txt", chunksOf("0123456789", "x"), { maxBytes: 10 })).rejects.toThrow(FileTooLarge);
    unchanged();
  });

  it("refuses a write that the permission check rejects just before the file is replaced", async () => {
    await expect(
      writeStream(server, "a.txt", chunksOf("new"), {
        maxBytes: 100,
        beforeCommit: () => {
          throw new Error("no longer allowed");
        },
      }),
    ).rejects.toThrow("no longer allowed");
    unchanged();
  });

  it("refuses a stream that ends before the length it declared", async () => {
    await expect(writeStream(server, "a.txt", chunksOf("short"), { maxBytes: 100, expectedBytes: 50 })).rejects.toThrow(JailError);
    unchanged();
  });

  it("refuses a file the disk cannot hold beside its reserve, before any byte is written", async () => {
    await expect(
      writeStream(server, "a.txt", chunksOf("x"), { maxBytes: Number.MAX_SAFE_INTEGER, expectedBytes: Number.MAX_SAFE_INTEGER / 2 }),
    ).rejects.toThrow(/not enough free space/);
    unchanged();
  });

  it("refuses a stream that runs past the length it declared, and leaves the old file and no partial behind", async () => {
    await expect(writeStream(server, "a.txt", chunksOf("0123456789"), { maxBytes: 100, expectedBytes: 4 })).rejects.toThrow(/longer than the length it declared/);
    unchanged();
  });

  it("waits for an asynchronous permission check before the file is replaced", async () => {
    await expect(
      writeStream(server, "a.txt", chunksOf("new"), {
        maxBytes: 100,
        beforeCommit: async () => {
          await Promise.resolve();
          throw new Error("no longer allowed");
        },
      }),
    ).rejects.toThrow("no longer allowed");
    unchanged();
  });

  it("does not copy the previous content for a write that is refused, so the history keeps its versions", async () => {
    let copies = 0;
    await expect(
      writeStream(server, "a.txt", chunksOf("short"), {
        maxBytes: 100,
        expectedBytes: 50,
        keepPrevious: () => {
          copies += 1;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(JailError);
    expect(copies).toBe(0);
    unchanged();
  });
});
