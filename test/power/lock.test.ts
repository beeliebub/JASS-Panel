// File writes against the server's operation lock. A write is asynchronous, so the lock must refuse an overlap that the synchronous code
// never had to consider: a second write to the same file, and a restore that would move the folder a write is writing into.
import { describe, expect, it } from "vitest";
import { OperationLocks } from "../../src/server/power/lock.js";

describe("file writes against the operation lock", () => {
  it("refuses a second write to the same file while the first runs, and allows a write to another file", () => {
    const locks = new OperationLocks();
    const first = locks.beginWrite("alpha", "/srv/alpha/a.yml");
    expect(first.ok).toBe(true);
    expect(locks.beginWrite("alpha", "/srv/alpha/a.yml")).toEqual({ ok: false, reason: "busy" });
    const other = locks.beginWrite("alpha", "/srv/alpha/b.yml");
    expect(other.ok).toBe(true);
    if (first.ok) first.end();
    if (other.ok) other.end();
    expect(locks.writesRunning("alpha")).toBe(false);
  });

  it("refuses a write while a restore holds the server, and a restore while a write runs", () => {
    const locks = new OperationLocks();
    const release = locks.tryAcquire("alpha", "restore");
    expect(locks.beginWrite("alpha", "/srv/alpha/a.yml")).toEqual({ ok: false, reason: "restore" });
    release?.();
    const write = locks.beginWrite("alpha", "/srv/alpha/a.yml");
    expect(write.ok).toBe(true);
    expect(locks.writesRunning("alpha")).toBe(true);
    if (write.ok) write.end();
    expect(locks.writesRunning("alpha")).toBe(false);
  });

  it("ends each write once, so a repeated end cannot release another write's claim", () => {
    const locks = new OperationLocks();
    const first = locks.beginWrite("alpha", "/srv/alpha/a.yml");
    const second = locks.beginWrite("alpha", "/srv/alpha/b.yml");
    if (!first.ok || !second.ok) throw new Error("both writes should start");
    first.end();
    first.end();
    expect(locks.writesRunning("alpha")).toBe(true);
    expect(locks.beginWrite("alpha", "/srv/alpha/b.yml")).toEqual({ ok: false, reason: "busy" });
    second.end();
    expect(locks.writesRunning("alpha")).toBe(false);
  });
});

describe("a stop that ends a start's wait", () => {
  it("takes the lock in the same step as the start releases it, so no other request can take it in between", async () => {
    const locks = new OperationLocks();
    const release = locks.tryAcquire("alpha", "start");
    const wait = locks.beginLoadWait("alpha");
    const handed = locks.interruptLoadWait("alpha", "stop");
    expect(wait.signal.aborted).toBe(true);
    release?.();
    expect(locks.holder("alpha")).toBe("stop");
    expect(locks.tryAcquire("alpha", "backup")).toBeNull();
    const stop = await handed;
    expect(stop).not.toBeNull();
    expect(stop?.cutShort).toBe(false);
    stop?.release();
    expect(locks.holder("alpha")).toBeNull();
  });

  it("reports the wait as cut short only when the start gave up because of the stop", async () => {
    const locks = new OperationLocks();
    const release = locks.tryAcquire("alpha", "start");
    const wait = locks.beginLoadWait("alpha");
    const handed = locks.interruptLoadWait("alpha", "stop");
    wait.markCutShort();
    release?.();
    const stop = await handed;
    expect(stop?.cutShort).toBe(true);
    stop?.release();
  });

  it("is refused when there is no wait, and a second stop is refused once the first has claimed it", async () => {
    const locks = new OperationLocks();
    expect(await locks.interruptLoadWait("alpha", "stop")).toBeNull();
    const release = locks.tryAcquire("alpha", "start");
    locks.beginLoadWait("alpha");
    const first = locks.interruptLoadWait("alpha", "stop");
    expect(await locks.interruptLoadWait("alpha", "stop")).toBeNull();
    release?.();
    (await first)?.release();
  });

  it("does not end the wait while a plugin update runs inside the start, and starts no update once a stop has claimed the wait", async () => {
    const locks = new OperationLocks();
    const release = locks.tryAcquire("alpha", "start");
    const wait = locks.beginLoadWait("alpha");
    const endUpdate = locks.beginBorrowedUpdate("alpha");
    expect(endUpdate).not.toBeNull();
    expect(locks.updatesRunning("alpha")).toBe(true);
    expect(await locks.interruptLoadWait("alpha", "stop")).toBeNull();
    expect(wait.signal.aborted).toBe(false);
    endUpdate?.();
    expect(locks.updatesRunning("alpha")).toBe(false);
    const handed = locks.interruptLoadWait("alpha", "stop");
    expect(locks.beginBorrowedUpdate("alpha")).toBeNull();
    release?.();
    (await handed)?.release();
  });
});

describe("a plugin update that outlives the start that began it", () => {
  it("keeps the server busy after the start has released it, until the update ends", () => {
    const locks = new OperationLocks();
    const release = locks.tryAcquire("alpha", "start");
    locks.beginLoadWait("alpha");
    const endUpdate = locks.beginBorrowedUpdate("alpha");
    release?.();
    expect(locks.holder("alpha")).toBe("plugin-update");
    expect(locks.tryAcquire("alpha", "stop")).toBeNull();
    expect(locks.tryAcquire("alpha", "backup")).toBeNull();
    endUpdate?.();
    expect(locks.holder("alpha")).toBeNull();
    const stop = locks.tryAcquire("alpha", "stop");
    expect(stop).not.toBeNull();
    stop?.();
  });

  it("runs one update at a time, so a second cannot write the same partial file while the first is writing it", () => {
    const locks = new OperationLocks();
    const release = locks.tryAcquire("alpha", "start");
    locks.beginLoadWait("alpha");
    const endFirst = locks.beginBorrowedUpdate("alpha");
    expect(locks.beginBorrowedUpdate("alpha")).toBeNull();
    release?.();
    expect(locks.beginBorrowedUpdate("alpha")).toBeNull();
    endFirst?.();
    const second = locks.beginBorrowedUpdate("alpha");
    expect(second).not.toBeNull();
    second?.();
  });
});
