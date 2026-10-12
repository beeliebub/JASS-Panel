// Whether a person who is not in front of the panel still holds a capability. A scheduled firing and the end of a countdown both run with
// no browser behind them, so the website is asked who the person is now (the answer is never cached) and then the grant is read. Only a
// confirmed, authorised person holds the capability: unknown is never a reason to act.
import type { PanelDatabase } from "../db/open.js";
import type { IdentityLookup, ScheduledIdentityAnswer } from "../gate/identity.js";
import { authorize } from "./authorize.js";
import type { Capability } from "./capabilities.js";

export type HoldCheck = { readonly holds: true } | { readonly holds: false; readonly reason: string };

export function decideHold(answer: ScheduledIdentityAnswer, authorized: boolean): HoldCheck {
  if (answer.kind === "unavailable") return { holds: false, reason: "the website could not confirm the person" };
  if (answer.kind === "not_eligible") return { holds: false, reason: "the person no longer has panel access" };
  if (!authorized) return { holds: false, reason: "the person no longer holds the needed capability" };
  return { holds: true };
}

export async function stillHolds(identity: IdentityLookup, db: PanelDatabase, userId: string, capability: Capability, serverId: string): Promise<HoldCheck> {
  const answer = await identity.lookup(userId);
  const authorized = answer.kind === "eligible" && authorize(db, { id: answer.user.id, role: answer.user.role }, capability, serverId);
  return decideHold(answer, authorized);
}
