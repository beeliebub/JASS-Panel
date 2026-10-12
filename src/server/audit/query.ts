// Reads the audit log for one person. What they may see is decided in the SQL itself: someone with audit.read sees every row;
// anyone else sees only rows about servers they may view. Rows about the panel as a whole need audit.read.
import type { PanelDatabase } from "../db/open.js";
import { authorize } from "../authz/authorize.js";
import { listServers } from "../servers/store.js";

export interface AuditRow {
  readonly id: number;
  readonly at: string;
  readonly userLabel: string | null;
  readonly serverId: string | null;
  readonly action: string;
  readonly details: string | null;
  readonly outcome: string;
}

export function auditFor(db: PanelDatabase, principal: { id: string; role: "OWNER" | "ADMIN" }, limit: number): AuditRow[] {
  const full = authorize(db, principal, "audit.read");
  if (full) {
    return db.prepare("SELECT id, at, user_label AS userLabel, server_id AS serverId, action, details, outcome FROM audit ORDER BY id DESC LIMIT ?").all(limit) as AuditRow[];
  }
  const visible = listServers(db)
    .map((server) => server.id)
    .filter((id) => authorize(db, principal, "server.view", id));
  if (visible.length === 0) return [];
  // The ids come from the server table and are bound as parameters, never concatenated into the statement.
  const placeholders = visible.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT id, at, user_label AS userLabel, server_id AS serverId, action, details, outcome FROM audit
       WHERE server_id IN (${placeholders}) ORDER BY id DESC LIMIT ?`,
    )
    .all(...visible, limit) as AuditRow[];
}
