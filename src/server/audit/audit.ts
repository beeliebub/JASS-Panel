// The audit writer. A row is written inside the same transaction as the change it records, so a change without its row cannot
// exist. Details are JSON with every key that names a secret removed before they are stored: the rule is enforced here, so no
// caller can forget it.
import type { PanelDatabase } from "../db/open.js";

export type AuditOutcome = "ok" | "failed" | "denied" | "started" | "cancelled" | "not_sent";

export interface AuditEntry {
  readonly userId: string | null;
  readonly userLabel: string | null;
  readonly serverId: string | null;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly details?: Readonly<Record<string, unknown>>;
}

const SECRET_KEY = /pass(word|wd)?|secret|token|cookie|authori[sz]ation|webhook|credential|sudo|session/i;
const MAX_DETAILS_BYTES = 4096;

/** Returns a copy of the value with every secret-named key removed, at any depth. Arrays keep their order. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested]";
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = redactSecrets(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export function encodeDetails(details: Readonly<Record<string, unknown>> | undefined): string | null {
  if (details === undefined) return null;
  const text = JSON.stringify(redactSecrets(details));
  if (text.length <= MAX_DETAILS_BYTES) return text;
  return JSON.stringify({ truncated: true, bytes: text.length });
}

/** Writes one audit row. Call it inside the transaction of the change it describes. */
export function recordAudit(db: PanelDatabase, entry: AuditEntry, at: Date = new Date()): void {
  db.prepare(
    "INSERT INTO audit (at, user_id, user_label, server_id, action, details, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    at.toISOString(),
    entry.userId,
    entry.userLabel,
    entry.serverId,
    entry.action,
    encodeDetails(entry.details),
    entry.outcome,
  );
}
