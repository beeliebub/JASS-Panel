// A counting limiter for calls to the website. A call that cannot get a slot is answered "unavailable" by the caller, never queued,
// so a burst of requests cannot pile up behind a slow website and hold the daemon's memory.

export class Limiter {
  readonly #limit: number;
  #active = 0;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("a limiter needs a positive integer limit");
    this.#limit = limit;
  }

  /** Returns a release function when a slot was free, or null when every slot is in use. */
  tryAcquire(): (() => void) | null {
    if (this.#active >= this.#limit) return null;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }

  get active(): number {
    return this.#active;
  }
}
