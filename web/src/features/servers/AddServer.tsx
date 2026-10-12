// The form for adding a server. A Paper preset builds the start command from a jar and memory; a custom command is an argv, one
// argument per line, and is never joined into a shell string. The daemon validates everything again and reports problems by path.
import { useState, type FormEvent } from "react";
import { serverResponseSchema, type AddServerBody } from "@shared/servers.js";
import { PanelApiError, type ApiClient } from "../../api/client";
import { StateMessage } from "../../components/StateMessage";

type Mode = "paper" | "custom";

const fieldClass = "w-full rounded-panel border border-panel-line bg-panel-soft px-3 py-2 text-sm";

function splitFlags(value: string): string[] {
  return value.split(/\s+/).filter((flag) => flag.length > 0);
}

export function AddServer({ client, onCancel, onCreated }: { readonly client: ApiClient; readonly onCancel: () => void; readonly onCreated: (id: string) => void }) {
  const [mode, setMode] = useState<Mode>("paper");
  const [id, setId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [directory, setDirectory] = useState("");
  const [javaPath, setJavaPath] = useState("/usr/bin/java");
  const [minMb, setMinMb] = useState("1024");
  const [maxMb, setMaxMb] = useState("2048");
  const [jarFile, setJarFile] = useState("paper.jar");
  const [flags, setFlags] = useState("");
  const [argv, setArgv] = useState("");
  const [logPath, setLogPath] = useState("logs/latest.log");
  const [autostart, setAutostart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const command: AddServerBody["command"] =
      mode === "paper"
        ? { kind: "paper", javaPath, minMb: Number(minMb), maxMb: Number(maxMb), jarFile, extraFlags: splitFlags(flags) }
        : { kind: "custom", argv: argv.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.length > 0) };
    const body: AddServerBody = { id, displayName, directory, command, logPath, autostart };
    setBusy(true);
    try {
      const result = await client.post("/api/v1/servers", serverResponseSchema, body);
      onCreated(result.server.id);
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The server was not added.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto grid max-w-[720px] gap-6 px-6 pb-12 pt-8">
      <h1 className="text-xl font-extrabold">Add a server</h1>
      <p className="text-sm text-panel-muted">
        The directory must already exist and must not be inside the panel's data directory. The panel does not change anything in it.
      </p>
      {error !== null && <StateMessage title="The server was not added" tone="error">{error}</StateMessage>}
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <label className="grid gap-1 text-sm font-bold" htmlFor="server-id">
          Id
          <input className={fieldClass} id="server-id" onChange={(event) => setId(event.target.value)} required value={id} />
          <span className="text-xs font-normal text-panel-subtle">Lowercase letters, digits and dashes. It names the unit files and cannot be changed.</span>
        </label>
        <label className="grid gap-1 text-sm font-bold" htmlFor="server-name">
          Display name
          <input className={fieldClass} id="server-name" maxLength={64} onChange={(event) => setDisplayName(event.target.value)} required value={displayName} />
        </label>
        <label className="grid gap-1 text-sm font-bold" htmlFor="server-directory">
          Server directory
          <input className={fieldClass} id="server-directory" onChange={(event) => setDirectory(event.target.value)} placeholder="/absolute/path/to/server" required value={directory} />
        </label>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-bold">Start command</legend>
          <label className="flex items-center gap-2 text-sm">
            <input checked={mode === "paper"} name="mode" onChange={() => setMode("paper")} type="radio" /> Paper preset
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input checked={mode === "custom"} name="mode" onChange={() => setMode("custom")} type="radio" /> Custom command
          </label>
        </fieldset>
        {mode === "paper" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm font-bold" htmlFor="java-path">
              Java program
              <input className={fieldClass} id="java-path" onChange={(event) => setJavaPath(event.target.value)} value={javaPath} />
            </label>
            <label className="grid gap-1 text-sm font-bold" htmlFor="jar-file">
              Jar file
              <input className={fieldClass} id="jar-file" onChange={(event) => setJarFile(event.target.value)} value={jarFile} />
            </label>
            <label className="grid gap-1 text-sm font-bold" htmlFor="min-mb">
              Minimum memory (MB)
              <input className={fieldClass} id="min-mb" inputMode="numeric" onChange={(event) => setMinMb(event.target.value)} value={minMb} />
            </label>
            <label className="grid gap-1 text-sm font-bold" htmlFor="max-mb">
              Maximum memory (MB)
              <input className={fieldClass} id="max-mb" inputMode="numeric" onChange={(event) => setMaxMb(event.target.value)} value={maxMb} />
            </label>
            <label className="grid gap-1 text-sm font-bold sm:col-span-2" htmlFor="extra-flags">
              Extra Java flags
              <input className={fieldClass} id="extra-flags" onChange={(event) => setFlags(event.target.value)} placeholder="-XX:+UseG1GC" value={flags} />
            </label>
          </div>
        ) : (
          <label className="grid gap-1 text-sm font-bold" htmlFor="custom-argv">
            Command, one argument per line
            <textarea className={`${fieldClass} font-mono`} id="custom-argv" onChange={(event) => setArgv(event.target.value)} rows={5} value={argv} />
            <span className="text-xs font-normal text-panel-subtle">The first line must be the absolute path of the program.</span>
          </label>
        )}
        <label className="grid gap-1 text-sm font-bold" htmlFor="log-path">
          Log file, relative to the directory
          <input className={fieldClass} id="log-path" onChange={(event) => setLogPath(event.target.value)} value={logPath} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input checked={autostart} onChange={(event) => setAutostart(event.target.checked)} type="checkbox" /> Start this server when the machine starts
        </label>
        <p className="text-xs text-panel-subtle">Ticked, the server starts with the machine: at boot, once lingering is on. Unticked, you start it from the panel. The choice can be changed later, on the server's page, by a person who holds that server's settings capability.</p>
        <div className="flex items-center justify-end gap-3">
          <button className="button button-secondary" onClick={onCancel} type="button">Cancel</button>
          <button className="button button-primary" disabled={busy} type="submit">Add server</button>
        </div>
      </form>
    </main>
  );
}
