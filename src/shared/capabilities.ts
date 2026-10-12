// The capability names the daemon and the UI both use. The server keeps the checks that decide them; the names live here so the UI
// can offer exactly the capabilities that exist.

/**
 * Entry to the panel. An OWNER has it; an ADMIN has it only with at least one grant row, so an ADMIN with no rows is refused on every route
 * and sees the no-access screen.
 */
export const PANEL_ACCESS = "panel.access";

/**
 * Designates a person as a panel operator: every server capability on every server, including servers added later. It is a row for the
 * wildcard server and carries none of the panel capabilities below. An owner or a panel operator may grant or remove it.
 */
export const PANEL_OPERATOR = "panel.operator";

export const SERVER_CAPABILITY_NAMES = [
  "server.view",
  "console.read",
  "console.send",
  "power",
  "files.read",
  "files.write",
  "backups",
  "schedules",
  "plugins",
  "players",
  "settings",
] as const;

export const PANEL_CAPABILITY_NAMES = [PANEL_ACCESS, "servers.manage", "access.manage", "settings.manage", "audit.read", "root.run", PANEL_OPERATOR] as const;

/** Capabilities that can make code run as the account the panel runs as. The UI labels each one. */
export const HIGH_RISK_CAPABILITY_NAMES = ["console.send", "files.write", "plugins", "schedules", "servers.manage", "root.run", PANEL_OPERATOR] as const;
