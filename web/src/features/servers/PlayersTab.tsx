// Who is on the server, as far as the log shows, and the few player actions and chat messages the panel can send. Every action needs
// the server to be running, and the daemon says so when it is not.
import { useEffect, useState, type FormEvent } from "react";
import { sentSchema } from "@shared/servers.js";
import { playersSchema } from "@shared/features.js";
import { PanelApiError, type ApiClient } from "../../api/client";
import { StateMessage } from "../../components/StateMessage";

const field = "rounded-panel border border-panel-line bg-panel-soft px-3 py-2 text-sm";

export function PlayersTab({ client, serverId, canWrite, canPlayers }: { readonly client: ApiClient; readonly serverId: string; readonly canWrite: boolean; readonly canPlayers: boolean }) {
  const base = `/api/v1/servers/${encodeURIComponent(serverId)}`;
  const [players, setPlayers] = useState<readonly string[] | null>(null);
  const [name, setName] = useState("");
  const [chat, setChat] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    client
      .get(`${base}/players`, playersSchema, controller.signal)
      .then((result) => setPlayers(result.players))
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof PanelApiError ? failure.message : "The player list could not be loaded.");
      });
    return () => controller.abort();
  }, [client, base, version]);

  async function act(path: string, body: unknown, done: string): Promise<void> {
    setError(null);
    setMessage(null);
    try {
      await client.post(path, sentSchema, body);
      setMessage(done);
      setVersion((count) => count + 1);
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The command was not sent.");
    }
  }

  async function sendChat(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await act(`${base}/chat`, { text: chat }, "The message was sent.");
    setChat("");
  }

  return (
    <section aria-label="Players" className="grid gap-5">
      <div>
        <h2 className="text-sm font-extrabold">Online now</h2>
        <p className="text-xs text-panel-subtle">Approximate: the list is worked out from the log since the server last started.</p>
        {players === null && error === null && <StateMessage title="Reading the log" />}
        {players !== null && players.length === 0 && <p className="text-sm text-panel-muted">Nobody is online as far as the log shows.</p>}
        {players !== null && players.length > 0 && <ul className="mt-2 grid gap-1 font-mono text-sm">{players.map((player) => <li key={player}>{player}</li>)}</ul>}
      </div>
      {error !== null && <StateMessage title="Something did not work" tone="error">{error}</StateMessage>}
      {message !== null && <p className="text-sm text-panel-good" role="status">{message}</p>}
      {canWrite && (
        <form className="grid gap-2" onSubmit={(event) => void sendChat(event)}>
          <label className="grid gap-1 text-sm font-bold" htmlFor="chat-text">
            Message to everyone
            <input className={field} id="chat-text" maxLength={256} onChange={(event) => setChat(event.target.value)} value={chat} />
          </label>
          <div className="flex justify-end">
            <button className="button button-secondary" disabled={chat.length === 0} type="submit">Send message</button>
          </div>
        </form>
      )}
      {canPlayers && (
        <form className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]" onSubmit={(event) => event.preventDefault()}>
          <label className="grid gap-1 text-sm font-bold" htmlFor="player-name">
            Player name
            <input className={field} id="player-name" onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <button className="button button-secondary self-end" disabled={name.length === 0} onClick={() => void act(`${base}/players/kick`, { name }, `${name} was removed from the server.`)} type="button">Kick</button>
          <button className="button button-secondary self-end" disabled={name.length === 0} onClick={() => void act(`${base}/players/whitelist-add`, { name }, `${name} was added to the whitelist.`)} type="button">Whitelist</button>
          <button className="button button-secondary self-end" disabled={name.length === 0} onClick={() => void act(`${base}/players/whitelist-remove`, { name }, `${name} was taken off the whitelist.`)} type="button">Unwhitelist</button>
        </form>
      )}
    </section>
  );
}
