// The wire shapes of the servers API that the daemon and the UI both use. The UI parses every response with these before any
// feature code sees it, and the daemon's tests check its answers against them.
import { z } from "zod";

export const SERVER_ACTIONS = ["start", "stop", "restart"] as const;
export type ServerAction = (typeof SERVER_ACTIONS)[number];

export const unitStateSchema = z.union([
  z.strictObject({
    known: z.literal(true),
    activeState: z.string(),
    subState: z.string(),
    result: z.string(),
    execMainStatus: z.number().nullable(),
    nRestarts: z.number().nullable(),
    mainPid: z.number().nullable(),
    activeSince: z.string().nullable(),
    memoryBytes: z.number().nullable(),
    /** True only for a running server that has printed its Done line. Until then the console refuses input. */
    loaded: z.boolean(),
  }),
  z.strictObject({ known: z.literal(false), reason: z.string() }),
]);
export type UnitStateView = z.infer<typeof unitStateSchema>;

export const lastEndSchema = z.strictObject({ result: z.string(), code: z.string(), status: z.string() }).nullable();

/**
 * A running countdown as a page is shown it. `cancellable` is true only for the person who started it while they hold power: the
 * panel decides that, so a page never has to know who started a countdown.
 */
export const countdownViewSchema = z.strictObject({
  /** The countdown a cancel names. A page sends back the id it was shown, so a cancel never reaches a countdown the page did not show. */
  id: z.uuid(),
  action: z.enum(["stop", "restart"]),
  scheduled: z.boolean(),
  warningsSent: z.number(),
  warningsDue: z.number(),
  cancellable: z.boolean(),
});
export const serverViewSchema = z.strictObject({
  id: z.string(),
  capabilities: z.array(z.string()),
  displayName: z.string(),
  directory: z.string(),
  logPath: z.string(),
  autostart: z.boolean(),
  updateOnStart: z.boolean(),
  memory: z.strictObject({ minMb: z.number(), maxMb: z.number() }).nullable(),
  state: unitStateSchema,
  lastEnd: lastEndSchema,
  unitEdited: z.boolean(),
  countdown: countdownViewSchema.nullable(),
});
export type ServerView = z.infer<typeof serverViewSchema>;

export const serversListSchema = z.strictObject({ servers: z.array(serverViewSchema) });
export const serverResponseSchema = z.strictObject({ server: serverViewSchema });
/** The longest warning a stop or restart can give players before it acts. */
export const COUNTDOWN_MAX_SECONDS = 300;
/** The warnings a scheduled stop or restart may give, in seconds; zero is no warning. */
export const SCHEDULE_COUNTDOWN_SECONDS = [0, 30, 60, 120, 300] as const;
/** The payload a scheduled stop or restart stores: the warning it gives players, in seconds. Only the offered lengths are valid. */
export const schedulePowerPayloadSchema = z.strictObject({ countdownSeconds: z.literal([...SCHEDULE_COUNTDOWN_SECONDS]) });
export const powerRequestSchema = z.strictObject({
  action: z.enum(SERVER_ACTIONS),
  countdownSeconds: z.int().min(0).max(COUNTDOWN_MAX_SECONDS).optional(),
});
export type PowerRequest = z.infer<typeof powerRequestSchema>;
/**
 * How a power request ended. "done": the stop happened, or the server's start or restart printed its Done line. "not_loaded": the
 * start or restart was not finished loading within five minutes, and the server is left running. "unknown": the panel could not tell
 * whether the start happened or finished loading (a reply that never came, or a journal that could not be read), so the server may still
 * come up; its state is shown as it is read. "cancelled": the countdown was cancelled by the person who started it, and nothing was stopped.
 */
export const POWER_OUTCOMES = ["done", "not_loaded", "unknown", "cancelled"] as const;
export type PowerOutcome = (typeof POWER_OUTCOMES)[number];
export const powerResponseSchema = z.strictObject({ state: unitStateSchema, outcome: z.enum(POWER_OUTCOMES) });
export const cancelledSchema = z.strictObject({ cancelled: z.literal(true) });
/** The body of a cancel. It names the countdown the person was shown, so a cancel sent after that countdown ended is refused. */
export const cancelRequestSchema = z.strictObject({ countdownId: z.uuid() });
export type CancelRequest = z.infer<typeof cancelRequestSchema>;
export const removedSchema = z.strictObject({ id: z.string() });
export const deliveredSchema = z.strictObject({ delivered: z.literal(true) });
/** The answer to a chat line or a player action: the line was written to the server's input. */
export const sentSchema = z.strictObject({ sent: z.literal(true) });

export const consoleKinds = ["chat", "join", "leave", "death", "advancement", "warning", "error", "crash", "system", "other"] as const;

export const consoleLineSchema = z.strictObject({
  id: z.string(),
  text: z.string(),
  cut: z.boolean(),
  kind: z.enum(consoleKinds),
  player: z.string().nullable(),
  time: z.string().nullable(),
});
export type ConsoleLine = z.infer<typeof consoleLineSchema>;

export const historySchema = z.strictObject({ lines: z.array(consoleLineSchema) });

export const streamedLineSchema = z.strictObject({
  text: z.string(),
  cut: z.boolean(),
  replay: z.boolean(),
  kind: z.enum(consoleKinds),
  player: z.string().nullable(),
  time: z.string().nullable(),
});

export const stateEventSchema = z.strictObject({ id: z.string(), state: unitStateSchema, countdown: countdownViewSchema.nullable() });

/** The body of POST /api/v1/servers. The daemon validates it again; this is what the form builds. */
export type AddServerBody = {
  readonly id: string;
  readonly displayName: string;
  readonly directory: string;
  readonly command:
    | {
        readonly kind: "paper";
        readonly javaPath: string;
        readonly minMb: number;
        readonly maxMb: number;
        readonly jarFile: string;
        readonly extraFlags: readonly string[];
      }
    | { readonly kind: "custom"; readonly argv: readonly string[] };
  readonly logPath: string;
  readonly autostart: boolean;
};
