// The health panel: what the panel depends on, so a machine that cannot work says why. Each check answers ok, warning, error, or
// unknown. A check that cannot run is unknown, never a pass.
import { statfsSync, accessSync, constants } from "node:fs";
import { request } from "node:http";
import type { PanelConfig } from "../config/config.js";
import type { PanelDatabase } from "../db/open.js";
import type { Runner } from "../systemd/run.js";
import { listServers } from "../servers/store.js";

export type CheckStatus = "ok" | "warning" | "error" | "unknown";

export interface HealthCheck {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly action?: string;
}

export interface HealthDependencies {
  readonly config: PanelConfig;
  readonly db: PanelDatabase;
  readonly run: Runner;
  readonly account: string;
  readonly probeSite?: (origin: string) => Promise<boolean>;
}

const MIN_SYSTEMD = 259;

function probeSiteDefault(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(new URL("/api/panel/session", origin), { method: "GET", timeout: 3000 }, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

export async function healthReport(deps: HealthDependencies): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];

  const version = await deps.run(["systemctl", "--version"]);
  const major = Number(/^systemd (\d+)/.exec(version.stdout)?.[1]);
  if (version.code !== 0 || !Number.isInteger(major)) {
    checks.push({ id: "systemd", title: "systemd version", status: "unknown", detail: "systemctl did not report a version." });
  } else {
    checks.push({
      id: "systemd",
      title: "systemd version",
      status: major >= MIN_SYSTEMD ? "ok" : "warning",
      detail: `systemd ${major}${major >= MIN_SYSTEMD ? "" : `; the units are tested only on ${MIN_SYSTEMD} and newer`}`,
    });
  }

  const manager = await deps.run(["systemctl", "--user", "is-system-running"]);
  const managerState = manager.stdout.trim();
  checks.push({
    id: "user-manager",
    title: "systemd user manager",
    status: managerState === "running" || managerState === "degraded" ? "ok" : managerState === "" ? "unknown" : "error",
    detail: managerState === "" ? "the user manager could not be asked" : `the user manager is ${managerState}`,
  });

  const linger = await deps.run(["loginctl", "show-user", deps.account, "-p", "Linger", "--value"]);
  const lingerValue = linger.stdout.trim();
  checks.push({
    id: "linger",
    title: "Lingering",
    status: lingerValue === "yes" ? "ok" : lingerValue === "no" ? "error" : "unknown",
    detail:
      lingerValue === "yes"
        ? "enabled: servers start at boot and keep running without a login"
        : lingerValue === "no"
          ? "off: servers stop at logout and do not start at boot"
          : "loginctl did not report whether lingering is on",
    ...(lingerValue === "no" ? { action: "enable-lingering" } : {}),
  });

  try {
    accessSync(deps.config.dataDir, constants.W_OK);
    const space = statfsSync(deps.config.dataDir);
    const freeMb = Math.floor((Number(space.bavail) * Number(space.bsize)) / (1024 * 1024));
    checks.push({
      id: "data-dir",
      title: "Data directory",
      status: freeMb < 512 ? "warning" : "ok",
      detail: `writable, ${freeMb} MB free`,
    });
  } catch {
    checks.push({ id: "data-dir", title: "Data directory", status: "error", detail: "the data directory is not writable or cannot be read" });
  }

  const probe = deps.probeSite ?? probeSiteDefault;
  const reachable = await probe(deps.config.siteOrigin);
  checks.push({
    id: "website",
    title: "Website",
    status: reachable ? "ok" : "error",
    detail: reachable ? "the website answers on its loopback address" : "the website does not answer; sign-in will show unavailable",
  });

  const tar = await deps.run(["tar", "--version"]);
  // A backup that did not see the save messages Paper prints fails, and this shows it here as well as on the backups list. A Paper upgrade
  // can change those messages, so the warning is what says the upgrade needs checking.
  const unconfirmed = (
    deps.db
      .prepare("SELECT server_id AS serverId, details FROM audit WHERE action = 'backup.create' AND outcome = 'failed' AND server_id IN (SELECT id FROM servers) AND id IN (SELECT MAX(id) FROM audit WHERE action = 'backup.create' GROUP BY server_id)")
      .all() as { serverId: string | null; details: string | null }[]
  ).filter((row) => /did not confirm that (auto-save|the world)/.test(row.details ?? ""));
  checks.push({
    id: "save-messages",
    title: "Save messages",
    status: unconfirmed.length === 0 ? "ok" : "warning",
    detail:
      unconfirmed.length === 0
        ? "the last backups saw the save messages Paper prints"
        : `the last backup of ${unconfirmed.map((row) => row.serverId ?? "a server").join(", ")} did not see the save messages Paper prints. A Paper upgrade can change them; check the server's log against the backup code`,
  });
  checks.push({ id: "tar", title: "tar", status: tar.code === 0 ? "ok" : "error", detail: tar.code === 0 ? "present" : "tar is not installed; backups cannot run" });
  const zstd = await deps.run(["zstd", "--version"]);
  checks.push({
    id: "zstd",
    title: "zstd (optional)",
    status: zstd.code === 0 ? "ok" : "warning",
    detail: zstd.code === 0 ? "present; backups use zstd" : "absent; backups fall back to gzip",
  });

  for (const server of listServers(deps.db)) {
    const program = server.startCommand[0] ?? "";
    let resolvable = false;
    try {
      accessSync(program, constants.X_OK);
      resolvable = true;
    } catch {
      resolvable = false;
    }
    checks.push({
      id: `java-${server.id}`,
      title: `Java for ${server.displayName}`,
      status: resolvable ? "ok" : "error",
      detail: resolvable ? `${program} is executable` : `${program} is missing or not executable`,
    });
  }
  return checks;
}
