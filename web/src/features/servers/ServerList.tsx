// The servers the signed-in person may view, kept current from the events stream. Power changes that could stop a running server
// ask for confirmation first.
import { useEffect, useState } from "react";
import { z } from "zod";
import { powerResponseSchema, serversListSchema, stateEventSchema, type ServerAction, type ServerView } from "@shared/servers.js";
import { PanelApiError, type ApiClient } from "../../api/client";
import { DestructiveActionDialog } from "../../components/DestructiveActionDialog";
import { StateMessage } from "../../components/StateMessage";
import { stateLabel, stateTone, toneClass } from "./state";

// The state shown for a server whose event could not be read. The last state it had may no longer be true, so it is not kept.
const UNREADABLE: ServerView["state"] = { known: false, reason: "The panel could not read this server's state." };
const namedEvent = z.object({ id: z.string() });

export function ServerList({ basePath, client, onOpen, onAdd }: { readonly basePath: string; readonly client: ApiClient; readonly onOpen: (id: string) => void; readonly onAdd: () => void }) {
  const [servers, setServers] = useState<readonly ServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ readonly server: ServerView; readonly action: ServerAction } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    client
      .get("/api/v1/servers", serversListSchema, controller.signal)
      .then((result) => setServers(result.servers))
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof PanelApiError ? failure.message : "The servers could not be loaded.");
      });
    return () => controller.abort();
  }, [client]);

  useEffect(() => {
    const source = new EventSource(`${basePath}/api/v1/events`);
    source.addEventListener("state", (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse((event as MessageEvent<string>).data) as unknown;
      } catch {
        // Without a readable event the panel cannot say which server it concerns, so none keeps the state it had.
        setServers((current) => current?.map((server) => ({ ...server, state: UNREADABLE })) ?? current);
        return;
      }
      const parsed = stateEventSchema.safeParse(raw);
      if (parsed.success) {
        setServers((current) => current?.map((server) => (server.id === parsed.data.id ? { ...server, state: parsed.data.state } : server)) ?? current);
        return;
      }
      // An event that does not name a server cannot be attributed, so no server keeps the state it had.
      const named = namedEvent.safeParse(raw);
      setServers((current) => current?.map((server) => (!named.success || server.id === named.data.id ? { ...server, state: UNREADABLE } : server)) ?? current);
    });
    return () => source.close();
  }, [basePath]);

  async function act(server: ServerView, action: ServerAction): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await client.post(`/api/v1/servers/${encodeURIComponent(server.id)}/power`, powerResponseSchema, { action });
      setServers((current) => current?.map((row) => (row.id === server.id ? { ...row, state: response.state } : row)) ?? current);
      if (response.outcome === "unknown") setError("The panel could not confirm that the server started. Open its page before starting it again.");
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The server did not respond to the request.");
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <main className="mx-auto grid max-w-[1000px] gap-5 px-6 pb-12 pt-8">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-extrabold">Servers</h1>
        <button className="button button-primary" onClick={onAdd} type="button">Add a server</button>
      </header>
      {error !== null && <StateMessage title="Something did not work" tone="error">{error}</StateMessage>}
      {servers === null && error === null && <StateMessage title="Loading servers" />}
      {servers !== null && servers.length === 0 && (
        <StateMessage title="No servers yet">
          Add a server to start managing it from here, or ask an owner to share one with this account.
        </StateMessage>
      )}
      {servers !== null && servers.length > 0 && (
        <ul className="grid gap-3">
          {servers.map((server) => {
            const tone = stateTone(server.state);
            const running = server.state.known && (server.state.activeState === "active" || server.state.activeState === "activating");
            return (
              <li className="flex flex-wrap items-center justify-between gap-4 rounded-panel border border-panel-line bg-panel-surface p-4" key={server.id}>
                <div className="min-w-0">
                  <button className="text-left text-[15px] font-extrabold hover:underline" onClick={() => onOpen(server.id)} type="button">
                    {server.displayName}
                  </button>
                  <p className="text-xs text-panel-subtle">{server.id}</p>
                  {server.unitEdited && <p className="text-xs text-panel-warn">The unit file was edited by hand; the panel will not overwrite it.</p>}
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-bold ${toneClass(tone)}`}>{stateLabel(server.state)}</span>
                  {!running && (
                    <button className="button button-secondary" disabled={busy} onClick={() => void act(server, "start")} type="button">Start</button>
                  )}
                  {running && (
                    <>
                      <button className="button button-secondary" disabled={busy} onClick={() => setPending({ server, action: "restart" })} type="button">Restart</button>
                      <button className="button button-danger" disabled={busy} onClick={() => setPending({ server, action: "stop" })} type="button">Stop</button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {pending !== null && (
        <DestructiveActionDialog
          busy={busy}
          consequences={[
            pending.action === "stop" ? "Players are disconnected and the world is saved first." : "Players are disconnected while the server restarts.",
          ]}
          onCancel={() => setPending(null)}
          onConfirm={() => void act(pending.server, pending.action)}
          targetName={pending.server.id}
          verb={pending.action === "stop" ? "stop" : "restart"}
        />
      )}
    </main>
  );
}
