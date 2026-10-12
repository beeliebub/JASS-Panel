---
name: typescript-coding-standards
description: TypeScript conventions for the JASS Panel: naming, type design, discriminated unions, Zod v4 style, error handling, async discipline, module layout, and the test and verification loop for a strict-mode Node/Fastify/React codebase. Use when writing or reviewing TypeScript in this repo.
metadata:
  origin: JASS Panel (adapted from the JASS website's standards)
---

# TypeScript Coding Standards (JASS Panel)

General TypeScript style for this repository. Defer to `jass-panel-stack` for architecture and invariants. There is no DI
framework and no state-management library: dependencies are plain function or constructor arguments, and modules import each other
directly.

## Core principles

- **Clarity over cleverness.** A named intermediate beats a dense chain.
- **Make illegal states unrepresentable** where it is cheap: a union of literals beats a `string` plus a runtime check, and
  `Record<Union, T>` beats a loose object because the compiler then reminds the next person.
- **Parse at the boundary, trust inside.** Every request body, query, env var, persisted JSON value, file, and line of
  game-server output is `unknown` until a Zod schema or a parser has accepted it.
- **`strict` stays on.** Never `any`, `@ts-ignore`, `@ts-expect-error`, or a non-null assertion to silence an error.
- **Comments explain why, not what.** Never reference reviews, agents, or planning documents in a shipped comment.
- **Unknown is a first-class value.** Model "could not determine" explicitly (`{ known: false }` or a `unknown` variant). Never
  collapse it into a default that looks like a real answer.

## Naming

```ts
// types and components: PascalCase; functions and variables: camelCase; constants: UPPER_SNAKE_CASE
type ServerState = "stopped" | "starting" | "running" | "stopping" | "crashed" | "unknown";
export const CAPABILITIES = ["server.view", "console.read" /* … */] as const;
export type Capability = (typeof CAPABILITIES)[number];
export function isOwner(user: PanelUser): boolean { … }
export function parseJoinLine(line: string): JoinEvent | null { … }
```

Schemas are suffixed `*Schema`; `assert*` throws, `is*` returns a boolean, `parse*` returns a value or a typed failure, `read*`
performs I/O.

## Type design

```ts
// a literal union as the single source of truth, with the type derived from it
export const CAPABILITIES = [ … ] as const;

// Record<Union, T> so a missing entry is a compile error
export const capabilityLabels: Record<Capability, string> = { … };

// expected failures are values, not exceptions
export type StopOutcome =
  | { kind: "clean" }
  | { kind: "forced"; after: "timeout" }
  | { kind: "failed"; message: string };
```

Prefer `type` over `interface` for data shapes. Use `as const` arrays rather than `enum`. When a literal union gains a member,
find every **hand-written** consumer (`switch`, arrays, `z.enum`, SQL `CHECK` constraints): the compiler does not flag those.

## Zod (v4)

```ts
z.object({
  server: serverIdSchema,                      // ^[a-z0-9][a-z0-9-]{0,31}$
  command: z.string().min(1).max(256),         // bound every string
  note: z.string().max(500).optional(),        // absent
  retain: z.number().int().min(1).max(365).nullable(),   // present, explicitly "none"
});
```

- v4: `error.issues`, not `error.errors`. `safeParse` at the boundary; never parse-and-throw in a route.
- Every user- or game-supplied string has a `max()`.
- Schemas live in `src/shared/` when the UI needs them, otherwise next to their module. The read path reuses the write schema.

## Errors

- Tolerate a specific error code, never a whole class. An empty `catch {}` hides the failure you needed to see.
- Wrap with the cause: `throw new Error("could not read crash report", { cause: error })`.
- Inside a SQLite transaction callback, **throw** to roll back; returning a failure-shaped value commits.
- Cleanup goes in `finally`. If cleanup itself can fail, log it and attach it; do not let it mask the original error.
- Routes report through the envelope helpers; never an ad-hoc `reply.send({ ... })`.
- A fallback on read is fine and established; never write a fallback value back.
- Never put a secret in an error message, a log line, or an audit detail. Redact at the logger, not at each call site.

## Async discipline

- No floating promises; every async call is awaited or deliberately handled with a documented reason.
- Independent reads run with `Promise.all`; sequential `await`s only when the second depends on the first.
- Every external call (child process, HTTP, filesystem on a hot path) has a timeout and is cancellable (`AbortSignal`).
- Long-running loops (polling, tailing) own an `AbortController`, stop on shutdown, and never leave a socket or child behind.
- Countdowns and timeouts use a monotonic clock, not wall-clock arithmetic; a module that needs the time takes it as a parameter so a
  test can set it.

## Modules and seams

- Two seams are injected so tests can substitute them: `run(argv)` for subprocesses and `fetch` for HTTP. Everything else uses Node
  directly against temporary directories.
- One module, one concern, opening with a contract comment (what it owns, what it refuses to do, why it is separate).
- `src/shared/` has no Node-only imports. `web/` imports only `src/shared/` and the API.
- Server paths are POSIX paths validated through the file jail; never concatenate user input into a path.
- Shell scripts and unit files are LF and checked with `shellcheck` where available.

## React and TSX conventions

- Server state through a single query layer; the SSE stream feeds that cache. Local component state for UI-only concerns.
- Derive, do not duplicate state. Keys are stable ids, never array indexes for reorderable or streaming lists.
- Every optimistic update has a rollback to the last server-confirmed value.
- The console view virtualizes long lists, caps retained lines, escapes all text (no `dangerouslySetInnerHTML`), and renders
  Minecraft colour codes as styled spans.
- Destructive buttons require typed confirmation and show why they are disabled while a job holds the lock.

## Testing and verification

Vitest is installed here. Write tests; do not rely on manual checks for logic.

```bash
npm run typecheck && npm run lint && npm test
npm run build     # when the web bundle or the server/shared boundary changed
```

- **Pure logic** (cron/TZ/DST, countdown planner, path jail, unit-file rendering and quoting, `show` parsing, log classification,
  permission matrix, update selection, retention): unit tests.
- **Parsers** run against **captured real output** stored under `test/fixtures/`, plus a "no match" case. A parser with only
  synthetic input is not verified.
- **Lifecycle and scheduling**: integration tests with a fake Paper under the real `systemctl --user` (unique unit prefix, removed in
  `finally`; skipped loudly when no user manager exists); cover crash, slow stop, daemon restart and lock contention, not only the
  happy path.
- **Security-relevant code** (jail, authorize, gate client, unit rendering, secret redaction): include hostile-input tests.
- What a fake cannot prove goes in a smoke checklist and is run on a real Paper server before the work is called done.
- Rerun a failing test once before treating it as real; see `CLAUDE.md`.
