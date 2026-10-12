// Panel-wide settings: the alert webhook (write-only: the page never shows it again) and how many backups to keep.
import { useEffect, useState, type FormEvent } from "react";
import { settingsSchema } from "@shared/features.js";
import { z } from "zod";
import { PanelApiError, type ApiClient } from "../../api/client";
import { StateMessage } from "../../components/StateMessage";

const field = "w-full rounded-panel border border-panel-line bg-panel-soft px-3 py-2 text-sm";
const webhookReply = z.strictObject({ webhookConfigured: z.boolean() });
const retentionReply = z.strictObject({ backupRetention: z.number() });
// Posting to Discord is not connected yet, so the webhook form stays out of the screen. The code and any saved address remain.
const SHOW_DISCORD_ALERTS: boolean = false;

export function SettingsScreen({ client }: { readonly client: ApiClient }) {
  const [settings, setSettings] = useState<z.infer<typeof settingsSchema> | null>(null);
  const [webhook, setWebhook] = useState("");
  const [keep, setKeep] = useState("7");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client
      .get("/api/v1/settings", settingsSchema, controller.signal)
      .then((result) => {
        setSettings(result);
        setKeep(String(result.backupRetention));
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof PanelApiError ? failure.message : "The settings could not be loaded.");
      });
    return () => controller.abort();
  }, [client]);

  async function saveWebhook(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const result = await client.put("/api/v1/settings/webhook", webhookReply, { url: webhook.length === 0 ? null : webhook });
      setSettings((current) => (current === null ? current : { ...current, webhookConfigured: result.webhookConfigured }));
      setWebhook("");
      setMessage(result.webhookConfigured ? "The alert webhook is saved." : "The alert webhook is removed.");
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The webhook was not saved.");
    }
  }

  async function saveRetention(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      const result = await client.put("/api/v1/settings/backup-retention", retentionReply, { keep: Number(keep) });
      setMessage(`Keeping the newest ${result.backupRetention} backups per server.`);
    } catch (failure) {
      setError(failure instanceof PanelApiError ? failure.message : "The setting was not saved.");
    }
  }

  return (
    <main className="mx-auto grid max-w-[720px] gap-6 px-6 pb-12 pt-8">
      <h1 className="text-xl font-extrabold">Settings</h1>
      {error !== null && <StateMessage title="Something did not work" tone="error">{error}</StateMessage>}
      {message !== null && <p className="text-sm text-panel-good" role="status">{message}</p>}
      {settings === null && error === null && <StateMessage title="Loading settings" />}
      {settings !== null && (
        <>
          {SHOW_DISCORD_ALERTS && (
          <form className="grid gap-3 rounded-panel border border-panel-line bg-panel-surface p-4" onSubmit={(event) => void saveWebhook(event)}>
            <h2 className="text-sm font-extrabold">Alerts to Discord</h2>
            <p className="text-xs text-panel-muted">
              {settings.webhookConfigured ? "A webhook is set. It is not shown again; enter a new one to replace it, or leave the field empty and save to remove it." : "No webhook is set."}
            </p>
            <label className="grid gap-1 text-sm font-bold" htmlFor="webhook">
              Discord webhook address
              <input autoComplete="off" className={field} id="webhook" onChange={(event) => setWebhook(event.target.value)} type="password" value={webhook} />
            </label>
            <div className="flex justify-end">
              <button className="button button-primary" type="submit">Save webhook</button>
            </div>
          </form>
          )}
          <form className="grid gap-3 rounded-panel border border-panel-line bg-panel-surface p-4" onSubmit={(event) => void saveRetention(event)}>
            <h2 className="text-sm font-extrabold">Backups kept per server</h2>
            <label className="grid gap-1 text-sm font-bold" htmlFor="keep">
              Number of backups
              <input className={field} id="keep" inputMode="numeric" max={100} min={1} onChange={(event) => setKeep(event.target.value)} type="number" value={keep} />
            </label>
            <div className="flex justify-end">
              <button className="button button-primary" type="submit">Save</button>
            </div>
          </form>
        </>
      )}
    </main>
  );
}
