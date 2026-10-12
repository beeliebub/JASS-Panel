// Server rows. JSON columns are validated on write and again on read: a stored value that no longer matches the schema is an
// error that names the row, never a silent default that would then be written back.
import { z } from "zod";
import type { PanelDatabase } from "../db/open.js";

export class StoreError extends Error {}

export const memoryRecordSchema = z.strictObject({ minMb: z.int(), maxMb: z.int() });
const commandSchema = z.array(z.string().min(1).max(1024)).min(1).max(64);

export interface ServerRecord {
  readonly id: string;
  readonly displayName: string;
  readonly directory: string;
  readonly startCommand: readonly string[];
  readonly memory: z.infer<typeof memoryRecordSchema> | null;
  readonly logPath: string;
  readonly autostart: boolean;
  readonly updateOnStart: boolean;
  readonly unitDigest: string | null;
  readonly socketDigest: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface Row {
  id: string;
  display_name: string;
  directory: string;
  start_command: string;
  memory_preset: string | null;
  log_path: string;
  autostart: number;
  update_on_start: number;
  unit_digest: string | null;
  socket_digest: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: Row): ServerRecord {
  let command: unknown;
  let memory: unknown = null;
  try {
    command = JSON.parse(row.start_command);
    memory = row.memory_preset === null ? null : JSON.parse(row.memory_preset);
  } catch {
    throw new StoreError(`the stored settings of server ${row.id} are not valid JSON`);
  }
  const parsedCommand = commandSchema.safeParse(command);
  const parsedMemory = memory === null ? { success: true as const, data: null } : memoryRecordSchema.safeParse(memory);
  if (!parsedCommand.success || !parsedMemory.success) {
    throw new StoreError(`the stored settings of server ${row.id} do not match the expected shape`);
  }
  return {
    id: row.id,
    displayName: row.display_name,
    directory: row.directory,
    startCommand: parsedCommand.data,
    memory: parsedMemory.data,
    logPath: row.log_path,
    autostart: row.autostart === 1,
    updateOnStart: row.update_on_start === 1,
    unitDigest: row.unit_digest,
    socketDigest: row.socket_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listServers(db: PanelDatabase): ServerRecord[] {
  return (db.prepare("SELECT * FROM servers ORDER BY id").all() as Row[]).map(fromRow);
}

export function getServer(db: PanelDatabase, id: string): ServerRecord | undefined {
  const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? undefined : fromRow(row);
}

export interface NewServer {
  readonly id: string;
  readonly displayName: string;
  readonly directory: string;
  readonly startCommand: readonly string[];
  readonly memory: z.infer<typeof memoryRecordSchema> | null;
  readonly logPath: string;
  readonly autostart: boolean;
  readonly updateOnStart: boolean;
  readonly unitDigest: string;
  readonly socketDigest: string;
}

export function insertServer(db: PanelDatabase, server: NewServer, now: string): ServerRecord {
  const command = commandSchema.parse(server.startCommand);
  const memory = server.memory === null ? null : memoryRecordSchema.parse(server.memory);
  db.prepare(
    `INSERT INTO servers (id, display_name, directory, start_command, memory_preset, log_path, autostart, update_on_start,
       unit_digest, socket_digest, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    server.id,
    server.displayName,
    server.directory,
    JSON.stringify(command),
    memory === null ? null : JSON.stringify(memory),
    server.logPath,
    server.autostart ? 1 : 0,
    server.updateOnStart ? 1 : 0,
    server.unitDigest,
    server.socketDigest,
    now,
    now,
  );
  const stored = getServer(db, server.id);
  if (stored === undefined) throw new StoreError(`server ${server.id} was not stored`);
  return stored;
}

export function deleteServerRow(db: PanelDatabase, id: string): boolean {
  return db.prepare("DELETE FROM servers WHERE id = ?").run(id).changes === 1;
}
