// The record of a restore that is in progress. It names the folders a restore moves, so start-up can settle a restore that a death
// interrupted. It is written before the first move and removed once the folders are settled. Removing the server is refused while it exists.
import { existsSync, fsyncSync, lstatSync, openSync, closeSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { PanelConfig } from "../config/config.js";

export const restoreJournalSchema = z.strictObject({
  directory: z.string().startsWith("/"),
  staging: z.string().startsWith("/"),
  aside: z.string().startsWith("/"),
  startedAt: z.string(),
});
export type RestoreJournal = z.infer<typeof restoreJournalSchema>;

export function restoreJournalOf(config: PanelConfig, serverId: string): string {
  return join(config.paths.markers, `${serverId}.restore`);
}

export interface RestoreRecordView {
  /** When the restore began, or null when the record cannot be read. */
  readonly startedAt: string | null;
  /** A record that cannot be read names no folders, so the screen can say only that it is there. */
  readonly unreadable: boolean;
  /** Each folder the record names, and whether it is there now. The person checks these before clearing the record. */
  readonly folders: readonly { readonly role: "server" | "staging" | "aside"; readonly name: string; readonly present: boolean | null }[];
}

/** Whether a folder is there: null when the panel cannot tell, as for a folder beneath one it may not read. A refusal is not an absence. */
function folderPresence(path: string): boolean | null {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
  }
}

/** The record as the backups screen shows it, or null when no restore is unsettled. A folder the panel cannot check is shown as unknown, never as present or missing. */
export function readRestoreRecord(config: PanelConfig, serverId: string): RestoreRecordView | null {
  const file = restoreJournalOf(config, serverId);
  if (!existsSync(file)) return null;
  let record: RestoreJournal;
  try {
    record = restoreJournalSchema.parse(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch {
    return { startedAt: null, unreadable: true, folders: [] };
  }
  const named: [RestoreRecordView["folders"][number]["role"], string][] = [
    ["server", record.directory],
    ["staging", record.staging],
    ["aside", record.aside],
  ];
  return {
    startedAt: record.startedAt,
    unreadable: false,
    folders: named.map(([role, path]) => ({ role, name: basename(path), present: folderPresence(path) })),
  };
}

/** Writes the record so that a crash leaves either the old text or the new text, never part of one: the new text is flushed, then renamed over. */
export function writeRestoreRecord(file: string, text: string): void {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  const fd = openSync(temporary, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

/** Whether a folder is there now. An answer other than "not found" is unknown, and unknown is never read as present or as missing. */
export function folderState(path: string): "present" | "missing" | "unknown" {
  try {
    return statSync(path).isDirectory() ? "present" : "unknown";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "unknown";
  }
}
