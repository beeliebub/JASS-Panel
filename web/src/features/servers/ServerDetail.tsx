// One server: its state, the power controls, and a tab for each part of it. The page follows the server's state and any countdown through
// the events stream, so a change made elsewhere, or by a schedule, shows here without a reload. The console tab streams the live log; the
// other tabs load their own data. Write controls appear only for the capabilities the daemon reports the signed-in person holds here.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { cancelledSchema, deliveredSchema, historySchema, powerResponseSchema, SCHEDULE_COUNTDOWN_SECONDS, serverResponseSchema, stateEventSchema, streamedLineSchema, type ConsoleLine, type PowerOutcome, type ServerAction, type ServerView } from "@shared/servers.js";
import { PanelApiError, type ApiClient } from "../../api/client";
import { DestructiveActionDialog } from "../../components/DestructiveActionDialog";
import { StateMessage } from "../../components/StateMessage";
import { BackupsTab } from "./BackupsTab";
import { FilesTab } from "./FilesTab";
import { LogLine } from "./LogLine";
import { PlayersTab } from "./PlayersTab";
import { PluginsTab } from "./PluginsTab";
import { SchedulesTab } from "./SchedulesTab";
import { stateLabel, stateTone, toneClass } from "./state";
import { VirtualLogList } from "./VirtualLogList";

const MAX_LINES = 1000;
const MAX_COMMAND_BYTES = 1024;
const TABS = ["console", "files", "backups", "schedules", "plugins", "players"] as const;
type Tab = (typeof TABS)[number];
// The warning choices offered before a stop or restart, in seconds. The no-warning choice is the dialog's first option.
const COUNTDOWN_CHOICES = SCHEDULE_COUNTDOWN_SECONDS.filter((seconds) => seconds > 0);
const autostartSchema = z.strictObject({ autostart: z.boolean() });

const TAB_LABELS: Record<Tab, string> = { console: "Console", files: "Files", backups: "Backups", schedules: "Schedules", plugins: "Plugins", players: "Players" };

/**
 * What the person is told before a stop or restart, with the warning added when they chose one. A server that has not finished loading may
 * not have its world loaded yet, so it may not be saved before it stops; that is said in place of the usual promise.
 */
function powerConsequences(action: ServerAction, countdown: number, loading: boolean): string[] {
  if (loading) return ["The server has not finished loading, so the world may not be saved before it stops."];
  const base = action === "stop" ? "Players are disconnected and the world is saved first." : "Players are disconnected while the server restarts.";
  if (countdown === 0) return [base];
  return [base, `Players see a warning in chat for ${countdown} seconds before the server ${action === "stop" ? "stops" : "restarts"}.`];
}

/** What the page says while a power request runs. A start can take minutes, because the server reports that it has loaded only then. */
function workingNotice(action: ServerAction, countdown: number): string {
  if (countdown > 0) return `Warning players before the server ${action === "stop" ? "stops" : "restarts"}.`;
  if (action === "start") return "Starting the server. Commands are accepted once it has finished loading.";
  return action === "stop" ? "Stopping the server." : "Restarting the server.";
}

/** How a power request ended, when the ending is more than done. */
function outcomeNotice(outcome: PowerOutcome): string | null {
  if (outcome === "cancelled") return "The countdown was cancelled. Nothing was stopped.";
  if (outcome === "unknown") return "The panel could not confirm that the server started. It may still come up; its state is shown below, and it is not safe to start it again until that state is clear.";
  if (outcome === "not_loaded") return "The server did not report that it had finished loading within five minutes, as far as the panel can tell. It has been left running.";
  return null;
}

export function ServerDetail({ basePath, client, id, onBack }: { readonly basePath: string; readonly client: ApiClient; readonly id: string; readonly onBack: () => void }) {
  const [server, setServer] = useState<ServerView | null>(null);
  const [lines, setLines] = useState<readonly ConsoleLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pending, setPending] = useState<ServerAction | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("console");
  const listRef = useRef<HTMLDivElement | null>(null);
  const bannerRef = useRef<HTMLElement | null>(null);
  const powerTicket = useRef(0);
  const path = `/api/v1/servers/${encodeURIComponent(id)}`;
  const hasCountdown = server !== null && server.countdown !== null;

  useEffect(() => {
    const controller = new AbortController();
    client
      .get(path, serverResponseSchema, controller.signal)
      .then((result) => setServer(result.server))
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof PanelApiError ? failure.message : "The server could not be loaded.");
      });
    client
      .get(`${path}/console`, historySchema, controller.signal)
      .then((result) => setLines(result.lines.slice(-MAX_LINES)))
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, path]);

  useEffect(() => {
    const source = new EventSource(`${basePath}${path}/console/stream`);
    source.addEventListener("line", (event) => {
      const message = event as MessageEvent<string>;
      let json: unknown;
      try {
        json = JSON.parse(message.data) as unknown;
      } catch {
        return;
      }
      const parsed = streamedLineSchema.safeParse(json);
      if (!parsed.success) return;
      const { text, cut, kind, player, time } = parsed.data;
      const line: ConsoleLine = { id: message.lastEventId, text, cut, kind, player, time };
      setLines((current) => [...current, line].slice(-MAX_LINES));
    });
    // The daemon drops the oldest lines of a reader that falls far behind, and says how many, so the gap is not silent.
    source.addEventListener("lagged", (event) => {
      let json: unknown;
      try {
        json = JSON.parse((event as MessageEvent<string>).data) as unknown;
      } catch {
        return;
      }
      if (typeof json === "object" && json !== null && "lost" in json && typeof json.lost === "number") {
        setNotice(`${json.lost} lines were not shown, because this page fell behind. The server's log has them.`);
      }
    });
    return () => source.close();
  }, [basePath, path]);

  // The events stream carries this server's state and countdown whenever either changes, so the page does not need a reload.
  useEffect(() => {
    const source = new EventSource(`${basePath}/api/v1/events`);
    source.addEventListener("state", (event) => {
      // A state event that cannot be read is not kept as this server's state: the page shows it as unknown until a readable one arrives.
      const unreadable = () => setServer((current) => (current === null ? current : { ...current, state: { known: false as const, reason: "The panel could not read this server's state." } }));
      let json: unknown;
      try {
        json = JSON.parse((event as MessageEvent<string>).data) as unknown;
      } catch {
        unreadable();
        return;
      }
      const parsed = stateEventSchema.safeParse(json);
      if (!parsed.success) {
        unreadable();
        return;
      }
      if (parsed.data.id !== id) return;
      const { state, countdown: live } = parsed.data;
      setServer((current) => (current === null ? current : { ...current, state, countdown: live }));
    });
    return () => source.close();
  }, [basePath, id]);

  // A countdown that begins while the page is open takes focus, because the control that began it may just have closed.
  useEffect(() => {
    if (hasCountdown) bannerRef.current?.focus();
    else setCancelRequested(false);
  }, [hasCountdown]);

  useEffect(() => {
    const element = listRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [lines.length]);

  async function power(action: ServerAction, countdownSeconds: number): Promise<void> {
    // Requests can overlap, since a stop may be sent while a start is still loading. Only the newest request sets the page when it ends, so
    // an earlier reply cannot re-enable a button, or show an error, while the newer request is still running.
    powerTicket.current += 1;
    const ticket = powerTicket.current;
    const newest = (): boolean => ticket === powerTicket.current;
    setBusy(true);
    setError(null);
    setNotice(workingNotice(action, countdownSeconds));
    try {
      const response = await client.post(`${path}/power`, powerResponseSchema, { action, countdownSeconds });
      if (!newest()) return;
      setServer((current) => (current === null ? current : { ...current, state: response.state }));
      // An error from a cancel that failed while this request was running is no longer the page's news once the request has answered.
      setError(null);
      setNotice(outcomeNotice(response.outcome));
    } catch (failure) {
      if (!newest()) return;
      setNotice(null);
      setError(failure instanceof PanelApiError ? failure.message : "The server did not respond to the request.");
    } finally {
      if (newest()) setBusy(false);
    }
  }

  async function cancelCountdown(countdownId: string): Promise<void> {
    setError(null);
    setCancelRequested(true);
    try {
      await client.post(`${path}/power/cancel`, cancelledSchema, { countdownId });
      setNotice("Cancelling the countdown. The players are told once it is cancelled.");
    } catch (failure) {
      setCancelRequested(false);
      setError(failure instanceof PanelApiError ? failure.message : "The countdown could not be cancelled.");
    }
  }

  // The choice is the unit's enablement, so the page shows what the panel stored after systemd made the change, not what was asked for.
  async function setAutostart(enabled: boolean): Promise<void> {
    setError(null);
    setAutostartBusy(true);
    try {
      const result = await client.put(`${path}/autostart`, autostartSchema, { enabled });
      setServer((current) => (current === null ? current : { ...current, autostart: result.autostart }));
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The setting was not saved.");
    } finally {
      setAutostartBusy(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSendError(null);
    if (command.length === 0 || sending) return;
    if (new TextEncoder().encode(command).length > MAX_COMMAND_BYTES) {
      setSendError("That command is longer than the panel accepts.");
      return;
    }
    setSending(true);
    try {
      await client.post(`${path}/console`, deliveredSchema, { line: command });
      setCommand("");
    } catch (failure) {
      setSendError(failure instanceof PanelApiError ? failure.message : "The command was not sent.");
    } finally {
      setSending(false);
    }
  }

  if (error !== null && server === null) {
    return (
      <main className="mx-auto max-w-[800px] px-6 pt-10">
        <StateMessage title="The server could not be shown" tone="error" action={<button className="button button-secondary" onClick={onBack} type="button">Back to servers</button>}>
          {error}
        </StateMessage>
      </main>
    );
  }
  if (server === null) return <main className="mx-auto max-w-[800px] px-6 pt-10"><StateMessage title="Loading the server" /></main>;

  const caps = new Set(server.capabilities);
  const running = server.state.known && (server.state.activeState === "active" || server.state.activeState === "activating");
  // A server that is starting, or running but has not printed Done, takes no console input yet, and nobody is on it to warn.
  const loading = server.state.known && (server.state.activeState === "activating" || (server.state.activeState === "active" && !server.state.loaded));
  const effectiveCountdown = loading ? 0 : countdown;
  // A constant, so the cancel handler below keeps the countdown it was shown rather than whatever the page holds when it runs.
  const liveCountdown = server.countdown;
  return (
    <main className="mx-auto grid max-w-[1000px] gap-5 px-6 pb-12 pt-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <button className="text-xs text-panel-subtle hover:underline" onClick={onBack} type="button">All servers</button>
          <h1 className="text-xl font-extrabold">{server.displayName}</h1>
          <p className="text-xs text-panel-subtle">{server.id} · {server.directory}</p>
          <p className="text-xs text-panel-subtle">
            Starts with the machine: {server.autostart ? "yes, at boot once lingering is on" : "no"}
            {caps.has("settings") && (
              <>
                {" · "}
                <button className="underline hover:no-underline" disabled={autostartBusy} onClick={() => void setAutostart(!server.autostart)} type="button">
                  {server.autostart ? "Stop starting it with the machine" : "Start it with the machine"}
                </button>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-sm font-bold ${toneClass(stateTone(server.state))}`}>{stateLabel(server.state)}</span>
          {caps.has("power") && !running && <button className="button button-primary" disabled={busy} onClick={() => void power("start", 0)} type="button">Start</button>}
          {caps.has("power") && running && !loading && <button className="button button-secondary" disabled={busy} onClick={() => setPending("restart")} type="button">Restart</button>}
          {/* A stop may end a start that is still loading, so it stays available while the start's request is open. */}
          {caps.has("power") && running && <button className="button button-danger" disabled={busy && !loading} onClick={() => setPending("stop")} type="button">Stop</button>}
        </div>
      </div>
      {error !== null && <StateMessage title="Something did not work" tone="error">{error}</StateMessage>}
      <p aria-live="polite" className="text-sm text-panel-muted empty:hidden" role="status">{notice}</p>
      {liveCountdown !== null && (
        <section aria-labelledby="countdown-heading" className="grid gap-2 rounded-panel border border-panel-warn/40 bg-panel-surface p-4" ref={bannerRef} tabIndex={-1}>
          <h2 className="text-sm font-extrabold" id="countdown-heading">A countdown is running</h2>
          <p className="text-sm">
            Players are being warned before the server {liveCountdown.action === "stop" ? "stops" : "restarts"}
            {liveCountdown.scheduled ? ", because a schedule asked for it" : ""}. {liveCountdown.warningsSent} of {liveCountdown.warningsDue} warnings have been sent.
          </p>
          {liveCountdown.cancellable && (
            <div>
              <button className="button button-secondary" disabled={cancelRequested} onClick={() => void cancelCountdown(liveCountdown.id)} type="button">Cancel countdown</button>
            </div>
          )}
        </section>
      )}
      {server.unitEdited && <StateMessage title="The unit file was edited by hand" tone="warning">The panel shows the server but will not overwrite that file.</StateMessage>}
      {server.lastEnd !== null && <p className="text-xs text-panel-subtle">Last run ended: {server.lastEnd.result} ({server.lastEnd.code}, {server.lastEnd.status})</p>}
      <nav aria-label="Server sections" className="flex flex-wrap gap-2 border-b border-panel-line pb-2">
        {TABS.map((name) => (
          <button aria-current={tab === name ? "page" : undefined} className={`rounded-panel px-3 py-1.5 text-sm font-bold ${tab === name ? "bg-panel-soft" : "text-panel-muted"}`} key={name} onClick={() => setTab(name)} type="button">
            {TAB_LABELS[name]}
          </button>
        ))}
      </nav>
      {tab === "console" && (
        <section aria-label="Console" className="grid gap-3 rounded-panel border border-panel-line bg-panel-surface p-4">
          {/* The virtual list is the only scrolling element here, and the ref belongs to it: a second scroller would take the scroll position. */}
          <div aria-live="polite" className="font-mono text-xs" role="log">
            <VirtualLogList
              getKey={(line) => line.id}
              itemSize={22}
              items={lines}
              label="Server console output"
              listRef={listRef}
              renderItem={(line) => (
                <div className="flex gap-2 whitespace-pre-wrap break-all" key={line.id}>
                  {line.time !== null && <span className="text-panel-subtle">{line.time}</span>}
                  <span className="text-panel-muted">{line.kind}</span>
                  <LogLine line={line.text} />
                </div>
              )}
            />
          </div>
          {caps.has("console.send") && (
            <form className="flex gap-2" onSubmit={(event) => void send(event)}>
              <label className="sr-only" htmlFor="console-command">Console command</label>
              <input
                autoComplete="off"
                className="min-w-0 flex-1 rounded-panel border border-panel-line bg-panel-soft px-3 py-2 font-mono text-sm"
                disabled={!running || loading || sending}
                id="console-command"
                onChange={(event) => setCommand(event.target.value)}
                placeholder={loading ? "The server is loading" : running ? "Type a command" : "Start the server to send commands"}
                value={command}
              />
              <button className="button button-secondary" disabled={!running || loading || sending || command.length === 0} type="submit">Send</button>
            </form>
          )}
          {sendError !== null && <p className="text-xs text-panel-danger" role="alert">{sendError}</p>}
        </section>
      )}
      {tab === "files" && <FilesTab canWrite={caps.has("files.write")} client={client} serverId={id} />}
      {tab === "backups" && <BackupsTab canWrite={caps.has("backups")} client={client} serverId={id} serverName={server.displayName} />}
      {tab === "schedules" && <SchedulesTab canWrite={caps.has("schedules")} client={client} serverId={id} />}
      {tab === "plugins" && <PluginsTab canWrite={caps.has("plugins")} client={client} serverId={id} />}
      {tab === "players" && <PlayersTab canPlayers={caps.has("players")} canWrite={caps.has("console.send")} client={client} serverId={id} />}
      {pending !== null && (
        <DestructiveActionDialog
          consequences={powerConsequences(pending, effectiveCountdown, loading)}
          onCancel={() => {
            setPending(null);
            setCountdown(0);
          }}
          onConfirm={() => {
            // The request runs on the page, where its progress and any cancel are shown, so the confirmation closes as it begins.
            setPending(null);
            setCountdown(0);
            void power(pending, effectiveCountdown);
          }}
          targetName={server.id}
          verb={pending}
        >
          {loading ? (
            <p className="mt-[19px] text-xs leading-[1.6] text-panel-muted">There is no one to warn while the server loads, so no countdown is offered. Stopping ends the wait for the server to finish loading, then stops it.</p>
          ) : (
            <>
              <label className="mb-2 mt-[19px] block text-xs font-extrabold text-panel-text" htmlFor="power-countdown">Warn players first</label>
              <select
                className="min-h-[46px] w-full rounded-lg border border-panel-line bg-panel-page px-3 text-panel-text"
                id="power-countdown"
                onChange={(event) => setCountdown(Number(event.currentTarget.value))}
                value={countdown}
              >
                <option value={0}>No warning: act now</option>
                {COUNTDOWN_CHOICES.map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
              </select>
              <p className="mt-2 text-xs leading-[1.6] text-panel-muted">
                Warnings are posted in chat. A countdown you start can be cancelled only by you, until the stop begins; a scheduled one can be cancelled by anyone holding power. If the panel restarts during it, the countdown is abandoned and the server keeps running.
              </p>
            </>
          )}
        </DestructiveActionDialog>
      )}
    </main>
  );
}
