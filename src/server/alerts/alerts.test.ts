import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundledMigrationsDirectory, migrate } from "../db/migrate.js";
import type { PanelDatabase } from "../db/open.js";
import { createAlerts, validateWebhook, WebhookError } from "./alerts.js";

let db: PanelDatabase;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db, { dir: bundledMigrationsDirectory(), backupDir: "/unused" });
});
afterEach(() => db.close());

describe("validateWebhook", () => {
  it("accepts a Discord webhook over https", () => {
    expect(validateWebhook("https://discord.com/api/webhooks/123/abc")).toBe("https://discord.com/api/webhooks/123/abc");
    expect(validateWebhook("https://discordapp.com/api/webhooks/1/x")).toContain("/api/webhooks/");
  });

  it("refuses anything else: other hosts, plain http, other paths, ports, credentials and queries", () => {
    const refused = [
      "http://discord.com/api/webhooks/1/x",
      "https://example.com/api/webhooks/1/x",
      "https://discord.com.evil.example/api/webhooks/1/x",
      "https://discord.com/somewhere/else",
      "https://discord.com:8443/api/webhooks/1/x",
      "https://user:pw@discord.com/api/webhooks/1/x",
      "https://discord.com/api/webhooks/1/x?wait=true",
      "https://127.0.0.1/api/webhooks/1/x",
      "not a url",
    ];
    for (const url of refused) expect(() => validateWebhook(url), url).toThrow(WebhookError);
  });
});

describe("createAlerts", () => {
  it("posts once per server and kind inside the window, and again after it clears", async () => {
    let at = 0;
    const posted: string[] = [];
    const alerts = createAlerts({ db, post: (url, body) => { posted.push(body); return Promise.resolve(204); }, now: () => new Date(at) });
    alerts.setWebhook("https://discord.com/api/webhooks/1/x");
    expect(await alerts.raise("crashed", "alpha", "first")).toBe(true);
    at += 60_000;
    expect(await alerts.raise("crashed", "alpha", "again")).toBe(false);
    alerts.clear("crashed", "alpha");
    expect(await alerts.raise("crashed", "alpha", "next occurrence")).toBe(true);
    expect(posted).toHaveLength(2);
    expect(posted[0]).toContain("first");
  });

  it("records an incident as not sent, once per window, while posting is not connected", async () => {
    let at = 0;
    const alerts = createAlerts({ db, now: () => new Date(at) });
    alerts.setWebhook("https://discord.com/api/webhooks/1/secret-token");
    expect(await alerts.raise("crashed", "alpha", "first")).toBe(false);
    at += 60_000;
    expect(await alerts.raise("crashed", "alpha", "again")).toBe(false);
    const rows = db.prepare("SELECT outcome, details FROM audit WHERE action = 'alert.crashed'").all() as { outcome: string; details: string }[];
    expect(rows.map((row) => row.outcome)).toEqual(["not_sent"]);
    expect(rows[0]?.details).not.toContain("secret-token");
  });

  it("does not post without a webhook, and never returns the address", () => {
    const alerts = createAlerts({ db, post: () => Promise.reject(new Error("should not be called")) });
    expect(alerts.configured()).toBe(false);
    alerts.setWebhook("https://discord.com/api/webhooks/1/secret-token");
    expect(alerts.configured()).toBe(true);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'discord_webhook'").get() as { value: string };
    expect(row.value).toContain("secret-token");
  });

  it("records a failed delivery without the address", async () => {
    const alerts = createAlerts({ db, post: () => Promise.resolve(500) });
    alerts.setWebhook("https://discord.com/api/webhooks/1/secret-token");
    expect(await alerts.raise("gave-up", "alpha", "x")).toBe(false);
    const rows = db.prepare("SELECT outcome, details FROM audit").all() as { outcome: string; details: string }[];
    expect(rows[0]?.outcome).toBe("failed");
    expect(rows[0]?.details ?? "").not.toContain("secret-token");
  });
});

describe("an alert whose post does not arrive", () => {
  it("waits twice as long after each failure, up to the window", async () => {
    let at = 0;
    const posted: number[] = [];
    const alerts = createAlerts({ db, post: () => { posted.push(at); return Promise.resolve(500); }, now: () => new Date(at) });
    alerts.setWebhook("https://discord.com/api/webhooks/1/x");
    // The waits after each failure are 1, 2, 4, 8 and then 10 minutes, the last being the window.
    for (const [when, blockedAt] of [[0, 59_999], [60_000, 179_999], [180_000, 419_999], [420_000, 899_999], [900_000, 1_499_999]] as const) {
      at = when;
      expect(await alerts.raise("backup-failed", "alpha", "x")).toBe(false);
      at = blockedAt;
      expect(await alerts.raise("backup-failed", "alpha", "x")).toBe(false);
    }
    expect(posted).toEqual([0, 60_000, 180_000, 420_000, 900_000]);
  });

  it("does not reopen an incident that was cleared while its post was in flight, and posts a new occurrence", async () => {
    let at = 0;
    let finish: (status: number) => void = () => undefined;
    const posted: string[] = [];
    const alerts = createAlerts({ db, post: (_url, body) => { posted.push(body); return new Promise<number>((resolve) => { finish = resolve; }); }, now: () => new Date(at) });
    alerts.setWebhook("https://discord.com/api/webhooks/1/x");
    const first = alerts.raise("crashed", "alpha", "first");
    alerts.clear("crashed", "alpha");
    finish(204);
    expect(await first).toBe(true);
    at = 1_000;
    const second = alerts.raise("crashed", "alpha", "second");
    finish(204);
    expect(await second).toBe(true);
    expect(posted).toHaveLength(2);
  });

  it("may be raised again after a minute, where a delivered alert waits out the whole window", async () => {
    let at = 0;
    let status = 500;
    const posted: string[] = [];
    const alerts = createAlerts({ db, post: (_url, body) => { posted.push(body); return Promise.resolve(status); }, now: () => new Date(at) });
    alerts.setWebhook("https://discord.com/api/webhooks/1/x");
    expect(await alerts.raise("backup-failed", "alpha", "first")).toBe(false);
    at = 59_000;
    expect(await alerts.raise("backup-failed", "alpha", "second")).toBe(false);
    expect(posted).toHaveLength(1);
    at = 60_000;
    status = 204;
    expect(await alerts.raise("backup-failed", "alpha", "third")).toBe(true);
    expect(posted).toHaveLength(2);
    at = 120_000;
    expect(await alerts.raise("backup-failed", "alpha", "fourth")).toBe(false);
    expect(posted).toHaveLength(2);
  });

  it("is not recorded while no webhook is set, so an incident raised before one is set still reaches it", async () => {
    let at = 0;
    const posted: string[] = [];
    const alerts = createAlerts({ db, post: (_url, body) => { posted.push(body); return Promise.resolve(204); }, now: () => new Date(at) });
    expect(await alerts.raise("schedule-failed", "alpha", "before")).toBe(false);
    alerts.setWebhook("https://discord.com/api/webhooks/1/x");
    at = 1_000;
    expect(await alerts.raise("schedule-failed", "alpha", "after")).toBe(true);
    expect(posted).toHaveLength(1);
  });
});

describe("a clock that steps back", () => {
  it("does not keep an incident silenced past the earlier post", async () => {
    let at = 3_600_000;
    const posted: string[] = [];
    const alerts = createAlerts({ db, post: (_url, body) => { posted.push(body); return Promise.resolve(204); }, now: () => new Date(at) });
    alerts.setWebhook("https://discord.com/api/webhooks/1/x");
    expect(await alerts.raise("crashed", "alpha", "first")).toBe(true);
    at = 0;
    expect(await alerts.raise("crashed", "alpha", "after the step")).toBe(true);
    expect(posted).toHaveLength(2);
  });
});
