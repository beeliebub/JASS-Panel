// The only permission check in the daemon. `decide` is pure, so every rule is tested over plain values; `authorize` loads the
// person's grant rows and asks `decide`. Anything unexpected is a denial: a server capability asked without a server, a server
// id that is not a slug (in particular the wildcard, which would otherwise match every grant), a role other than OWNER or
// ADMIN.
import type { PanelDatabase } from "../db/open.js";
import { isPanelCapability, isServerCapability, PANEL_ACCESS, PANEL_OPERATOR, type Capability } from "./capabilities.js";

export const WILDCARD = "*";
const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type Role = "OWNER" | "ADMIN";

export interface Principal {
  readonly id: string;
  readonly role: Role;
}

export interface GrantRow {
  readonly serverId: string;
  readonly capability: string;
}

export function isServerId(value: string): boolean {
  return SERVER_ID.test(value);
}

/**
 * Decides one capability for one person. An owner, and a panel operator (an ADMIN with a wildcard row for `panel.operator`), hold the same
 * abilities: every server capability on every valid server, and every panel capability. An ADMIN otherwise holds what a grant row allows;
 * `*` grants reach every server, including ones added later. `server.view` also follows from any other server capability on that server.
 * Panel access is not a grant of its own: an ADMIN has it only with at least one row, so one with no rows is refused.
 */
export function decide(principal: Principal, grants: readonly GrantRow[], capability: Capability, serverId?: string): boolean {
  if (principal.role !== "OWNER" && principal.role !== "ADMIN") return false;
  const everything = principal.role === "OWNER" || grants.some((grant) => grant.serverId === WILDCARD && grant.capability === PANEL_OPERATOR);
  if (capability === PANEL_ACCESS) return everything || grants.length > 0;

  if (isPanelCapability(capability)) {
    return everything || grants.some((grant) => grant.serverId === WILDCARD && grant.capability === capability);
  }

  if (!isServerCapability(capability)) return false;
  if (serverId === undefined || serverId === WILDCARD || !isServerId(serverId)) return false;
  if (everything) return true;

  return grants.some((grant) => {
    if (grant.serverId !== WILDCARD && grant.serverId !== serverId) return false;
    if (grant.capability === capability) return true;
    return capability === "server.view" && isServerCapability(grant.capability);
  });
}

/**
 * Loads the person's grant rows. Only the rows for this user are read, and only those that still name a server that exists or the
 * wildcard: a row left behind by a removed server must not give access, or come back to life when a server of that id is added again.
 */
export function loadGrants(db: PanelDatabase, userId: string): GrantRow[] {
  const rows = db
    .prepare("SELECT server_id AS serverId, capability FROM grants WHERE user_id = ? AND (server_id = '*' OR server_id IN (SELECT id FROM servers))")
    .all(userId) as GrantRow[];
  return rows;
}

export function authorize(db: PanelDatabase, principal: Principal, capability: Capability, serverId?: string): boolean {
  if (principal.role !== "OWNER" && principal.role !== "ADMIN") return false;
  // OWNER needs no rows; loading them is wasted work for the common case, so skip the query.
  const grants = principal.role === "OWNER" ? [] : loadGrants(db, principal.id);
  return decide(principal, grants, capability, serverId);
}

/** Whether a person may change access: an owner, or a panel operator, who hold the same abilities. */
export function isOwnerOrOperator(db: PanelDatabase, principal: Principal): boolean {
  return authorize(db, principal, PANEL_OPERATOR);
}
