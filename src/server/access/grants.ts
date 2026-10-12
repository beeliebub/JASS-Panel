// Grant rows: who may do what, on which server. Writes are OWNER-only: the access.manage capability lets an ADMIN see the access
// screen, but changing a grant is reserved to the owner role, which is the one that may hand out panel-wide access. Every write
// writes its audit row in the same transaction.
import { z } from "zod";
import { recordAudit } from "../audit/audit.js";
import { isCapability, isPanelCapability } from "../authz/capabilities.js";
import type { PanelDatabase } from "../db/open.js";
import { isServerId, WILDCARD } from "../authz/authorize.js";
import { listServers } from "../servers/store.js";

export const grantBodySchema = z.strictObject({
  userId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  serverId: z.string().max(32),
  capability: z.string().max(40),
});

export class GrantError extends Error {}

export interface GrantRow {
  readonly userId: string;
  readonly serverId: string;
  readonly capability: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

export function validateGrant(db: PanelDatabase, input: z.infer<typeof grantBodySchema>): void {
  if (!isCapability(input.capability)) throw new GrantError("that capability does not exist");
  if (isPanelCapability(input.capability)) {
    if (input.serverId !== WILDCARD) throw new GrantError("a panel capability applies to the whole panel, not one server");
    return;
  }
  if (input.serverId === WILDCARD) return;
  if (!isServerId(input.serverId)) throw new GrantError("the server id is not valid");
  const exists = listServers(db).some((server) => server.id === input.serverId);
  if (!exists) throw new GrantError("there is no such server");
}

export function listGrants(db: PanelDatabase): GrantRow[] {
  return (
    db
      .prepare("SELECT user_id AS userId, server_id AS serverId, capability, granted_by AS grantedBy, granted_at AS grantedAt FROM grants ORDER BY user_id, server_id, capability")
      .all() as GrantRow[]
  );
}

export function listKnownUsers(db: PanelDatabase): { id: string; email: string; name: string | null; lastSeen: string }[] {
  return db.prepare("SELECT id, email, name, last_seen AS lastSeen FROM known_users ORDER BY email").all() as {
    id: string;
    email: string;
    name: string | null;
    lastSeen: string;
  }[];
}

export function setGrant(db: PanelDatabase, input: z.infer<typeof grantBodySchema>, actor: { id: string; label: string }, at: Date): void {
  validateGrant(db, input);
  db.transaction(() => {
    const inserted = db.prepare(
      "INSERT OR IGNORE INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)",
    ).run(input.userId, input.serverId, input.capability, actor.id, at.toISOString()).changes === 1;
    // A grant that is already in place changes nothing, so it writes no row: the log records changes, not repeats.
    if (inserted) recordAudit(
      db,
      { userId: actor.id, userLabel: actor.label, serverId: null, action: "access.grant", outcome: "ok", details: { target: input.userId, capability: input.capability, server: input.serverId } },
      at,
    );
  })();
}

export function revokeGrant(db: PanelDatabase, input: z.infer<typeof grantBodySchema>, actor: { id: string; label: string }, at: Date): boolean {
  let removed = false;
  db.transaction(() => {
    removed =
      db.prepare("DELETE FROM grants WHERE user_id = ? AND server_id = ? AND capability = ?").run(input.userId, input.serverId, input.capability).changes === 1;
    recordAudit(
      db,
      { userId: actor.id, userLabel: actor.label, serverId: null, action: "access.revoke", outcome: removed ? "ok" : "failed", details: { target: input.userId, capability: input.capability, server: input.serverId } },
      at,
    );
  })();
  return removed;
}

/** Records or refreshes a person's name for the access screen. Never consulted when deciding access. */
export function touchKnownUser(db: PanelDatabase, user: { id: string; email: string; name: string | null }, at: Date): void {
  db.prepare(
    `INSERT INTO known_users (id, email, name, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, last_seen = excluded.last_seen`,
  ).run(user.id, user.email, user.name, at.toISOString());
}
