---
name: jass-panel-stack
description: The JASS Panel's architecture, invariants and working shape in one page: a small daemon that manages Minecraft servers as systemd user units and delegates identity to the JASS website. Use when designing, implementing or reviewing anything in this repository.
metadata:
  origin: JASS Panel
---

# JASS Panel stack

`docs/DESIGN.md` is the architecture of record and `PLAN.md` is the work queue. Read the relevant DESIGN sections before changing
anything; where code and design disagree, one of them is wrong and the change must say which.

## Shape in five lines

- One Node 22 / TypeScript daemon (Fastify, `better-sqlite3`, Zod, `croner`) and one React SPA served under `/panel`, beside the website.
- Identity comes from the website's `GET /api/panel/session` (cookie forwarded); scheduled actions use `POST /api/panel/identity`.
- Each game server is a systemd **user** unit (plus a stdin socket) that the panel writes; servers outlive the panel.
- Features wrap OS tools: `systemctl --user`, `tar`, the server's own `latest.log`, a stdin FIFO. No job engine.
- The panel runs as an ordinary user, with no root, polkit or sudoers, on any Linux with systemd.

## Invariants (a violation is a bug, not a style issue)

1. `authorize(user, capability, serverId?)` is the only permission check; every route declares a capability; a server capability with no
   server is denied.
2. No identity header is ever trusted; only a direct `200` from the configured site URL is identity. Unavailable is never access.
3. Unknown is not a safe value: an unreadable observation is `unknown`, and unknown never allows a destructive step.
4. No subprocess from a string; `--` before data-derived operands; one render function writes unit files and rejects NUL and newlines.
5. Every request-derived path goes through the file jail (`realpath` containment, `O_NOFOLLOW`).
6. `save-off` always has `save-on` in `finally` **and** a start-up reconciliation for the death path.
7. A destructive action has a recovery as wide as its blast radius; nothing the panel does deletes a server directory.
8. No secret in a log, error, audit row, API response or client bundle.
9. High-risk capabilities (`console.send`, `files.write`, `plugins`, `schedules`, `servers.manage`) are labelled as code execution as the
   panel's account.
10. Nothing refers to a particular account name or home directory; paths come from configuration or the UI.
11. A move of a server folder is recorded before its first rename, and start-up settles a record left by a death in between (the restore record).
12. Console input and countdown warnings reach only a server that has loaded: its own Done line, or an active unit under a custom start command. A stop without a warning may end a start that is still waiting for that line, and nothing else may end the wait.

## Layout (the source is the truth)

`src/server/`: `config/`, `db/` (open, migrate), `gate/` (session, identity), `authz/` (capabilities, routes, authorize), `audit/`,
`api/` (app, guard, handlers, streams), `servers/` (store, unit render, service, state), `power/`, `console/`, `files/` (jail, history),
`backups/`, `schedules/`, `plugins/`, `alerts/`, `control/` (update socket), `privileged/`, `health/`, `access/`, `systemd/`, `main.ts`. `src/shared/`: wire schemas. `web/src/`: `api/`, `components/`, `features/`, `lib/`.
`test/`: `fixtures/` (captured real output), `support/`.

## Where facts live

| Question | Look at |
|---|---|
| What does Paper / systemd / the journal actually print? | `test/fixtures/` and its READMEs |
| What is verified and what is only assumed? | `docs/DESIGN.md` §12 |
| What may not be built? | `docs/DESIGN.md` §13 and the size budgets in §14 |
| What is the next piece of work? | `PLAN.md` |
