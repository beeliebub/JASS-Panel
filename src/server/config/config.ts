// The daemon's configuration, read once from an explicit environment object. Nothing below the entry point reads process.env,
// so tests pass their own environment and every path the daemon uses is derived here. No value names a particular account or
// home directory: defaults come from the XDG base directories of the account that runs the daemon.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export class ConfigError extends Error {}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface PanelPaths {
  readonly database: string;
  readonly databaseBackups: string;
  readonly fileHistory: string;
  readonly markers: string;
  readonly bin: string;
  readonly events: string;
  readonly backups: string;
  readonly controlSocket: string;
}

export interface PanelConfig {
  /** The website's public origin, for the Origin check on mutating requests. */
  readonly publicOrigin: string;
  /** Host header value the public origin implies (hostname plus port when one is given). */
  readonly publicHost: string;
  /** Loopback URL of the website, used for identity lookups. */
  readonly siteOrigin: string;
  readonly port: number;
  readonly basePath: string;
  readonly dataDir: string;
  /** Directory where the daemon writes the user units of game servers. */
  readonly unitDir: string;
  /** systemd's per-user runtime directory, where each server's stdin FIFO is created (%t in the unit). */
  readonly runtimeDir: string;
  readonly paths: PanelPaths;
}

function derivePaths(dataDir: string): PanelPaths {
  return {
    database: join(dataDir, "panel.db"),
    databaseBackups: join(dataDir, "db-backups"),
    fileHistory: join(dataDir, "file-history"),
    markers: join(dataDir, "markers"),
    bin: join(dataDir, "bin"),
    events: join(dataDir, "events"),
    backups: join(dataDir, "backups"),
    controlSocket: join(dataDir, "control.sock"),
  };
}

function parsePublicOrigin(raw: string): { origin: string; host: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("PANEL_PUBLIC_ORIGIN must be an absolute URL such as https://example.net");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("PANEL_PUBLIC_ORIGIN must use http or https");
  }
  if (url.origin !== raw.replace(/\/$/, "")) {
    throw new ConfigError("PANEL_PUBLIC_ORIGIN must be an origin only, with no path, query or credentials");
  }
  return { origin: url.origin, host: url.host };
}

function parseSiteOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("SITE_INTERNAL_URL must be an absolute URL");
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    // Identity lookups carry the browser's session cookie, so they must never leave the machine.
    throw new ConfigError("SITE_INTERNAL_URL must be a loopback http URL");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ConfigError("SITE_INTERNAL_URL must be an origin only");
  }
  return url.origin;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("PANEL_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function parseBasePath(raw: string): string {
  if (!/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(raw)) {
    throw new ConfigError("PANEL_BASE_PATH must be an absolute path with no trailing slash, such as /panel");
  }
  return raw;
}

function absoluteOrThrow(name: string, value: string): string {
  if (!isAbsolute(value)) throw new ConfigError(`${name} must be an absolute path`);
  return value;
}

/** Reads the configuration from an environment object. Throws ConfigError with a message that names the variable. */
// The uid only shapes the default runtime directory. Callers that never touch a server (migrations, most tests) may omit it.
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly uid: number } = { uid: 0 },
): PanelConfig {
  const publicRaw = env.PANEL_PUBLIC_ORIGIN;
  if (publicRaw === undefined || publicRaw === "") {
    throw new ConfigError("PANEL_PUBLIC_ORIGIN is required, for example https://example.net");
  }
  const { origin, host } = parsePublicOrigin(publicRaw);
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
  const xdgData = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME !== "" ? env.XDG_DATA_HOME : join(home, ".local", "share");
  const xdgConfig = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== "" ? env.XDG_CONFIG_HOME : join(home, ".config");
  const dataDir =
    env.PANEL_DATA_DIR !== undefined && env.PANEL_DATA_DIR !== ""
      ? absoluteOrThrow("PANEL_DATA_DIR", env.PANEL_DATA_DIR)
      : join(xdgData, "jass-panel");
  const port = parsePort(env.PANEL_PORT ?? "29200");
  return {
    publicOrigin: origin,
    publicHost: host,
    siteOrigin: parseSiteOrigin(env.SITE_INTERNAL_URL ?? "http://127.0.0.1:3000"),
    port,
    basePath: parseBasePath(env.PANEL_BASE_PATH ?? "/panel"),
    dataDir,
    unitDir: join(xdgConfig, "systemd", "user"),
    runtimeDir: env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== "" ? absoluteOrThrow("XDG_RUNTIME_DIR", env.XDG_RUNTIME_DIR) : join("/run/user", String(options.uid)),
    paths: derivePaths(dataDir),
  };
}

/** Hosts the daemon accepts in the Host header: the public host, or loopback on any port (a DNS-rebinding guard). */
export function isAllowedHost(hostHeader: string | undefined, config: Pick<PanelConfig, "publicHost">): boolean {
  if (hostHeader === undefined || hostHeader === "") return false;
  if (hostHeader.toLowerCase() === config.publicHost.toLowerCase()) return true;
  const hostname = hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0];
  return hostname !== undefined && LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}
