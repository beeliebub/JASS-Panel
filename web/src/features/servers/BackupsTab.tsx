// Backups of one server: make one now, restore one over a stopped server, clear a restore that did not settle, and remove the folders
// earlier restores moved aside. A restore, a clearing and a removal all need the name typed, because none can be undone from here.
import { useEffect, useState } from "react";
import { backupSchema, backupsSchema, leftoversSchema, restoreRecordClearedSchema, type Backup } from "@shared/features.js";
import { z } from "zod";
import { PanelApiError, type ApiClient } from "../../api/client";
import { DestructiveActionDialog } from "../../components/DestructiveActionDialog";
import { StateMessage } from "../../components/StateMessage";

const createdSchema = z.strictObject({ backup: backupSchema });
const restoredSchema = z.strictObject({ restored: z.literal(true) });
const removedSchema = z.strictObject({ removed: z.string() });
const ROLE_LABELS = { server: "Server folder", staging: "Staging folder", aside: "Moved aside" } as const;
type RestoreRecord = NonNullable<z.infer<typeof backupsSchema>["restoreRecord"]>;

export function BackupsTab({ client, serverId, serverName, canWrite }: { readonly client: ApiClient; readonly serverId: string; readonly serverName: string; readonly canWrite: boolean }) {
  const [backups, setBackups] = useState<readonly Backup[] | null>(null);
  const [record, setRecord] = useState<RestoreRecord | null>(null);
  const [clearing, setClearing] = useState(false);
  const [leftovers, setLeftovers] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const base = `/api/v1/servers/${encodeURIComponent(serverId)}`;

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([client.get(`${base}/backups`, backupsSchema, controller.signal), client.get(`${base}/leftovers`, leftoversSchema, controller.signal)])
      .then(([listed, left]) => {
        setBackups(listed.backups);
        setRecord(listed.restoreRecord);
        setLeftovers(left.leftovers);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof PanelApiError ? failure.message : "The backups could not be listed.");
      });
    return () => controller.abort();
  }, [client, base, version]);

  async function run(action: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(done);
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The request did not finish.");
    } finally {
      // The listing is read again whatever happened: a restore that failed can still have left its record behind.
      setVersion((count) => count + 1);
      setBusy(false);
      setRestoring(null);
      setRemoving(null);
      setClearing(false);
    }
  }

  return (
    <section aria-label="Backups" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-panel-muted">A running server is saved first, then archived. Each archive is checked against its recorded checksum before a restore.</p>
        {canWrite && (
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() => void run(() => client.post(`${base}/backups`, createdSchema, {}), "The backup is made and recorded.")}
            type="button"
          >
            Back up now
          </button>
        )}
      </div>
      {error !== null && <StateMessage title="Something did not work" tone="error">{error}</StateMessage>}
      {message !== null && <p className="text-sm text-panel-good" role="status">{message}</p>}
      {record !== null && (
        <section aria-label="Unsettled restore" className="grid gap-2 rounded-panel border border-panel-danger/40 bg-panel-surface p-4">
          <h2 className="text-sm font-extrabold">A restore did not settle</h2>
          {record.unreadable ? (
            <p className="text-xs text-panel-muted">The restore record cannot be read, so the folders it named are not known. Check the server's folders by hand before clearing it.</p>
          ) : (
            <>
              <p className="text-xs text-panel-muted">Check these folders before clearing the record. Clearing removes only the record: no folder is changed.</p>
              <ul className="grid gap-1 text-xs">
                {record.folders.map((folder) => (
                  <li className="flex flex-wrap justify-between gap-3" key={folder.role}>
                    <span>{ROLE_LABELS[folder.role]}: <span className="font-mono">{folder.name}</span></span>
                    <span className={folder.present === true ? "text-panel-muted" : "text-panel-warn"}>{folder.present === null ? "could not be checked" : folder.present ? "present" : "missing"}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {record.startedAt !== null && <p className="text-xs text-panel-subtle">Started {new Date(record.startedAt).toLocaleString()}</p>}
          {canWrite && (
            <div>
              <button className="button button-danger" disabled={busy || !record.clearable} onClick={() => setClearing(true)} type="button">Clear the restore record</button>
              {!record.clearable && <p className="mt-2 text-xs text-panel-warn">The server folder is missing and folders from a restore are beside it. Move them back by hand, then clear the record.</p>}
            </div>
          )}
        </section>
      )}
      {backups === null && error === null && <StateMessage title="Loading backups" />}
      {backups !== null && backups.length === 0 && <StateMessage title="No backups yet">Make one to have something to restore.</StateMessage>}
      {backups !== null && backups.length > 0 && (
        <ul className="grid gap-2">
          {backups.map((backup) => (
            <li className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-panel-line bg-panel-surface p-3 text-sm" key={backup.id}>
              <div>
                <p className="font-mono text-xs">{backup.file}</p>
                <p className="text-xs text-panel-subtle">{new Date(backup.createdAt).toLocaleString()} · {Math.round(backup.sizeBytes / 1024)} KiB · {backup.kind}</p>
              </div>
              {canWrite && (
                <button className="button button-secondary" disabled={busy} onClick={() => setRestoring(backup)} type="button">Restore</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {leftovers.length > 0 && (
        <section className="grid gap-2 rounded-panel border border-panel-warn/40 bg-panel-surface p-4" aria-label="Folders moved aside by restores">
          <h2 className="text-sm font-extrabold">Folders moved aside by earlier restores</h2>
          <p className="text-xs text-panel-muted">Nothing here is removed automatically. Remove a folder only when you no longer need it.</p>
          {leftovers.map((name) => (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs" key={name}>
              <span className="font-mono">{name}</span>
              {canWrite && <button className="button button-danger" onClick={() => setRemoving(name)} type="button">Remove</button>}
            </div>
          ))}
        </section>
      )}
      {restoring !== null && (
        <DestructiveActionDialog
          busy={busy}
          consequences={["The current server folder is renamed aside, not deleted, and the archive takes its place.", "The server must be stopped."]}
          onCancel={() => setRestoring(null)}
          onConfirm={() => void run(() => client.post(`${base}/backups/${restoring.id}/restore`, restoredSchema, {}), "The backup is restored.")}
          targetName={restoring.file}
          verb="restore"
        />
      )}
      {clearing && (
        <DestructiveActionDialog
          busy={busy}
          consequences={["Only the record is removed. No folder is changed or deleted, and a restore of this server is allowed again."]}
          onCancel={() => setClearing(false)}
          onConfirm={() => void run(() => client.post(`${base}/backups/restore-record/clear`, restoreRecordClearedSchema, { confirm: serverName }), "The restore record is cleared.")}
          targetName={serverName}
          verb="clear"
        />
      )}
      {removing !== null && (
        <DestructiveActionDialog
          busy={busy}
          consequences={["This folder cannot be recovered once removed."]}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void run(() => client.delete(`${base}/leftovers/${encodeURIComponent(removing)}`, removedSchema, { confirm: removing }), "The folder is removed.")}
          targetName={removing}
          verb="remove"
        />
      )}
    </section>
  );
}
