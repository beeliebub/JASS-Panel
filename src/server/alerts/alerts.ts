// Alerts to a Discord webhook, once posting is connected; until then each incident is recorded in the audit log as not sent. The webhook
// is write-only: it is stored, used, and never returned. A URL is accepted only as HTTPS on Discord's own host under /api/webhooks/, and it
// is never followed to another address, so a person with settings.manage cannot aim the daemon at anything else. An incident is raised once
// per server and kind in a ten-minute window and cleared when its condition clears, so the next occurrence is a new alert. An alert is best
// effort: a failure to record or send one is never raised to the caller.
import type { PanelDatabase } from "../db/open.js";
import { recordAudit } from "../audit/audit.js";

export class WebhookError extends Error {}

const WINDOW_MS = 10 * 60_000;
// A post that did not arrive may be tried again after this long, rather than silencing its incident for the whole window.
const FAILED_RETRY_MS = 60_000;
const ALLOWED_HOSTS = new Set(["discord.com", "discordapp.com"]);

export function validateWebhook(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookError("the webhook is not a valid address");
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || url.port !== "") {
    throw new WebhookError("the webhook must be an https address on discord.com or discordapp.com");
  }
  if (!url.pathname.startsWith("/api/webhooks/") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new WebhookError("the webhook must be a Discord webhook path with no credentials, query or fragment");
  }
  return url.toString();
}

export type PostFunction = (url: string, body: string) => Promise<number>;

export interface AlertDependencies {
  readonly db: PanelDatabase;
  /** Absent while posting is not connected: each incident is then recorded as not sent. */
  readonly post?: PostFunction;
  readonly now?: () => Date;
}

export interface AlertService {
  raise(kind: string, serverId: string | null, message: string): Promise<boolean>;
  clear(kind: string, serverId: string | null): void;
  configured(): boolean;
  setWebhook(url: string | null): void;
}

export function createAlerts(deps: AlertDependencies): AlertService {
  const now = deps.now ?? (() => new Date());
  const post = deps.post;
  const open = new Map<string, number>();
  const failures = new Map<string, number>();
  const key = (kind: string, serverId: string | null) => `${serverId ?? "-"}|${kind}`;

  function webhook(): string | null {
    const row = deps.db.prepare("SELECT value FROM settings WHERE key = 'discord_webhook'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  async function send(kind: string, serverId: string | null, message: string): Promise<boolean> {
    const id = key(kind, serverId);
    const at = now().getTime();
    const last = open.get(id);
    // A clock that stepped back is not a window still open, so the window is measured forward only.
    if (last !== undefined && at >= last && at - last < WINDOW_MS) return false;
    // Without a poster the incident is recorded once per window as not sent, so it stays visible in the panel and nothing leaves the machine.
    if (post === undefined) {
      open.set(id, at);
      recordAudit(deps.db, { userId: null, userLabel: "alerts", serverId, action: `alert.${kind}`, outcome: "not_sent", details: { reason: "posting is not connected" } }, now());
      return false;
    }
    const url = webhook();
    // Without a webhook nothing is sent, and nothing is recorded as sent, so an incident raised before one is set still reaches it.
    if (url === null) return false;
    // Marked before the post, so a second raise for the same incident while this one is in flight is not posted twice.
    open.set(id, at);
    const body = JSON.stringify({ content: message.slice(0, 1800) });
    let status: number;
    try {
      status = await post(url, body);
    } catch {
      status = 0;
    }
    const delivered = status >= 200 && status < 300;
    // An incident cleared, or raised again, while this post was in flight is not reopened or re-timed by this post's outcome.
    if (open.get(id) === at) {
      if (delivered) {
        failures.delete(id);
        open.set(id, at);
      } else {
        // A failed post may be raised again after a delay that doubles with each consecutive failure, up to the window, so a webhook that
        // has gone away is not posted to every minute indefinitely.
        const failed = (failures.get(id) ?? 0) + 1;
        failures.set(id, failed);
        open.set(id, at - WINDOW_MS + Math.min(FAILED_RETRY_MS * 2 ** (failed - 1), WINDOW_MS));
      }
    }
    recordAudit(deps.db, { userId: null, userLabel: "alerts", serverId, action: `alert.${kind}`, outcome: delivered ? "ok" : "failed", details: { status } }, now());
    return delivered;
  }

  return {
    async raise(kind, serverId, message) {
      try {
        return await send(kind, serverId, message);
      } catch {
        return false;
      }
    },
    clear(kind, serverId) {
      open.delete(key(kind, serverId));
      failures.delete(key(kind, serverId));
    },
    configured() {
      return webhook() !== null;
    },
    setWebhook(url) {
      if (url === null) {
        deps.db.prepare("DELETE FROM settings WHERE key = 'discord_webhook'").run();
        return;
      }
      deps.db.prepare("INSERT INTO settings (key, value) VALUES ('discord_webhook', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(url);
    },
  };
}

/** The default poster: a POST with no redirects, a short timeout, and only the status code returned. */
export const postToWebhook: PostFunction = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  return response.status;
};
