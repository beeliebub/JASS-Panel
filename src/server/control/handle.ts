// Answers one line from the control socket. Only "update <server id>" is understood, and only while that server's unit is activating,
// which means the request came from its own ExecStartPre. A backup or restore on the server refuses it; a successful check is not repeated
// for ten minutes, or for a shorter wait after checks that had failed plugins, so a crash loop does not hammer the release API.
import { recordAudit } from "../audit/audit.js";
import type { PanelConfig } from "../config/config.js";
import type { PanelDatabase } from "../db/open.js";
import type { OperationLocks } from "../power/lock.js";
import { getSources } from "../plugins/sources.js";
import { reasonOf, summaryOf, updatePlugins, type Fetcher } from "../plugins/updater.js";
import { getServer } from "../servers/store.js";
import { observeUnits } from "../systemd/user.js";
import type { Runner } from "../systemd/run.js";
import { JailError, resolveInside } from "../files/jail.js";

const CLEAN_INTERVAL_MS = 10 * 60_000;
const RETRY_STEP_MS = 60_000;
const ID = /^update ([a-z0-9][a-z0-9-]{0,31})$/;

/**
 * How long a finished check holds the next one back. After a clean check that is the full interval. After failed checks in a row it is one
 * minute, then two, four and eight, and the full interval from then on: a brief outage is retried within a minute, while a server that
 * crashes on every start checks GitHub only a few times an hour once the waits have grown.
 */
function holdFor(failedRuns: number): number {
  if (failedRuns === 0) return CLEAN_INTERVAL_MS;
  return Math.min(CLEAN_INTERVAL_MS, RETRY_STEP_MS * 2 ** Math.min(failedRuns - 1, 10));
}

export interface ControlDependencies {
  readonly db: PanelDatabase;
  readonly config: PanelConfig;
  readonly run: Runner;
  readonly locks: OperationLocks;
  readonly fetcher: Fetcher;
  readonly now?: () => Date;
}

export function createControlHandler(deps: ControlDependencies): (line: string) => Promise<string> {
  const now = deps.now ?? (() => new Date());
  const lastCheck = new Map<string, { at: number; failedRuns: number }>();

  return async (line) => {
    const match = ID.exec(line);
    if (match === null) return "refused: unknown request";
    const id = match[1] ?? "";
    const row = getServer(deps.db, id);
    if (row === undefined) return "refused: no such server";
    // A server removed and added again under the same id is a new server, so the hold kept for its earlier self does not apply to it.
    const checkKey = `${id} ${row.createdAt}`;
    if (!row.updateOnStart) return "skipped: updates on start are off for this server";
    const [state] = [...(await observeUnits(deps.run, [id])).values()];
    if (state === undefined || !state.known || state.state.activeState !== "activating") {
      return "refused: only a server that is starting may ask for an update";
    }
    const holder = deps.locks.holder(id);
    if (holder === "backup" || holder === "restore") return "skipped: a backup or restore is running on this server";
    const previous = lastCheck.get(checkKey);
    // A clock that stepped back does not keep the check closed: the spacing is measured forward only.
    const since = previous === undefined ? Number.POSITIVE_INFINITY : now().getTime() - previous.at;
    if (since >= 0 && since < holdFor(previous?.failedRuns ?? 0)) return "skipped: checked a few minutes ago";
    const { pluginDir, sources } = getSources(deps.db, id);
    if (pluginDir === null || sources.length === 0) return "skipped: no plugin source is set";
    // A panel start or restart holds the server's lock while systemd runs this step, and that operation cannot finish until the step
    // does. The step therefore runs inside that operation rather than taking a lock of its own, which would always be refused. It is
    // counted there, so a stop cannot end the operation's wait while the jar is still being written. Any other holder, including a
    // manual plugin update, means the step must wait its turn.
    const insidePanelStart = holder === "start" || holder === "restart";
    // An update holds its own lock, so a backup or restore cannot begin while the jar is being replaced.
    const release = insidePanelStart ? deps.locks.beginBorrowedUpdate(id) : deps.locks.tryAcquire(id, "plugin-update");
    if (release === null) return "skipped: another operation is running on this server";
    try {
      // The folder goes through the jail too: a symlink inside the server directory must not send a jar elsewhere.
      const folder = resolveInside(row.directory, pluginDir, { allowMissing: true });
      const summary = summaryOf(await updatePlugins(deps.fetcher, sources, folder));
      // Only a run that completed counts toward the spacing: a run that threw before it began must not hold back the next start's check.
      // A refusal above never reaches this line, so it does not either. A run with a failed plugin lengthens the wait only while such runs
      // repeat in a row; a clean run returns the wait to the full interval.
      const failedRuns = summary.failed.length > 0 ? (lastCheck.get(checkKey)?.failedRuns ?? 0) + 1 : 0;
      lastCheck.set(checkKey, { at: now().getTime(), failedRuns });
      recordAudit(deps.db, { userId: null, userLabel: "plugin updates", serverId: id, action: "plugins.update", outcome: summary.failed.length > 0 ? "failed" : "ok", details: summary }, now());
      return `updated ${summary.updated.length}, current ${summary.current}, failed ${summary.failed.length}`;
    } catch (error) {
      const reason = error instanceof JailError ? error.message : reasonOf(error);
      recordAudit(deps.db, { userId: null, userLabel: "plugin updates", serverId: id, action: "plugins.update", outcome: "failed", details: { reason } }, now());
      return `failed: ${reason}`;
    } finally {
      release();
    }
  };
}
