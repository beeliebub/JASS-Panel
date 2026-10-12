// The periodic check that turns what happened to a server into alerts. It reads the stop-event file for endings it has not handled
// yet (so a crash that happened while the panel was down still alerts once), and it watches the unit for "gave up restarting". A
// server that is running again clears both incidents.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { PanelConfig } from "../config/config.js";
import type { PanelDatabase } from "../db/open.js";
import type { AlertService } from "./alerts.js";
import { listServers } from "../servers/store.js";
import { observeUnits } from "../systemd/user.js";
import type { Runner } from "../systemd/run.js";

const EVENTS_KEPT = 1000;

function seenKey(serverId: string): string {
  return `events_seen:${serverId}`;
}

function readSeen(db: PanelDatabase, serverId: string): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(seenKey(serverId)) as { value: string } | undefined;
  const parsed = Number(row?.value ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function writeSeen(db: PanelDatabase, serverId: string, value: number): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(seenKey(serverId), String(value));
}

export async function runWatchdog(deps: { db: PanelDatabase; config: PanelConfig; run: Runner; alerts: AlertService }): Promise<void> {
  const servers = listServers(deps.db);
  const states = await observeUnits(deps.run, servers.map((server) => server.id));
  for (const server of servers) {
    const state = states.get(server.id);
    if (state?.known === true) {
      if (state.state.activeState === "active") {
        deps.alerts.clear("crashed", server.id);
        deps.alerts.clear("gave-up", server.id);
      }
      if (state.state.activeState === "failed" && state.state.result === "start-limit-hit") {
        await deps.alerts.raise("gave-up", server.id, `${server.displayName} stopped restarting after repeated failures. It needs a person to look at it.`);
      }
    }

    const file = `${deps.config.paths.events}/${server.id}.log`;
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
    const seen = Math.min(readSeen(deps.db, server.id), lines.length);
    for (const line of lines.slice(seen)) {
      const result = /result=(\S+)/.exec(line)?.[1];
      const status = /status=(\S+)/.exec(line)?.[1] ?? "unknown";
      if (result !== undefined && result !== "success") {
        await deps.alerts.raise("crashed", server.id, `${server.displayName} ended unexpectedly (${result}, status ${status}).`);
      }
    }
    // The file is kept to its newest lines, and the count of handled lines follows it, so the file never grows without bound.
    const kept = lines.slice(-EVENTS_KEPT);
    if (lines.length > EVENTS_KEPT) writeFileSync(file, `${kept.join("\n")}\n`, { mode: 0o600 });
    writeSeen(deps.db, server.id, kept.length);
  }
}
