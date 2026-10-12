// Scheduled actions for one server. Each one runs as a fresh check of its creator, so a schedule stops working as soon as its creator
// loses the capability or the panel access.
import { useEffect, useState, type FormEvent } from "react";
import { schedulesSchema, scheduleSchema, type Schedule } from "@shared/features.js";
import { schedulePowerPayloadSchema, SCHEDULE_COUNTDOWN_SECONDS } from "@shared/servers.js";
import { z } from "zod";
import { PanelApiError, type ApiClient } from "../../api/client";
import { StateMessage } from "../../components/StateMessage";

const KINDS = ["start", "stop", "restart", "backup", "command"] as const;
const field = "rounded-panel border border-panel-line bg-panel-soft px-3 py-2 text-sm";
const createdSchema = z.strictObject({ schedule: scheduleSchema });
const removedSchema = z.strictObject({ removed: z.number() });

/** What a stop or restart schedule does about its players, read from its payload. Other kinds have no warning. */
function warningText(item: Schedule): string | null {
  if (item.kind !== "stop" && item.kind !== "restart") return null;
  if (item.payload === null) return "No warning";
  try {
    const parsed = schedulePowerPayloadSchema.safeParse(JSON.parse(item.payload) as unknown);
    if (!parsed.success) return "The stored warning is not valid, so this schedule fails when it fires";
    return parsed.data.countdownSeconds === 0 ? "No warning" : `Warns players ${parsed.data.countdownSeconds} seconds first`;
  } catch {
    return "The stored warning is not valid, so this schedule fails when it fires";
  }
}

export function SchedulesTab({ client, serverId, canWrite }: { readonly client: ApiClient; readonly serverId: string; readonly canWrite: boolean }) {
  const [schedules, setSchedules] = useState<readonly Schedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [kind, setKind] = useState<(typeof KINDS)[number]>("restart");
  const [cron, setCron] = useState("0 4 * * *");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [payload, setPayload] = useState("");
  const [countdownSeconds, setCountdownSeconds] = useState<number>(0);
  // A second submit while the first is in flight would add the same schedule twice, and both would then fire.
  const [saving, setSaving] = useState(false);
  const base = `/api/v1/servers/${encodeURIComponent(serverId)}/schedules`;

  useEffect(() => {
    const controller = new AbortController();
    client
      .get(base, schedulesSchema, controller.signal)
      .then((result) => setSchedules(result.schedules))
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof PanelApiError ? failure.message : "The schedules could not be loaded.");
      });
    return () => controller.abort();
  }, [client, base, version]);

  async function add(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (saving) return;
    setSaving(true);
    try {
      const warning = kind === "stop" || kind === "restart" ? { countdownSeconds } : {};
      await client.post(base, createdSchema, { kind, cron, timezone, ...(kind === "command" ? { payload } : {}), ...warning });
      setVersion((count) => count + 1);
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The schedule was not added.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number): Promise<void> {
    setError(null);
    try {
      await client.delete(`${base}/${id}`, removedSchema, {});
      setVersion((count) => count + 1);
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The schedule was not removed.");
    }
  }

  return (
    <section aria-label="Schedules" className="grid gap-4">
      {error !== null && <StateMessage title="Something did not work" tone="error">{error}</StateMessage>}
      {schedules === null && error === null && <StateMessage title="Loading schedules" />}
      {schedules !== null && schedules.length === 0 && <StateMessage title="No schedules">Add one below.</StateMessage>}
      {schedules !== null && schedules.length > 0 && (
        <ul className="grid gap-2 text-sm">
          {schedules.map((item) => (
            <li className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-panel-line bg-panel-surface p-3" key={item.id}>
              <div>
                <p className="font-bold">{item.kind}{item.kind === "command" && item.payload !== null ? `: ${item.payload}` : ""}</p>
                {warningText(item) !== null && <p className="text-xs text-panel-subtle">{warningText(item)}</p>}
                <p className="font-mono text-xs text-panel-subtle">{item.cron} ({item.timezone})</p>
                <p className="text-xs text-panel-subtle">Last run: {item.lastRunAt ?? "never"}{item.lastResult !== null ? ` · ${item.lastResult}` : ""}</p>
              </div>
              {canWrite && <button className="button button-secondary" onClick={() => void remove(item.id)} type="button">Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form className="grid gap-3 rounded-panel border border-panel-line bg-panel-surface p-4 sm:grid-cols-2" onSubmit={(event) => void add(event)}>
          <label className="grid gap-1 text-sm font-bold" htmlFor="schedule-kind">
            Action
            <select className={field} id="schedule-kind" onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])} value={kind}>
              {KINDS.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-bold" htmlFor="schedule-cron">
            Time (cron: minute hour day month weekday)
            <input className={field} id="schedule-cron" onChange={(event) => setCron(event.target.value)} value={cron} />
          </label>
          <label className="grid gap-1 text-sm font-bold" htmlFor="schedule-zone">
            Time zone
            <input className={field} id="schedule-zone" onChange={(event) => setTimezone(event.target.value)} value={timezone} />
          </label>
          {(kind === "stop" || kind === "restart") && (
            <label className="grid gap-1 text-sm font-bold" htmlFor="schedule-warning">
              Warn players first
              <select className={field} id="schedule-warning" onChange={(event) => setCountdownSeconds(Number(event.target.value))} value={countdownSeconds}>
                {SCHEDULE_COUNTDOWN_SECONDS.map((seconds) => (
                  <option key={seconds} value={seconds}>{seconds === 0 ? "No warning: act at once" : `${seconds} seconds`}</option>
                ))}
              </select>
            </label>
          )}
          {kind === "command" && (
            <label className="grid gap-1 text-sm font-bold" htmlFor="schedule-payload">
              Console command (runs with your own console access)
              <input className={field} id="schedule-payload" onChange={(event) => setPayload(event.target.value)} value={payload} />
            </label>
          )}
          <div className="flex items-end sm:col-span-2">
            <button className="button button-primary" disabled={saving} type="submit">Add schedule</button>
          </div>
        </form>
      )}
    </section>
  );
}
