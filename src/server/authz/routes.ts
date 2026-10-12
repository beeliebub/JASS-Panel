// Every API route, with the capability the guard checks before the handler runs. The type requires a capability on each entry.
// A route whose path names a server uses a server capability, with one exception: removing a server is a panel-wide act, so it is
// guarded by servers.manage, and the server id is only the target. Paths are relative to the API prefix.
import { PANEL_ACCESS, type Capability } from "./capabilities.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteSpec {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly capability: Capability;
}

export const ROUTES = [
  { id: "me", method: "GET", path: "/me", capability: PANEL_ACCESS },
  { id: "events.stream", method: "GET", path: "/events", capability: PANEL_ACCESS },
  { id: "servers.list", method: "GET", path: "/servers", capability: PANEL_ACCESS },
  { id: "servers.add", method: "POST", path: "/servers", capability: "servers.manage" },
  { id: "servers.get", method: "GET", path: "/servers/:serverId", capability: "server.view" },
  { id: "servers.remove", method: "DELETE", path: "/servers/:serverId", capability: "servers.manage" },
  { id: "servers.power", method: "POST", path: "/servers/:serverId/power", capability: "power" },
  { id: "servers.power-cancel", method: "POST", path: "/servers/:serverId/power/cancel", capability: "power" },
  { id: "servers.autostart", method: "PUT", path: "/servers/:serverId/autostart", capability: "settings" },
  { id: "console.history", method: "GET", path: "/servers/:serverId/console", capability: "console.read" },
  { id: "console.stream", method: "GET", path: "/servers/:serverId/console/stream", capability: "console.read" },
  { id: "console.send", method: "POST", path: "/servers/:serverId/console", capability: "console.send" },
  { id: "health.get", method: "GET", path: "/health", capability: PANEL_ACCESS },
  { id: "audit.list", method: "GET", path: "/audit", capability: PANEL_ACCESS },
  { id: "access.list", method: "GET", path: "/access", capability: "access.manage" },
  { id: "access.grant", method: "POST", path: "/access/grants", capability: "access.manage" },
  { id: "access.revoke", method: "DELETE", path: "/access/grants", capability: "access.manage" },
  { id: "privileged.run", method: "POST", path: "/privileged/:actionId", capability: "root.run" },
  { id: "files.list", method: "GET", path: "/servers/:serverId/files", capability: "files.read" },
  { id: "files.read", method: "GET", path: "/servers/:serverId/file", capability: "files.read" },
  { id: "files.write", method: "PUT", path: "/servers/:serverId/file", capability: "files.write" },
  { id: "files.upload", method: "PUT", path: "/servers/:serverId/upload", capability: "files.write" },
  { id: "backups.list", method: "GET", path: "/servers/:serverId/backups", capability: "backups" },
  { id: "backups.create", method: "POST", path: "/servers/:serverId/backups", capability: "backups" },
  { id: "backups.restore", method: "POST", path: "/servers/:serverId/backups/:backupId/restore", capability: "backups" },
  { id: "backups.leftovers", method: "GET", path: "/servers/:serverId/leftovers", capability: "backups" },
  { id: "backups.leftover-remove", method: "DELETE", path: "/servers/:serverId/leftovers/:name", capability: "backups" },
  { id: "backups.restore-record-clear", method: "POST", path: "/servers/:serverId/backups/restore-record/clear", capability: "backups" },
  { id: "schedules.list", method: "GET", path: "/servers/:serverId/schedules", capability: "schedules" },
  { id: "schedules.add", method: "POST", path: "/servers/:serverId/schedules", capability: "schedules" },
  { id: "schedules.remove", method: "DELETE", path: "/servers/:serverId/schedules/:scheduleId", capability: "schedules" },
  { id: "players.list", method: "GET", path: "/servers/:serverId/players", capability: "server.view" },
  { id: "chat.send", method: "POST", path: "/servers/:serverId/chat", capability: "console.send" },
  { id: "players.action", method: "POST", path: "/servers/:serverId/players/:action", capability: "players" },
  { id: "plugins.sources.get", method: "GET", path: "/servers/:serverId/plugin-sources", capability: "plugins" },
  { id: "plugins.sources.set", method: "PUT", path: "/servers/:serverId/plugin-sources", capability: "plugins" },
  { id: "plugins.catalogue", method: "POST", path: "/servers/:serverId/plugin-catalogue", capability: "plugins" },
  { id: "plugins.update", method: "POST", path: "/servers/:serverId/plugins/update", capability: "plugins" },
  { id: "plugins.update-on-start", method: "PUT", path: "/servers/:serverId/update-on-start", capability: "plugins" },
  { id: "settings.get", method: "GET", path: "/settings", capability: "settings.manage" },
  { id: "settings.webhook", method: "PUT", path: "/settings/webhook", capability: "settings.manage" },
  { id: "settings.retention", method: "PUT", path: "/settings/backup-retention", capability: "settings.manage" },
] as const satisfies readonly RouteSpec[];

export type RouteId = (typeof ROUTES)[number]["id"];
