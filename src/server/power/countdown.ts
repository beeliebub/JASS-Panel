// A countdown before a stop or restart, and the registry that lets the person who started it cancel it. A countdown exists only while
// its request is open: a daemon restart or shutdown abandons it, and the server keeps running. Cancelling is possible until the stop begins,
// and a stop begins at most once, so a cancel can never arrive after the server has been told to stop. The page is shown the countdown
// through the view below, which names the starter only so that the cancel decision can be made where the starter is known. Each countdown
// has its own id, and a cancel must name it, so a page that was shown an earlier countdown on the same server cannot cancel a later one.
import { randomUUID } from "node:crypto";

export type CancelOutcome = "cancelled" | "too_late";

/**
 * Why a cancel was or was not made. "none": no countdown runs on the server. "stale": one runs, but it is not the one the cancel named.
 * "not_starter": the caller may not cancel that countdown.
 */
export type CancelResult = CancelOutcome | "none" | "stale" | "not_starter";

/** What the panel may say about a running countdown. The starter is in it only for the cancel decision; it is never sent to a page. */
export interface CountdownView {
  readonly id: string;
  readonly action: "stop" | "restart";
  readonly scheduled: boolean;
  readonly warningsSent: number;
  readonly warningsDue: number;
  readonly starterId: string;
}

export class Countdown {
  readonly #abort = new AbortController();
  /** The id a cancel must name. It is random, so an id a page saw for one countdown says nothing about the next one on the same server. */
  readonly id = randomUUID();
  #cancelled = false;
  #cancelledBy: string | null = null;
  #stopBegun = false;

  constructor(
    readonly serverId: string,
    readonly starterId: string,
    readonly action: "stop" | "restart",
    /** True when a schedule began the countdown rather than a person. */
    readonly scheduled: boolean,
    /** The warnings so far. The warning loop writes to this same object, so the page reads live progress. */
    readonly progress: { sent: number; due: number },
  ) {}

  /** Aborts when the countdown is cancelled. The waits between warnings listen on it. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  /** Who cancelled the countdown, as the audit row names them. Null until it is cancelled. */
  get cancelledBy(): string | null {
    return this.#cancelledBy;
  }

  /**
   * Cancelling again after a cancel is accepted; it is a no-op, and the first canceller is the one recorded. A cancel after the stop began
   * is refused.
   */
  cancel(by: string): CancelOutcome {
    if (this.#stopBegun) return "too_late";
    if (!this.#cancelled) {
      this.#cancelled = true;
      this.#cancelledBy = by;
      this.#abort.abort();
    }
    return "cancelled";
  }

  /** Marks the stop as begun. Returns false when the countdown was cancelled, and then nothing may be stopped. */
  beginStop(): boolean {
    if (this.#cancelled) return false;
    this.#stopBegun = true;
    return true;
  }
}

/** The countdowns that are running, one per server: the operation lock already allows only one operation per server. */
export class CountdownRegistry {
  readonly #active = new Map<string, Countdown>();

  attach(countdown: Countdown): void {
    this.#active.set(countdown.serverId, countdown);
  }

  detach(countdown: Countdown): void {
    if (this.#active.get(countdown.serverId) === countdown) this.#active.delete(countdown.serverId);
  }

  /** The countdown running on a server, or null when none is. */
  describe(serverId: string): CountdownView | null {
    const countdown = this.#active.get(serverId);
    if (countdown === undefined) return null;
    return {
      id: countdown.id,
      action: countdown.action,
      scheduled: countdown.scheduled,
      warningsSent: countdown.progress.sent,
      warningsDue: countdown.progress.due,
      starterId: countdown.starterId,
    };
  }

  /**
   * Cancels the countdown on a server, if the countdown named is the one running. A countdown a person began can be cancelled only by that
   * person. A scheduled countdown can be cancelled by any holder of power on the server; the route checks power before it calls this, so the
   * check is not repeated here. A server with no countdown is reported as such, so a missing countdown is never reported as cancelled.
   */
  cancel(serverId: string, caller: { readonly id: string; readonly label: string }, countdownId: string): CancelResult {
    const countdown = this.#active.get(serverId);
    if (countdown === undefined) return "none";
    if (countdown.id !== countdownId) return "stale";
    if (!countdown.scheduled && countdown.starterId !== caller.id) return "not_starter";
    return countdown.cancel(caller.label);
  }
}
