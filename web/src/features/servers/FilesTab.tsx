// Browses the server directory and edits text files. The daemon's file jail decides what is reachable; the page shows what it returns.
import { useEffect, useRef, useState } from "react";
import { fileTextSchema, listingSchema, UPLOAD_MAX_BYTES, type FileText } from "@shared/features.js";
import { z } from "zod";
import { PanelApiError, type ApiClient } from "../../api/client";
import { StateMessage } from "../../components/StateMessage";
import { CodeEditor } from "./CodeEditor";

const savedSchema = z.strictObject({ saved: z.literal(true) });
type Entry = { readonly name: string; readonly kind: "file" | "directory" | "other"; readonly size: number };

export function FilesTab({ client, serverId, canWrite }: { readonly client: ApiClient; readonly serverId: string; readonly canWrite: boolean }) {
  const [folder, setFolder] = useState("");
  const [entries, setEntries] = useState<readonly Entry[] | null>(null);
  const [open, setOpen] = useState<FileText | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [listingVersion, setListingVersion] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const base = `/api/v1/servers/${encodeURIComponent(serverId)}`;

  useEffect(() => {
    const controller = new AbortController();
    client
      .get(`${base}/files?path=${encodeURIComponent(folder)}`, listingSchema, controller.signal)
      .then((result) => {
        setError(null);
        setEntries(result.entries);
        setTruncated(result.truncated);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof PanelApiError ? failure.message : "The folder could not be listed.");
      });
    return () => controller.abort();
  }, [client, base, folder, listingVersion]);

  async function openFile(name: string): Promise<void> {
    const path = folder.length === 0 ? name : `${folder}/${name}`;
    setError(null);
    setMessage(null);
    try {
      const file = await client.get(`${base}/file?path=${encodeURIComponent(path)}`, fileTextSchema);
      setOpen(file);
      setDraft(file.text);
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The file could not be opened.");
    }
  }

  async function upload(file: File): Promise<void> {
    setError(null);
    setMessage(null);
    const limitMb = UPLOAD_MAX_BYTES / (1024 * 1024);
    if (file.size > UPLOAD_MAX_BYTES) {
      setError(`${file.name} is larger than ${limitMb} MiB, the most one upload can send.`);
      return;
    }
    // A listing cut short at its cap cannot say whether the name exists, so it is not claimed as a replacement.
    const replacing = !truncated && (entries?.some((entry) => entry.kind === "file" && entry.name === file.name) ?? false);
    const path = folder.length === 0 ? file.name : `${folder}/${file.name}`;
    setUploading(true);
    try {
      await client.upload(`${base}/upload?path=${encodeURIComponent(path)}`, savedSchema, file);
      setMessage(replacing ? `Replaced ${file.name}. The previous version is kept.` : `Uploaded ${file.name}.`);
      setListingVersion((version) => version + 1);
    } catch (failure) {
      // A lost response may follow an upload that reached the server, so the folder is listed again to show what is there now.
      setListingVersion((version) => version + 1);
      if (failure instanceof PanelApiError && failure.code === "network_error") {
        // Shown in the status line: the listing reload that follows clears the error line.
        setMessage(`${failure.message} The upload may have finished, so check whether ${file.name} arrived before uploading it again.`);
      } else {
        setError(failure instanceof PanelApiError ? failure.message : "The file was not uploaded.");
      }
    } finally {
      setUploading(false);
    }
  }

  async function save(): Promise<void> {
    if (open === null) return;
    setError(null);
    setMessage(null);
    try {
      await client.put(`${base}/file`, savedSchema, { path: open.path, content: draft });
      setMessage("Saved. The previous version is kept.");
      setOpen({ ...open, text: draft });
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The file was not saved.");
    }
  }

  return (
    <section aria-label="Files" className="grid gap-4">
      <nav aria-label="Folder" className="flex flex-wrap items-center gap-2 text-xs">
        <button className="button button-secondary" onClick={() => setFolder("")} type="button">Server folder</button>
        {folder.length > 0 && (
          <button className="button button-secondary" onClick={() => setFolder(folder.split("/").slice(0, -1).join("/"))} type="button">Up</button>
        )}
        {canWrite && (
          <>
            <button className="button button-secondary" disabled={uploading} onClick={() => uploadInput.current?.click()} type="button">{uploading ? "Uploading…" : "Upload file"}</button>
            <input
              accept="*/*"
              aria-label="Choose a file to upload to this folder"
              className="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file !== undefined) void upload(file);
              }}
              ref={uploadInput}
              type="file"
            />
          </>
        )}
        <span className="font-mono text-panel-subtle">/{folder}</span>
      </nav>
      {error !== null && <StateMessage title="Something did not work" tone="error">{error}</StateMessage>}
      {message !== null && <p className="text-sm text-panel-good" role="status">{message}</p>}
      {entries === null && error === null && <StateMessage title="Listing the folder" />}
      {truncated && <p className="text-xs text-panel-subtle">Only the first 2,000 entries are listed.</p>}
      {entries !== null && (
        <ul className="grid gap-1 text-sm">
          {entries.map((entry) => (
            <li key={entry.name}>
              {entry.kind === "directory" ? (
                <button className="font-mono hover:underline" onClick={() => setFolder(folder.length === 0 ? entry.name : `${folder}/${entry.name}`)} type="button">{entry.name}/</button>
              ) : (
                <button className="font-mono hover:underline" onClick={() => void openFile(entry.name)} type="button">{entry.name}</button>
              )}
              {entry.kind === "file" && <span className="ml-2 text-xs text-panel-subtle">{entry.size} bytes</span>}
            </li>
          ))}
        </ul>
      )}
      {open !== null && (
        <div className="grid gap-3">
          <p className="font-mono text-xs text-panel-subtle">{open.path}{open.truncated ? " (the first part only; too large to edit here)" : ""}</p>
          <CodeEditor ariaLabel={`Edit ${open.path}`} filename={open.path} onChange={setDraft} readOnly={!canWrite || open.truncated} value={draft} />
          {canWrite && !open.truncated && (
            <div className="flex justify-end">
              <button className="button button-primary" onClick={() => void save()} type="button">Save file</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
