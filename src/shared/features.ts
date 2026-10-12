// Wire shapes for the panel's feature endpoints: files, backups, schedules, plugins, players, access, audit, health and settings.
// The UI parses every response with these before feature code sees it.
import { z } from "zod";

export const fileEntrySchema = z.strictObject({
  name: z.string(),
  kind: z.enum(["file", "directory", "other"]),
  size: z.number(),
  modified: z.string(),
});
export const listingSchema = z.strictObject({ entries: z.array(fileEntrySchema), truncated: z.boolean() });
export const fileTextSchema = z.strictObject({ path: z.string(), text: z.string(), truncated: z.boolean(), size: z.number() });
export type FileText = z.infer<typeof fileTextSchema>;

export const backupSchema = z.strictObject({
  id: z.number(),
  serverId: z.string(),
  file: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  createdAt: z.string(),
  kind: z.enum(["manual", "scheduled"]),
});
export type Backup = z.infer<typeof backupSchema>;
/** An unsettled restore, as the backups screen shows it. Folder names only: the paths stay on the server. */
export const restoreRecordSchema = z
  .strictObject({
    startedAt: z.string().nullable(),
    unreadable: z.boolean(),
    folders: z.array(z.strictObject({ role: z.enum(["server", "staging", "aside"]), name: z.string(), present: z.boolean().nullable() })),
    /** Whether the record may be cleared now. False while the server folder is missing and folders from a restore are beside it. */
    clearable: z.boolean(),
  })
  .nullable();
export const backupsSchema = z.strictObject({ backups: z.array(backupSchema), restoreRecord: restoreRecordSchema });
export const restoreRecordClearedSchema = z.strictObject({ cleared: z.literal(true) });
// The largest file one upload can send. The daemon refuses a larger body before reading it, and the page checks the size first.
export const UPLOAD_MAX_BYTES = 256 * 1024 * 1024;
export const leftoversSchema = z.strictObject({ leftovers: z.array(z.string()) });

export const scheduleSchema = z.strictObject({
  id: z.number(),
  serverId: z.string(),
  kind: z.enum(["start", "stop", "restart", "backup", "command"]),
  cron: z.string(),
  timezone: z.string(),
  payload: z.string().nullable(),
  enabled: z.boolean(),
  creatorId: z.string(),
  lastRunAt: z.string().nullable(),
  lastResult: z.string().nullable(),
  createdAt: z.string(),
});
export type Schedule = z.infer<typeof scheduleSchema>;
export const schedulesSchema = z.strictObject({ schedules: z.array(scheduleSchema) });

// A server's plugin sources: the repositories its plugins come from and the plugins it installs from each. A repository's name, a plugin's
// name and a token are the only values a person types, and each is checked before it is stored.
export const PLUGIN_SOURCES_MAX = 8;
export const PLUGINS_MAX = 16;
export const repoName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/, "the repository must be owner/name");
const pluginName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a plugin name may use letters, digits, dashes and underscores");
const accessToken = z.string().max(256).nullable().optional();
export const pluginSourcesSchema = z.strictObject({
  pluginDir: z.string().nullable(),
  sources: z.array(z.strictObject({ repo: repoName, plugins: z.array(pluginName), tokenConfigured: z.boolean() })),
});
export const pluginSourcesBodySchema = z
  .strictObject({
    pluginDir: z.string().min(1).max(512),
    sources: z.array(z.strictObject({ repo: repoName, plugins: z.array(pluginName).max(PLUGINS_MAX), token: accessToken })).max(PLUGIN_SOURCES_MAX),
  })
  .superRefine((body, context) => {
    const repos = new Set<string>();
    const plugins = new Set<string>();
    for (const source of body.sources) {
      if (repos.has(source.repo)) context.addIssue({ code: "custom", message: "each repository may be listed once", path: ["sources"] });
      repos.add(source.repo);
      // Plugin names are compared without case, since a release is matched without case.
      for (const plugin of source.plugins) {
        if (plugins.has(plugin.toLowerCase())) context.addIssue({ code: "custom", message: "each plugin may be listed once, across all repositories", path: ["sources"] });
        plugins.add(plugin.toLowerCase());
      }
    }
  });
export type PluginSourcesBody = z.infer<typeof pluginSourcesBodySchema>;
export const pluginCatalogueBodySchema = z.strictObject({ repo: repoName, token: accessToken });
export const pluginCatalogueSchema = z.strictObject({
  repo: repoName,
  release: z.string(),
  plugins: z.array(z.strictObject({ name: pluginName, asset: z.string() })),
});
export const pluginUpdateSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      repo: repoName,
      plugin: pluginName,
      status: z.enum(["updated", "current", "failed"]),
      asset: z.string().nullable(),
      removed: z.array(z.string()),
      message: z.string().nullable(),
    }),
  ),
});

export const playersSchema = z.strictObject({ players: z.array(z.string()), approximate: z.boolean() });

export const grantSchema = z.strictObject({
  userId: z.string(),
  serverId: z.string(),
  capability: z.string(),
  grantedBy: z.string(),
  grantedAt: z.string(),
});
export type Grant = z.infer<typeof grantSchema>;
export const grantedSchema = z.strictObject({ granted: z.literal(true) });
export const revokedSchema = z.strictObject({ revoked: z.literal(true) });
// lastSeen is when this panel last saw the person, and null for an account the panel has not seen yet.
export const knownUserSchema = z.strictObject({ id: z.string(), email: z.string(), name: z.string().nullable(), lastSeen: z.string().nullable() });
// usersFrom says where the users come from: the website's accounts; the people this panel has seen, for a caller who may not ask the
// website; or that same record, when the website could not be asked.
export const accessSchema = z.strictObject({ grants: z.array(grantSchema), users: z.array(knownUserSchema), usersFrom: z.enum(["website", "seen", "website-unavailable"]) });

export const auditRowSchema = z.strictObject({
  id: z.number(),
  at: z.string(),
  userLabel: z.string().nullable(),
  serverId: z.string().nullable(),
  action: z.string(),
  details: z.string().nullable(),
  outcome: z.string(),
});
export type AuditRow = z.infer<typeof auditRowSchema>;
export const auditSchema = z.strictObject({ rows: z.array(auditRowSchema) });

export const checkStatusSchema = z.enum(["ok", "warning", "error", "unknown"]);
export const healthCheckSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  status: checkStatusSchema,
  detail: z.string(),
  action: z.string().optional(),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;
export const healthSchema = z.strictObject({ checks: z.array(healthCheckSchema) });

export const privilegedResultSchema = z.strictObject({ exitCode: z.number().nullable(), output: z.string() });
export const settingsSchema = z.strictObject({ webhookConfigured: z.boolean(), backupRetention: z.number() });
