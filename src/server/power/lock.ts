// The per-server operation lock. A second request for a server that already has an operation running is refused at once with the
// name of the running operation; nothing queues. The lock lives in memory, which is why a restart of the daemon clears it, and why
// the durable markers in the data directory are the only record of an operation that must be finished later. The countdown of a
// stop or restart is registered here too, because it runs under the same lock and its starter may cancel it while it runs.
import { CountdownRegistry } from "./countdown.js";

/**
 * The wait of a start or restart for its Done line. A stop without a warning may end the wait. The stop takes the server's lock in the
 * same step in which the start releases it, so no other request can take the lock in between.
 */
export class LoadWait {
  readonly #interrupt = new AbortController();
  #cutShort = false;
  #handOver: (() => void) | null = null;

  /** Aborts when a stop has interrupted the wait. */
  get signal(): AbortSignal {
    return this.#interrupt.signal;
  }

  /** Whether a stop ended the wait before the server reported that it had loaded. */
  get cutShort(): boolean {
    return this.#cutShort;
  }

  /** Records that the wait ended because a stop interrupted it. */
  markCutShort(): void {
    this.#cutShort = true;
  }

  interrupt(): void {
    this.#interrupt.abort();
  }

  /** Whether a stop has already claimed the lock this wait hands over. Only one stop may. */
  get claimed(): boolean {
    return this.#handOver !== null;
  }

  /** Registers what the claiming stop does when the owner releases the lock. */
  claim(handOver: () => void): void {
    this.#handOver = handOver;
  }

  /** Called by the lock when its owner has released the server. */
  handOver(): void {
    const handOver = this.#handOver;
    this.#handOver = null;
    handOver?.();
  }
}

export class OperationLocks {
  readonly #held = new Map<string, string>();
  readonly #loadWaits = new Map<string, LoadWait>();
  readonly #updates = new Map<string, number>();
  readonly #writeCount = new Map<string, number>();
  readonly #writingFiles = new Set<string>();
  readonly countdowns = new CountdownRegistry();

  /**
   * Returns a release function when the lock was free, or null. A plugin update that is still running counts as an operation: the jar may
   * still be being written, so nothing else may begin on the server until the update has ended.
   */
  tryAcquire(serverId: string, operation: string): (() => void) | null {
    if (this.#held.has(serverId) || this.updatesRunning(serverId)) return null;
    return this.#hold(serverId, operation);
  }

  #hold(serverId: string, operation: string): () => void {
    this.#held.set(serverId, operation);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held.delete(serverId);
      // A wait ends with the operation that holds the lock. A stop that claimed it takes the lock here, in the same step as the release.
      const wait = this.#loadWaits.get(serverId);
      if (wait !== undefined) {
        this.#loadWaits.delete(serverId);
        wait.handOver();
      }
    };
  }

  /** The operation holding the server. A plugin update still running is reported as one, after the start that began it has released. */
  holder(serverId: string): string | null {
    return this.#held.get(serverId) ?? (this.updatesRunning(serverId) ? "plugin-update" : null);
  }

  /** Opens the Done wait of a start or restart. The caller holds the server's lock, and the wait ends when that lock is released. */
  beginLoadWait(serverId: string): LoadWait {
    const wait = new LoadWait();
    this.#loadWaits.set(serverId, wait);
    return wait;
  }

  /**
   * Ends the Done wait of a start or restart for a stop. The wait is not ended while a plugin update runs inside the operation, because the
   * update would still be writing the jar. Resolves to the stop's lock and whether the wait was cut short. Resolves to null when there is no
   * wait to end, or when another stop has already claimed it.
   */
  interruptLoadWait(serverId: string, operation: string): Promise<{ readonly release: () => void; readonly cutShort: boolean } | null> {
    const wait = this.#loadWaits.get(serverId);
    if (wait === undefined || wait.claimed || this.updatesRunning(serverId)) return Promise.resolve(null);
    return new Promise((resolve) => {
      wait.claim(() => resolve({ release: this.#hold(serverId, operation), cutShort: wait.cutShort }));
      wait.interrupt();
    });
  }

  /**
   * Marks a plugin update that runs inside a start or restart. The unit's update request gives up after 110 seconds while the update itself
   * runs on in the daemon, so the update can outlive the start that began it, and it is counted until it ends. A stop may not end the start's
   * wait while the update is writing, and only one update runs at a time. Once a stop has claimed the wait, no update may begin: that stop
   * takes the server next, and an update started now would be cut off mid-write. Returns null when either applies.
   */
  beginBorrowedUpdate(serverId: string): (() => void) | null {
    if (this.updatesRunning(serverId) || this.#loadWaits.get(serverId)?.claimed === true) return null;
    this.#updates.set(serverId, (this.#updates.get(serverId) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.#updates.get(serverId) ?? 1) - 1;
      if (left > 0) this.#updates.set(serverId, left);
      else this.#updates.delete(serverId);
    };
  }

  updatesRunning(serverId: string): boolean {
    return (this.#updates.get(serverId) ?? 0) > 0;
  }

  /**
   * Marks a file write as running. The write is asynchronous, so a second write to the same file, or a restore, could otherwise start in
   * the middle of it. The same file is refused while it is being written, and a restore is refused while any write runs on its server.
   */
  beginWrite(serverId: string, file: string): { readonly ok: true; readonly end: () => void } | { readonly ok: false; readonly reason: "restore" | "busy" } {
    if (this.holder(serverId) === "restore") return { ok: false, reason: "restore" };
    const key = `${serverId}\0${file}`;
    if (this.#writingFiles.has(key)) return { ok: false, reason: "busy" };
    this.#writingFiles.add(key);
    this.#writeCount.set(serverId, (this.#writeCount.get(serverId) ?? 0) + 1);
    let ended = false;
    return {
      ok: true,
      end: () => {
        if (ended) return;
        ended = true;
        this.#writingFiles.delete(key);
        const left = (this.#writeCount.get(serverId) ?? 1) - 1;
        if (left > 0) this.#writeCount.set(serverId, left);
        else this.#writeCount.delete(serverId);
      },
    };
  }

  /** Whether a file write is in flight on the server. A restore moves the folders a write is writing into, so it waits for none. */
  writesRunning(serverId: string): boolean {
    return (this.#writeCount.get(serverId) ?? 0) > 0;
  }
}
