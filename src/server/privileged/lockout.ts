// The brute-force limit on the account password typed into the panel. Two consecutive wrong passwords, panel-wide, disable the
// privileged actions for fifteen minutes. The limit sits below the account's own lockout threshold, so the panel can never lock
// the account out. A correct password clears the count.
export const LOCK_FAILURES = 2;
export const LOCK_MS = 15 * 60 * 1000;

export class PasswordLockout {
  #failures = 0;
  #lockedUntil = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Milliseconds left in the lock, or 0 when actions are allowed. */
  remaining(): number {
    return Math.max(0, this.#lockedUntil - this.now());
  }

  /** Records one attempt's outcome. Returns true when this failure starts a lock. */
  record(success: boolean): boolean {
    if (success) {
      this.#failures = 0;
      return false;
    }
    this.#failures += 1;
    if (this.#failures >= LOCK_FAILURES) {
      this.#failures = 0;
      this.#lockedUntil = this.now() + LOCK_MS;
      return true;
    }
    return false;
  }
}
