// Whether a server has finished loading. Paper prints its "Done" line once the world is ready to take commands, and a server that has
// not printed it refuses console input. The line is read from the unit's journal for the invocation systemd started, so a line from an
// earlier run cannot count, whichever log file Paper rotated it into. Once a run is seen to be loaded, that is written to a marker in the
// data directory, so a daemon restart does not depend on the journal still holding the line. A journal that cannot be read answers "not
// loaded", which keeps the console refused: unknown is never a reason to accept input.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import type { Runner } from "../systemd/run.js";
import { observeUnits, serviceUnit, type ObservedState, type UnitState } from "../systemd/user.js";

// Anchored to the start of the line, so a chat line that happens to contain the same words cannot count: a chat line carries a player's
// name before its text. The thread name is optional, because the journal copy of the line has none.
export const DONE_LINE = /^\[[^\]]*\](?: \[[^\]]*\])?: Done \([^)]*\)! For help, type "help"/;
const INVOCATION_ID = /^[0-9a-f]{32}$/;
// A run that has not printed Done is asked again after this long, so several watchers do not each run the journal query on every tick.
const NOT_LOADED_TTL_MS = 2000;

export interface ReadinessOptions {
  /** The data directory's markers folder. Without it the loaded runs are remembered only in memory. */
  readonly markers?: string;
  /** Whether the server was made from the Paper preset, and so is expected to print Done. Every server is, unless this says otherwise. */
  readonly paperServer?: (serverId: string) => boolean;
  /** The clock for the not-loaded answers' lifetime. Monotonic, so a change of the wall clock cannot lengthen or shorten it. */
  readonly now?: () => number;
}

/** The marker that records the invocation whose Done line was seen, for one server. */
export function loadedMarkerOf(markers: string, serverId: string): string {
  return join(markers, `${serverId}.loaded`);
}

export class Readiness {
  /** The invocation whose Done line was last seen, per server. A later invocation has a different id, so it is looked up afresh. */
  readonly #loaded = new Map<string, string>();
  /** Whether the latest journal look for a server could not be read, so its answer is unknown rather than not loaded. */
  readonly #unreadable = new Map<string, boolean>();
  /** Where the last look that found no Done line stopped reading, for the invocation it was made for. */
  readonly #cursors = new Map<string, { readonly invocation: string; readonly cursor: string }>();
  /** The last run that was asked about and had no Done line, with when it was asked. */
  readonly #notLoaded = new Map<string, { readonly invocation: string; readonly at: number }>();
  readonly #markers: string | undefined;
  readonly #paperServer: (serverId: string) => boolean;
  readonly #now: () => number;

  constructor(options: ReadinessOptions = {}) {
    this.#markers = options.markers;
    this.#paperServer = options.paperServer ?? (() => true);
    this.#now = options.now ?? (() => performance.now());
  }

  #markedLoaded(id: string, invocation: string): boolean {
    if (this.#markers === undefined) return false;
    const file = loadedMarkerOf(this.#markers, id);
    try {
      return existsSync(file) && readFileSync(file, "utf8").trim() === invocation;
    } catch {
      return false;
    }
  }

  #remember(id: string, invocation: string): void {
    this.#loaded.set(id, invocation);
    if (this.#markers === undefined) return;
    try {
      mkdirSync(this.#markers, { recursive: true, mode: 0o700 });
      writeFileSync(loadedMarkerOf(this.#markers, id), `${invocation}\n`, { mode: 0o600 });
    } catch {
      // Best effort. Without the marker a restart asks the journal again, which is right while the journal still holds the line. If
      // journald has dropped the line by then, the run reads as not loaded until the server restarts, which keeps the console refused.
    }
  }

  async #loadedFor(run: Runner, id: string, state: UnitState): Promise<boolean> {
    if (state.activeState !== "active") return false;
    // A server that was not made from the Paper preset prints no Done line to wait for. It is loaded while its unit is active, as it was
    // before readiness was checked at all.
    if (!this.#paperServer(id)) return true;
    if (state.invocationId === null || !INVOCATION_ID.test(state.invocationId)) return false;
    const invocation = state.invocationId;
    if (this.#loaded.get(id) === invocation) return true;
    if (this.#markedLoaded(id, invocation)) {
      this.#loaded.set(id, invocation);
      return true;
    }
    const asked = this.#notLoaded.get(id);
    if (asked !== undefined && asked.invocation === invocation && this.#now() - asked.at < NOT_LOADED_TTL_MS) return false;
    // A look that found no Done line leaves a cursor at the newest line it read, so the next look reads only what was written since. A
    // cursor the journal no longer has (its lines were rotated away) is dropped, and the look is made again from the start of the run.
    const known = this.#cursors.get(id);
    const after = known !== undefined && known.invocation === invocation ? [`--after-cursor=${known.cursor}`] : [];
    const query = (since: string[]) =>
      run([
        "journalctl",
        "--user",
        "--no-pager",
        "-o",
        "cat",
        "--show-cursor",
        `--grep=Done \\(`,
        ...since,
        "-u",
        serviceUnit(id),
        "--",
        `_SYSTEMD_INVOCATION_ID=${invocation}`,
      ]);
    // journalctl exits 1 with nothing on stderr when a query matches no line. That is an answer (no Done line yet), not a failure. A failure has
    // no exit code, another code, or a message on stderr, and only a failure leaves the look unknown.
    const failedQuery = (result: { readonly code: number | null; readonly stderr: string }): boolean =>
      result.code === null || (result.code !== 0 && (result.code !== 1 || result.stderr.trim() !== ""));
    let outcome = await query(after);
    if (failedQuery(outcome) && after.length > 0) {
      this.#cursors.delete(id);
      outcome = await query([]);
    }
    // A journal that could not be read says nothing either way, so the look is recorded as unknown rather than as not loaded.
    const failed = failedQuery(outcome);
    this.#unreadable.set(id, failed);
    const lines = failed ? [] : outcome.stdout.split("\n");
    if (lines.some((line) => DONE_LINE.test(line))) {
      this.#remember(id, invocation);
      this.#notLoaded.delete(id);
      this.#cursors.delete(id);
      return true;
    }
    // A look that could not be read is not remembered as not loaded, so the next look asks the journal again.
    if (failed) {
      this.#notLoaded.delete(id);
      return false;
    }
    const cursor = lines.flatMap((line) => /^-- cursor: (.+)$/.exec(line)?.[1] ?? []).at(-1);
    if (cursor !== undefined) this.#cursors.set(id, { invocation, cursor });
    this.#notLoaded.set(id, { invocation, at: this.#now() });
    return false;
  }

  /** Whether the latest look at a server's journal could not be read. Such a look says nothing about whether the server has loaded. */
  unreadable(id: string): boolean {
    return this.#unreadable.get(id) === true;
  }

  /** Forgets the last not-loaded answer for a server, so the next look asks the journal again. For a decision that must not rest on an older look. */
  recheck(serverId: string): void {
    this.#notLoaded.delete(serverId);
  }

  /** Fills in `loaded` for every unit systemd reported. Each other field is left as systemd gave it. */
  async annotate(run: Runner, states: ReadonlyMap<string, ObservedState>): Promise<Map<string, ObservedState>> {
    const annotated = new Map<string, ObservedState>();
    for (const [id, observed] of states) {
      if (!observed.known) {
        annotated.set(id, observed);
        continue;
      }
      const loaded = await this.#loadedFor(run, id, observed.state);
      annotated.set(id, { known: true, state: { ...observed.state, loaded } });
    }
    return annotated;
  }
}

/** One systemctl call for every server, with the loaded flag filled in. The result has the same shape as observeUnits. */
export async function observeServers(run: Runner, readiness: Readiness, ids: readonly string[]): Promise<Map<string, ObservedState>> {
  return readiness.annotate(run, await observeUnits(run, ids));
}
