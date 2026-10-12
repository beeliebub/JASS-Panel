// Turns "update plugins on start" on or off for a server. The unit is the panel's own file, so the change rewrites it: the ExecStartPre
// line is added or removed, and the recorded digest follows. A unit that someone edited by hand is not rewritten.
import { readFileSync } from "node:fs";
import { recordAudit } from "../audit/audit.js";
import type { PanelConfig } from "../config/config.js";
import type { PanelDatabase } from "../db/open.js";
import { ensureUpdateRequest } from "../control/update-request.js";
import { ServiceError, type Actor } from "../servers/service.js";
import { digest, renderServiceUnit } from "../servers/unit.js";
import { getServer } from "../servers/store.js";
import { reloadManager, serviceFile, unitMatchesRecord, writeAtomic } from "../servers/files.js";
import type { Runner } from "../systemd/run.js";

export async function setUpdateOnStart(
  deps: { db: PanelDatabase; config: PanelConfig; run: Runner; now: () => Date },
  serverId: string,
  enabled: boolean,
  actor: Actor,
): Promise<void> {
  const row = getServer(deps.db, serverId);
  if (row === undefined) throw new ServiceError("not_found", "There is no such server.");
  const units = { unitDir: deps.config.unitDir, paths: deps.config.paths };
  if (!unitMatchesRecord(units, serverId, row.unitDigest, row.socketDigest)) {
    throw new ServiceError("conflict", "The unit file was edited by hand. Change it yourself, then try again.");
  }
  const script = ensureUpdateRequest(deps.config.dataDir, process.execPath);
  const text = renderServiceUnit(
    { id: serverId, directory: row.directory, startCommand: row.startCommand },
    deps.config.dataDir,
    enabled ? { updateOnStart: { nodePath: process.execPath, script, socket: deps.config.paths.controlSocket } } : {},
  );
  const file = serviceFile(deps.config.unitDir, serverId);
  // The file on disk matches the recorded digest (checked above), so it is kept to put back if systemd will not load the new one. Without
  // that, the recorded digest would describe a unit that is no longer there, and every later check would report the unit as edited by hand.
  const previous = readFileSync(file, "utf8");
  writeAtomic(file, text, 0o644);
  try {
    await reloadManager(deps.run);
  } catch (error) {
    writeAtomic(file, previous, 0o644);
    throw error;
  }
  deps.db.transaction(() => {
    deps.db.prepare("UPDATE servers SET update_on_start = ?, unit_digest = ?, updated_at = ? WHERE id = ?").run(
      enabled ? 1 : 0,
      digest(text),
      deps.now().toISOString(),
      serverId,
    );
    recordAudit(deps.db, { userId: actor.id, userLabel: actor.label, serverId, action: "plugins.update-on-start", outcome: "ok", details: { enabled } }, deps.now());
  })();
}
