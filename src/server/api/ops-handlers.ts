// Handlers for players, chat, plugin sources and updates, and the panel's settings. Chat and player actions are composed commands:
// the name is checked against the player-name alphabet and the text against the console's rules before a line is written to the FIFO.
import { join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { recordAudit } from "../audit/audit.js";
import type { AlertService } from "../alerts/alerts.js";
import { validateWebhook, WebhookError } from "../alerts/alerts.js";
import type { PanelConfig } from "../config/config.js";
import { sendCommand, commandProblem } from "../console/fifo.js";
import { onlinePlayers } from "../console/players.js";
import { readHistory } from "../console/tail.js";
import type { PanelDatabase } from "../db/open.js";
import { resolveInside, JailError } from "../files/jail.js";
import { fifoPath } from "../power/power.js";
import { getSources, setSources, tokenOf } from "../plugins/sources.js";
import { setUpdateOnStart } from "../plugins/update-on-start.js";
import { setAutostart } from "../servers/autostart.js";
import { catalogue, summaryOf, updatePlugins, UpdateError, type Fetcher } from "../plugins/updater.js";
import { pluginCatalogueBodySchema, pluginSourcesBodySchema } from "../../shared/features.js";
import { getServer, type ServerRecord } from "../servers/store.js";
import { ServiceError } from "../servers/service.js";
import { observeServers, type Readiness } from "../power/readiness.js";
import type { Runner } from "../systemd/run.js";
import type { PanelUser } from "../../shared/api.js";
import { sendData, sendError } from "./envelope.js";
import type { OperationLocks } from "../power/lock.js";

export interface OpsContext {
  readonly db: PanelDatabase;
  readonly config: PanelConfig;
  readonly run: Runner;
  readonly locks: OperationLocks;
  readonly readiness: Readiness;
  readonly alerts: AlertService;
  readonly fetcher: Fetcher;
  readonly now: () => Date;
}

export type OpsHandler = (request: FastifyRequest, reply: FastifyReply) => unknown;

export type OpsRouteId =
  | "players.list"
  | "chat.send"
  | "players.action"
  | "plugins.sources.get"
  | "plugins.sources.set"
  | "plugins.catalogue"
  | "plugins.update"
  | "plugins.update-on-start"
  | "servers.autostart"
  | "settings.get"
  | "settings.webhook"
  | "settings.retention";

const PLAYER = /^[A-Za-z0-9_]{3,16}$/;
const chatBody = z.strictObject({ text: z.string().min(1).max(256) });
const playerBody = z.strictObject({ name: z.string().regex(PLAYER, "a player name is 3 to 16 letters, digits or underscores") });
const updateOnStartBody = z.strictObject({ enabled: z.boolean() });
const autostartBody = z.strictObject({ enabled: z.boolean() });
const webhookBody = z.strictObject({ url: z.string().max(512).nullable() });
const retentionBody = z.strictObject({ keep: z.number().int().min(1).max(100) });
// A Map, not an object: a plain object answers "constructor" and "toString" with inherited functions.
const PLAYER_ACTIONS: ReadonlyMap<string, (name: string) => string> = new Map<string, (name: string) => string>([
  ["kick", (name) => `kick ${name}`],
  ["whitelist-add", (name) => `whitelist add ${name}`],
  ["whitelist-remove", (name) => `whitelist remove ${name}`],
]);

function principal(request: FastifyRequest): PanelUser {
  if (request.panelUser === undefined) throw new Error("the guard did not attach a signed-in person");
  return request.panelUser;
}

function rowOf(ctx: OpsContext, request: FastifyRequest, reply: FastifyReply): ServerRecord | FastifyReply {
  const row = getServer(ctx.db, (request.params as { serverId: string }).serverId);
  return row ?? sendError(reply, "not_found", "There is no such server.");
}

function isRow(value: ServerRecord | FastifyReply): value is ServerRecord {
  return !("send" in value);
}

async function writeWhenRunning(ctx: OpsContext, serverId: string, line: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [state] = [...(await observeServers(ctx.run, ctx.readiness, [serverId])).values()];
  if (state === undefined || !state.known || state.state.activeState !== "active") return { ok: false, reason: "the server is not running" };
  if (!state.state.loaded) return { ok: false, reason: "the server is still loading" };
  const outcome = sendCommand(fifoPath(ctx.config.runtimeDir, serverId), line);
  return outcome.delivered ? { ok: true } : { ok: false, reason: "the server is not accepting input" };
}

export function createOpsHandlers(ctx: OpsContext): Record<OpsRouteId, OpsHandler> {
  return {
    "players.list": (request, reply) => {
      const row = rowOf(ctx, request, reply);
      if (!isRow(row)) return row;
      const texts = readHistory(join(row.directory, row.logPath), 3000).map((line) => line.text);
      return sendData(reply, { players: onlinePlayers(texts), approximate: true });
    },

    "chat.send": async (request, reply) => {
      const user = principal(request);
      const row = rowOf(ctx, request, reply);
      if (!isRow(row)) return row;
      const parsed = chatBody.safeParse(request.body);
      if (!parsed.success) return sendError(reply, "invalid_request", "The message is not valid.");
      const line = `say ${parsed.data.text}`;
      if (commandProblem(line) !== null) return sendError(reply, "invalid_request", "That message cannot be sent to the server.");
      const result = await writeWhenRunning(ctx, row.id, line);
      recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "chat.send", outcome: result.ok ? "ok" : "failed", details: { length: parsed.data.text.length } }, ctx.now());
      if (!result.ok) return sendError(reply, "conflict", `The message was not sent: ${result.reason}.`);
      return sendData(reply, { sent: true });
    },

    "players.action": async (request, reply) => {
      const user = principal(request);
      const row = rowOf(ctx, request, reply);
      if (!isRow(row)) return row;
      const actionName = (request.params as { action: string }).action;
      const action = PLAYER_ACTIONS.get(actionName);
      if (action === undefined) return sendError(reply, "not_found", "That player action does not exist.");
      const parsed = playerBody.safeParse(request.body);
      if (!parsed.success) return sendError(reply, "invalid_request", "The player name is not valid.");
      const line = action(parsed.data.name);
      if (commandProblem(line) !== null) return sendError(reply, "invalid_request", "That command cannot be sent to the server.");
      const result = await writeWhenRunning(ctx, row.id, line);
      recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: `players.${actionName}`, outcome: result.ok ? "ok" : "failed", details: { name: parsed.data.name } }, ctx.now());
      if (!result.ok) return sendError(reply, "conflict", `The command was not sent: ${result.reason}.`);
      return sendData(reply, { sent: true });
    },

    "plugins.sources.get": (request, reply) => {
      const row = rowOf(ctx, request, reply);
      if (!isRow(row)) return row;
      const stored = getSources(ctx.db, row.id);
      return sendData(reply, {
        pluginDir: stored.pluginDir,
        sources: stored.sources.map((source) => ({ repo: source.repo, plugins: source.plugins, tokenConfigured: source.token !== null })),
      });
    },

    "plugins.sources.set": (request, reply) => {
      const user = principal(request);
      const row = rowOf(ctx, request, reply);
      if (!isRow(row)) return row;
      const parsed = pluginSourcesBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, "invalid_request", "The plugin sources are not valid.");
      try {
        setSources(ctx.db, row.id, parsed.data);
      } catch (error) {
        if (error instanceof JailError) return sendError(reply, "invalid_request", error.message);
        throw error;
      }
      // The audit row names the repositories and counts the plugins; a token never goes there.
      const plugins = parsed.data.sources.reduce((count, source) => count + source.plugins.length, 0);
      recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "plugins.sources", outcome: "ok", details: { repos: parsed.data.sources.map((source) => source.repo), plugins } }, ctx.now());
      return sendData(reply, { saved: true });
    },

    "plugins.catalogue": async (request, reply) => {
      const row = rowOf(ctx, request, reply);
      if (!isRow(row)) return row;
      const parsed = pluginCatalogueBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, "invalid_request", "The repository is not valid.");
      const { repo, token } = parsed.data;
      // An omitted token is the one stored for this repository, so a repository can be looked at before its token is changed.
      const reading = token === undefined ? tokenOf(ctx.db, row.id, repo) : token === null || token === "" ? null : token;
      try {
        return sendData(reply, await catalogue(ctx.fetcher, repo, reading));
      } catch (error) {
        if (error instanceof UpdateError) return sendError(reply, "conflict", error.message);
        throw error;
      }
    },

    "plugins.update": async (request, reply) => {
      const user = principal(request);
      const row = rowOf(ctx, request, reply);
      if (!isRow(row)) return row;
      const { pluginDir, sources } = getSources(ctx.db, row.id);
      if (pluginDir === null || sources.length === 0) return sendError(reply, "invalid_request", "Add a plugin source first.");
      const release = ctx.locks.tryAcquire(row.id, "plugin-update");
      if (release === null) return sendError(reply, "conflict", "Another operation is running on this server.");
      try {
        const folder = resolveInside(row.directory, pluginDir, { allowMissing: true });
        const results = await updatePlugins(ctx.fetcher, sources, folder);
        const summary = summaryOf(results);
        recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: row.id, action: "plugins.update", outcome: summary.failed.length > 0 ? "failed" : "ok", details: summary }, ctx.now());
        return sendData(reply, { results });
      } catch (error) {
        if (error instanceof JailError) return sendError(reply, "invalid_request", error.message);
        throw error;
      } finally {
        release();
      }
    },

    "servers.autostart": async (request, reply) => {
      const user = principal(request);
      const row = rowOf(ctx, request, reply);
      if (!isRow(row)) return row;
      const parsed = autostartBody.safeParse(request.body);
      if (!parsed.success) return sendError(reply, "invalid_request", "Say whether the server starts with the machine.");
      try {
        await setAutostart({ db: ctx.db, run: ctx.run, locks: ctx.locks, now: ctx.now }, row.id, parsed.data.enabled, { id: user.id, label: user.email });
      } catch (error) {
        if (error instanceof ServiceError) return sendError(reply, error.code === "not_found" ? "not_found" : "conflict", error.message);
        throw error;
      }
      return sendData(reply, { autostart: parsed.data.enabled });
    },

    "plugins.update-on-start": async (request, reply) => {
      const user = principal(request);
      const row = rowOf(ctx, request, reply);
      if (!isRow(row)) return row;
      const parsed = updateOnStartBody.safeParse(request.body);
      if (!parsed.success) return sendError(reply, "invalid_request", "Say whether updates on start are on or off.");
      try {
        await setUpdateOnStart({ db: ctx.db, config: ctx.config, run: ctx.run, now: ctx.now }, row.id, parsed.data.enabled, { id: user.id, label: user.email });
      } catch (error) {
        if (error instanceof ServiceError) return sendError(reply, error.code === "not_found" ? "not_found" : "conflict", error.message);
        throw error;
      }
      return sendData(reply, { updateOnStart: parsed.data.enabled });
    },

    "settings.get": (_request, reply) => {
      const retention = ctx.db.prepare("SELECT value FROM settings WHERE key = 'backup_retention'").get() as { value: string } | undefined;
      return sendData(reply, { webhookConfigured: ctx.alerts.configured(), backupRetention: Number(retention?.value ?? 7) });
    },

    "settings.webhook": (request, reply) => {
      const user = principal(request);
      const parsed = webhookBody.safeParse(request.body);
      if (!parsed.success) return sendError(reply, "invalid_request", "The webhook setting is not valid.");
      try {
        ctx.alerts.setWebhook(parsed.data.url === null ? null : validateWebhook(parsed.data.url));
      } catch (error) {
        if (error instanceof WebhookError) return sendError(reply, "invalid_request", error.message);
        throw error;
      }
      recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: null, action: "settings.webhook", outcome: "ok", details: { configured: parsed.data.url !== null } }, ctx.now());
      return sendData(reply, { webhookConfigured: ctx.alerts.configured() });
    },

    "settings.retention": (request, reply) => {
      const user = principal(request);
      const parsed = retentionBody.safeParse(request.body);
      if (!parsed.success) return sendError(reply, "invalid_request", "Keep between 1 and 100 backups.");
      ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('backup_retention', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(parsed.data.keep));
      recordAudit(ctx.db, { userId: user.id, userLabel: user.email, serverId: null, action: "settings.retention", outcome: "ok", details: { keep: parsed.data.keep } }, ctx.now());
      return sendData(reply, { backupRetention: parsed.data.keep });
    },
  };
}
