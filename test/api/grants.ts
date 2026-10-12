// Test helper: writes grant rows directly, as the grants editor will. Only the test database is touched.
import type { PanelDatabase } from "../../src/server/db/open.js";

export function grantRows(db: PanelDatabase, userId: string, serverId: string, capabilities: readonly string[]): void {
  const insert = db.prepare("INSERT OR REPLACE INTO grants (user_id, server_id, capability, granted_by, granted_at) VALUES (?, ?, ?, 'test', 'now')");
  for (const capability of capabilities) insert.run(userId, serverId, capability);
}
