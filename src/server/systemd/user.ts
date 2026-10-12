// Calls to the systemd user manager. Every unit name is placed after `--`, so a name that starts with a dash can never be read
// as an option. The state read is one call covering every server, and an unreadable answer is "unknown", never a guess.
import type { Runner } from "./run.js";

export const UNIT_PREFIX = "jass-mc-";

export function serviceUnit(id: string): string {
  return `${UNIT_PREFIX}${id}.service`;
}

export function socketUnit(id: string): string {
  return `${UNIT_PREFIX}${id}.socket`;
}

export interface UnitState {
  readonly activeState: string;
  readonly subState: string;
  readonly result: string;
  readonly execMainStatus: number | null;
  readonly nRestarts: number | null;
  readonly mainPid: number | null;
  readonly activeSince: string | null;
  readonly memoryBytes: number | null;
  /** The id systemd gives each start of the unit. Its journal lines carry it, so they can be told apart from an earlier run's. */
  readonly invocationId: string | null;
  /** Whether this run has printed its Done line. systemd does not report it: readiness fills it in, and it is false until then. */
  readonly loaded: boolean;
}

export type ObservedState = { readonly known: true; readonly state: UnitState } | { readonly known: false; readonly reason: string };

export const SHOW_PROPERTIES = [
  "Id",
  "ActiveState",
  "SubState",
  "Result",
  "ExecMainStatus",
  "NRestarts",
  "MainPID",
  "ActiveEnterTimestamp",
  "MemoryCurrent",
  "InvocationID",
  "LoadState",
] as const;

/** Parses the key=value blocks `systemctl show` prints, one block per unit, separated by a blank line. */
export function parseShow(text: string): Map<string, Record<string, string>> {
  const blocks = new Map<string, Record<string, string>>();
  for (const block of text.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const entries: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const equals = line.indexOf("=");
      if (equals <= 0) continue;
      entries[line.slice(0, equals)] = line.slice(equals + 1);
    }
    const id = entries.Id;
    if (id !== undefined && id !== "") blocks.set(id, entries);
  }
  return blocks;
}

function integer(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** MemoryCurrent is a byte count, or the marker or the maximum integer when the controller is not delegated: those are unknown. */
function memory(value: string | undefined): number | null {
  if (value === undefined || value === "" || value === "[not set]") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed >= 2 ** 63 - 1 || parsed > 2 ** 52) return null;
  return parsed;
}

export function toUnitState(entries: Record<string, string>): UnitState {
  return {
    activeState: entries.ActiveState ?? "unknown",
    subState: entries.SubState ?? "unknown",
    result: entries.Result ?? "unknown",
    execMainStatus: integer(entries.ExecMainStatus),
    nRestarts: integer(entries.NRestarts),
    mainPid: integer(entries.MainPID),
    activeSince: entries.ActiveEnterTimestamp === undefined || entries.ActiveEnterTimestamp === "" ? null : entries.ActiveEnterTimestamp,
    memoryBytes: memory(entries.MemoryCurrent),
    invocationId: entries.InvocationID === undefined || entries.InvocationID === "" ? null : entries.InvocationID,
    loaded: false,
  };
}

/** One systemctl call for every service. A failed call, or a unit missing from its output, is unknown for that server. */
export async function observeUnits(run: Runner, ids: readonly string[]): Promise<Map<string, ObservedState>> {
  const result = new Map<string, ObservedState>();
  if (ids.length === 0) return result;
  const units = ids.map(serviceUnit);
  const argv = ["systemctl", "--user", "show", `--property=${SHOW_PROPERTIES.join(",")}`, "--", ...units];
  const outcome = await run(argv);
  const blocks = outcome.code === 0 ? parseShow(outcome.stdout) : new Map<string, Record<string, string>>();
  for (const id of ids) {
    const entries = blocks.get(serviceUnit(id));
    if (outcome.code !== 0) {
      result.set(id, { known: false, reason: "systemctl could not be read" });
    } else if (entries === undefined || entries.LoadState === "not-found") {
      // systemd still prints a block for a unit whose file is gone, with the inactive defaults, so the answer is read from LoadState.
      result.set(id, { known: false, reason: "the unit is not known to systemd" });
    } else {
      result.set(id, { known: true, state: toUnitState(entries) });
    }
  }
  return result;
}
