# JASS Panel: Minecraft server control panel

A small web control panel for the JASS Minecraft servers, served at `/panel` on the same machine as the JASS website. It is a
standalone daemon that runs as an ordinary user, manages each game server as a systemd **user** unit, and asks the website two
questions: "is this session an OWNER or ADMIN right now?", and, for the Access screen, which OWNER and ADMIN accounts exist, asked only on behalf of an owner or a panel operator. The architecture, threat model and data model are in
`docs/DESIGN.md`; **read it before designing anything**. It records decisions already made; do not re-ask them. `PLAN.md` is the
work queue.

The first version of this daemon was scrapped for growing far past what the job needed. It is archived outside the repository
(`~/jass-panel-archive-2026-10-10.tar.gz`). Treat that history as a warning, not a parts bin: the size budgets and the
out-of-scope list in `docs/DESIGN.md` §13 and §14 exist for that reason.

## Status

The daemon, the web app, the installer and the tests exist. The daemon serves the API under `PANEL_BASE_PATH`, identity comes from the
website, servers are systemd user units with stdin FIFOs, and the file, backup, restore, schedule, plugin-update, alert, player and
privileged-action features are built with tests. What is not verified yet is listed in `docs/DEPLOYMENT.md` ("Verified and not yet
verified") and in `PLAN.md`. Do not document behaviour that does not exist; `docs/DESIGN.md` records the decisions.

## Stack

Node 22.12+ and TypeScript (strict, ESM). Daemon: Fastify (REST and Server-Sent Events), `better-sqlite3` with
forward-only SQL migrations, Zod v4, `croner`. UI: Vite, React, Tailwind, CodeMirror, TanStack Virtual. Tests: Vitest. Node is at
`/usr/bin/node` on the development machine.

## Commands

> Do not invent other scripts, and update this block in the same change that adds or renames one.

```bash
npm run typecheck   # tsc --noEmit for the web + shared project and the node/test project
npm run lint        # eslint (typed rules; accessibility and hooks rules for web/)
npm test            # vitest run; lifecycle and backup tests use the real user manager, real tar and zstd, and skip without a user manager
npm run build       # the daemon to dist/server (with the SQL migrations copied beside it) and the web app to web/dist
npm run build:server # the daemon alone, the first half of build: tsc to dist/server, then the migrations copied beside it
npm run build:web   # the web app alone, the second half of build: vite build to web/dist
npm run dev         # build the daemon, then run it on PANEL_PORT, reading .env
npm run dev:web     # Vite with the proxy to the daemon and the local website
npm start           # run the built daemon
npm run db:migrate  # apply pending migrations to PANEL_DATA_DIR and exit
```

On this machine the website needs `next dev --webpack` (Turbopack has no native bindings here), and `node --no-turbofan` workarounds
from the website's notes do not apply to these scripts.

## Environment variables

See `.env.example`; the table lives in `docs/DEPLOYMENT.md`. A new or changed variable is documented in both
in the same change.

| Variable | Default | Meaning |
|---|---|---|
| `PANEL_PUBLIC_ORIGIN` | none, required | the website's public origin, for `Origin` and `Host` checks |
| `SITE_INTERNAL_URL` | `http://127.0.0.1:3000` | where the daemon asks the website who the caller is; loopback only |
| `PANEL_PORT` | `29200` | loopback port the daemon listens on |
| `PANEL_BASE_PATH` | `/panel` | URL prefix of the UI and API; must match the proxy rule |
| `PANEL_DATA_DIR` | `$XDG_DATA_HOME/jass-panel` | database, backups, file history, markers |

Secrets (GitHub tokens, the Discord webhook) are never environment variables and never in the repository; they live in the daemon's
database, which is created mode 0600.

## Identity: the daemon never trusts a header

For every API request and stream revalidation the daemon calls the website's `GET /api/panel/session`, forwarding the browser's
`Cookie`, and treats only a direct `200 { data: { user } }` from `SITE_INTERNAL_URL` as proof of identity. Anything else is "not
signed in", "no access" or "unavailable", and unavailable is never access. `OWNER` has every capability on every server; `ADMIN` has
only what a grant row allows (see `docs/DESIGN.md` §4 and §5). Every decision goes through `authorize(user, capability, serverId?)`;
a route without a declared capability fails a test.

## Layout

- `docs/` design (and, with the daemon, deployment).
- `src/shared/` wire schemas shared with the UI; no Node-only imports. `src/server/` is the daemon: `api/` (routes, guard, streams), `gate/` (website identity), `authz/` (the one permission check and the route table), `servers/`, `power/`, `console/`, `files/`, `backups/`, `schedules/`, `plugins/`, `alerts/`, `control/`, `privileged/`, `health/`, `access/`, `audit/`, `db/`, `config/`, `systemd/`.
- `web/` the React single-page app; imports only `src/shared/` and the HTTP API.
- `test/fixtures/` captured real output (see its README); `test/support/` the fixture scanner.
- `.claude/` agents, skills and the orchestrator workflow; `.agents/skills/` mirrors the skills for Codex. Keep the two in sync.

## Working rules

- **Non-trivial work** follows the workflow in `.claude/commands/orchestrator.md` (the `/orchestrator` command in Claude Code): scope, explore, plan, harden the plan, implement with tests, verify, review, docs.
  A change of a few lines does not need it.
- **Hardening pass** (`hardening-analyst`) on every design and every risky diff (lifecycle, authorization, files, backups, schedules,
  install, migrations, anything reading `process.env`). Its pattern library is curated with a cap of 55; it is not append-only.
- **Gates**: `npm run typecheck`, `npm run lint`, `npm test`. Rerun a failure once; one that reproduces is a defect, one that does not is
  recorded as unexplained. (This machine once had a faulty CPU core that produced wrong results at random; it is believed fixed.)
- **No privilege by default.** The daemon and servers never run as root; setup steps that need it are a closed catalogue of actions confirmed with the account's password in the UI (`docs/DESIGN.md` §11). Tests never use real `sudo`. An agent uses `sudo` only when the user hands over
  the credential in the current session for a named job: keep it in a 0600 file outside the repository, feed it to `sudo -S` on standard
  input, never write it to a repository file, command line, log or test, and delete the file when the job ends. Agents never touch a real
  game server or the real proxy configuration. Tests use their own temporary directories and user units named with a unique `jass-test-`
  prefix, removed in `finally`.
- **Safety checklist** for lifecycle, backup/restore, files, schedules, install and migration changes: no subprocess from a string; a
  recovery as wide as the blast radius; cleanup in `finally` *and* start-up reconciliation for the death path; unknown is not a safe
  value; no secret in a log, error, audit row or response; migrations forward-only with no literals from a development database;
  new or changed variables documented; no development artifacts in production paths; run on a real Paper server before it is "done".
- **Conventions**: a contract comment at the top of each module; Zod at every boundary; persisted JSON validated on write and on read,
  never writing a fallback back; envelope `{ data }` / `{ error: { code, message, details? } }`; audit rows in the same transaction as
  the change; comments explain why, not what.

### Ephemeral planning document (`PLAN.md`)

`PLAN.md` is a work queue, not documentation, and never a source of truth about behaviour. Its contents are never copied into
`README.md`, `AGENTS.md`, `docs/**` or a code comment. Valid edits: add scoped work, delete items that have landed, clear it back to
the skeleton when empty. Do not delete the file.

### Git

Read-only git (`git status`, `git diff`, `git log`, `git show`) is expected. **Never commit, push, branch, stage, reset, revert,
stash or rewrite history**; the user owns every write to git history. This directory may not be a repository: do not run `git init`.

### No AI attribution in shipped artifacts

No code comment, JSDoc, migration comment, documentation line or commit message may reference AI agents, reviews, or the
orchestration process: no "found in review", no agent names, no `PLAN.md` phase labels or decision numbers. State the underlying
reasoning directly; a comment must still make sense to someone reading the file cold.
