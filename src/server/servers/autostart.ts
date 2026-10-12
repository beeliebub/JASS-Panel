// Whether a server starts with the account's user manager, which is at boot once lingering is on. The stored choice records the unit's
// enablement. A change goes to the unit first and the stored choice follows; if the unit cannot be changed, both stay as they were. When
// the panel starts it reads each unit's enablement back, so a change made by hand while the panel was not running is recorded as systemd
// has it.
import { recordAudit } from "../audit/audit.js";
import type { PanelDatabase } from "../db/open.js";
import type { OperationLocks } from "../power/lock.js";
import type { Runner } from "../systemd/run.js";
import { serviceUnit } from "../systemd/user.js";
import { ServiceError, type Actor } from "./service.js";
import { getServer, listServers } from "./store.js";

export interface AutostartDependencies {
  readonly db: PanelDatabase;
  readonly run: Runner;
  readonly locks: OperationLocks;
  readonly now: () => Date;
}

export async function setAutostart(deps: AutostartDependencies, serverId: string, enabled: boolean, actor: Actor): Promise<void> {
  // A start, a backup or a removal of the server holds its lock, and the unit must not change under any of them. The row is read under
  // the lock too, so a change made by another request is seen before this one decides anything.
  const release = deps.locks.tryAcquire(serverId, "autostart");
  if (release === null) throw new ServiceError("conflict", "Another operation is running on this server. Try again when it finishes.");
  const actorFields = { userId: actor.id, userLabel: actor.label, serverId, action: "server.autostart" };
  try {
    if (getServer(deps.db, serverId) === undefined) throw new ServiceError("not_found", "There is no such server.");
    // The unit is changed even when the stored choice already matches. The stored choice only records the unit, and it can drift from it,
    // so asking for the same choice again is how a drifted unit is put right.
    if (!(await applyChoice(deps.run, serverId, enabled))) {
      recordAudit(deps.db, { ...actorFields, outcome: "failed", details: { enabled } }, deps.now());
      throw new ServiceError("conflict", "systemd would not change whether the server starts with the machine.");
    }
    try {
      deps.db.transaction(() => {
        const changed = deps.db
          .prepare("UPDATE servers SET autostart = ?, updated_at = ? WHERE id = ?")
          .run(enabled ? 1 : 0, deps.now().toISOString(), serverId).changes;
        if (changed !== 1) throw new ServiceError("not_found", "There is no such server.");
        recordAudit(deps.db, { ...actorFields, outcome: "ok", details: { enabled } }, deps.now());
      })();
    } catch (error) {
      // The stored choice could not be written, so the unit goes back to the state the stored choice still records. If that fails too, the
      // audit trail says so, and the next start of the panel reads the unit back.
      if (!(await applyChoice(deps.run, serverId, !enabled))) {
        recordAudit(deps.db, { ...actorFields, outcome: "failed", details: { enabled, reverted: false } }, deps.now());
      }
      throw error;
    }
  } finally {
    release();
  }
}

/**
 * Enables or disables the unit and reports whether systemd made the change. A run that systemd never gave an exit code for is settled by
 * reading the unit back, so a change that did happen is not reported as refused.
 */
async function applyChoice(run: Runner, serverId: string, enabled: boolean): Promise<boolean> {
  const result = await run(["systemctl", "--user", enabled ? "enable" : "disable", "--", serviceUnit(serverId)]);
  if (result.code === 0) return true;
  if (result.code !== null) return false;
  return (await readEnabled(run, serverId)) === enabled;
}

/** Whether systemd reports the server's unit as enabled, or null when it reports neither state. Nothing is changed by reading it. */
export async function readEnabled(run: Runner, serverId: string): Promise<boolean | null> {
  const state = (await run(["systemctl", "--user", "is-enabled", "--", serviceUnit(serverId)])).stdout.trim();
  if (state === "enabled" || state === "enabled-runtime") return true;
  if (state === "disabled") return false;
  return null;
}

/**
 * At the panel's start, each stored choice is set from its unit's enablement. A unit that systemd does not report on keeps its stored
 * choice. Nothing is enabled or disabled here: this only records what systemd already has.
 */
export async function reconcileAutostart(deps: Pick<AutostartDependencies, "db" | "run" | "now">): Promise<void> {
  for (const row of listServers(deps.db)) {
    const enabled = await readEnabled(deps.run, row.id).catch(() => null);
    if (enabled === null || enabled === row.autostart) continue;
    deps.db.transaction(() => {
      deps.db.prepare("UPDATE servers SET autostart = ? WHERE id = ?").run(enabled ? 1 : 0, row.id);
      recordAudit(
        deps.db,
        { userId: null, userLabel: "panel start", serverId: row.id, action: "server.autostart", outcome: "ok", details: { enabled, reconciled: true } },
        deps.now(),
      );
    })();
  }
}
