// The files the panel owns for a server: its two user units, and the stop-event script they share. Units are written atomically,
// and a unit whose content no longer matches the digest the panel recorded is not overwritten: someone edited it by hand.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PanelPaths } from "../config/config.js";
import type { Runner } from "../systemd/run.js";
import { serviceUnit, socketUnit } from "../systemd/user.js";
import { digest, renderServiceUnit, renderSocketUnit, STOP_EVENT_SCRIPT, type UnitServer } from "./unit.js";

export class DriftError extends Error {}

export interface UnitPaths {
  readonly unitDir: string;
  readonly paths: PanelPaths;
}

export function serviceFile(unitDir: string, id: string): string {
  return join(unitDir, serviceUnit(id));
}

export function socketFile(unitDir: string, id: string): string {
  return join(unitDir, socketUnit(id));
}

/** Writes the constant stop-event script and the events directory it appends to. Rewritten when its text differs. */
export function ensureStopEvent(paths: PanelPaths): string {
  mkdirSync(paths.bin, { recursive: true, mode: 0o700 });
  mkdirSync(paths.events, { recursive: true, mode: 0o700 });
  const script = join(paths.bin, "stop-event");
  if (!existsSync(script) || readFileSync(script, "utf8") !== STOP_EVENT_SCRIPT) {
    writeAtomic(script, STOP_EVENT_SCRIPT, 0o700);
  }
  return script;
}

export function writeAtomic(target: string, text: string, mode: number): void {
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, text, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, target);
}

/** The digest of what is on disk, or null when the file is absent. */
export function fileDigest(file: string): string | null {
  return existsSync(file) ? digest(readFileSync(file, "utf8")) : null;
}

export interface WrittenUnits {
  readonly serviceDigest: string;
  readonly socketDigest: string;
}

/** Writes both unit files for a new server. Refuses when either file already exists: that is a clash, not a replacement. */
export function writeNewUnits(units: UnitPaths, server: UnitServer, dataDir: string): WrittenUnits {
  mkdirSync(units.unitDir, { recursive: true, mode: 0o700 });
  const service = serviceFile(units.unitDir, server.id);
  const socket = socketFile(units.unitDir, server.id);
  if (existsSync(service) || existsSync(socket)) {
    throw new DriftError(`a unit file for ${server.id} already exists; remove it by hand or choose another id`);
  }
  const serviceText = renderServiceUnit(server, dataDir);
  const socketText = renderSocketUnit(server.id);
  writeAtomic(service, serviceText, 0o644);
  try {
    writeAtomic(socket, socketText, 0o644);
  } catch (error) {
    // A service without its socket is a unit that cannot take input; remove it so nothing half-written is left behind.
    rmSync(service, { force: true });
    throw error;
  }
  return { serviceDigest: digest(serviceText), socketDigest: digest(socketText) };
}

/** True when the unit on disk is the one the panel last wrote. Anything else is someone else's edit. */
export function unitMatchesRecord(units: UnitPaths, id: string, serviceDigest: string | null, socketDigest: string | null): boolean {
  return fileDigest(serviceFile(units.unitDir, id)) === serviceDigest && fileDigest(socketFile(units.unitDir, id)) === socketDigest;
}

export function removeUnits(units: UnitPaths, id: string): void {
  rmSync(serviceFile(units.unitDir, id), { force: true });
  rmSync(socketFile(units.unitDir, id), { force: true });
}

export async function reloadManager(run: Runner): Promise<void> {
  const result = await run(["systemctl", "--user", "daemon-reload"]);
  if (result.code !== 0) throw new Error("systemctl --user daemon-reload failed");
}
