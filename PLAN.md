# JASS Panel: work queue

This file is a work queue, not documentation. It lists what is still to do and nothing that has landed. `docs/DESIGN.md` is the
architecture of record, `CLAUDE.md` holds the working rules, and `docs/DEPLOYMENT.md` says what is verified. Delete items as they
land; clear this back to the skeleton when it is empty.

## Where things stand

The hardening findings from the last review are fixed and tested in one pass: the update step's check time and audit reason, the restore
aside folder and record view, the removal's late-start check, the events stream's stale marker, the journal cursor and its no-match exit
code, the start-up sweep of temporary files, the identity and firing caps, console back-pressure with one shared reader per log, grants and
the events file read once per request, the tri-state start outcome, the history totals, the unparseable state event, the lost upload
response, the 408 in the panel's envelope, and the Paper save-messages warning on the Health screen. Discord posting is not connected (owner
decision). Typecheck, lint, the test suite and the production build pass. A signed-in walkthrough and a simulation of Phase 7 ran in
`TEMP_TEST`; `docs/RUNBOOK.md` records them. What has not been run on a live Paper server or through the real proxy is listed below.

## Rules for every change

- The panel itself never needs root. Agents do not use `sudo` unless the user hands over the credential in the current session
  for a named job; then it is kept in a 0600 file outside the repository, fed to `sudo -S` on standard input, never written to a
  repository file, command line, log or test, and the file is deleted when the job is done. No test uses `sudo`. Agents never touch
  a real game server, the real proxy configuration, or units the user did not ask about.
- Read-only git only. No commit, push, branch, stage, reset, stash or `git init`.
- Every test uses its own temporary directory. A test that creates a user unit gives it a unique `jass-test-` prefix and removes
  it in `finally`. A test never names a real unit or a real server directory.
- Gates before calling anything done: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.
  A failure that reproduces is a defect; one that does not is rerun and recorded.
- Subprocesses are `execFile`/`spawn` with an argv array and `--` before data-derived operands. No shell strings.
- No secret in a log line, error, audit row, API response or client bundle.
- Comments explain why. No comment, doc or commit refers to AI agents, reviews, or this file's phases.
- Hardening pass (`hardening-analyst`) on every design and again on every phase's diff, before it is called done. Its findings
  become acceptance criteria below.

## Open work

### Blocked: Phase 7 on the live servers

Needs the live Test server and the real proxy, which agents never touch. `docs/RUNBOOK.md` records the simulation in `TEMP_TEST`. Still to do,
by a person:

- Check that the Test server's world loads on the Paper build it will run. The copy in `TEMP_TEST` did not: its world-gen settings are
  missing, so Paper stops while starting.
- The smoke checklist on the Test server through the real proxy.
- Moving the other servers one at a time, as the runbook describes. The user retires the old units.

### Not verified on a real machine (and why)

- Lingering across a real reboot. The owner has skipped this check for now.
- The signed-in walkthrough ran against a copy of the website with a test owner account, through the calls the screens make. A browser did
  not drive the screens, and the live website was not used.
- The start's wait for Done, a stop ending that wait, and the countdown's warnings and cancel on a live Paper server. The tests use a fake
  Paper; the journal line format comes from a captured Paper run.
- The real-unit countdown test timed out three times across full-suite runs while the scratch Paper server was live and loading the machine.
  It passed alone, on rerun, and on the final run after the scratch server was removed. Recorded as unexplained load, not a defect.

### Accepted from review, not fixed

- An update's log is rewritten in place by the events watchdog once it passes 1,000 lines; an event appended in the moment between
  the read and the write is lost. Only the events beyond the kept window are affected.
- A log opened by name for the console tail can be swapped between the size check and the open during a rotation, mixing two files for
  one read. The tail then restarts from the top on the next poll.
- A backup whose checksum or row insert fails after the archive is in place leaves that archive unrecorded (no data is lost; pruning
  walks rows only).
- A failed add leaves its enable link to the removed unit in place; systemd ignores a missing unit.
- A start issued by hand during a server's removal can run unmanaged after its record is gone. The panel reads the unit once more after the
  removal and records a `server.remove.late-start` row for the person to stop it. It cannot hold systemd off.

### Open findings, not yet fixed

- A backup or restore that fails for an unexpected reason records the error's name only; a restore failure records no reason at all.
- The countdown's echo window in `power/warnings.ts` measures on the wall clock, so a clock step changes how long it waits.
- The audit table has no retention. Each `not_sent` alert adds a row, at most one per server and kind per ten minutes while the incident lasts.
- An identity lookup beyond the eighth concurrent one is refused, and the firing it belonged to then reports the website as unconfirmed,
  which is misleading. The refusal should name the cap instead.
- The session gate reads the website's answer without a size bound. The accounts client has one, and the same bound belongs here.
- A grantee who is no longer an owner or admin on the website shows as a raw id on the Access screen, and the panel's record of people it
  has seen is never pruned, so the fallback can list an account the website has removed.
- The update-on-start setter does not put the unit back when its database write fails after the unit has been rewritten. This is existing
  code, outside the start-with-the-machine change.

### Decided, confirmed by the owner

- Grants are OWNER-only, or made by a panel operator, who has the owner's abilities; a firing that meets a lock is skipped; ADMIN panel access needs a grant row; the start-time update borrows the
  start's lock; Paper jar updates are not built now.
- The guard runs before the request body is read, for every route (the recommended option).
- `docs/DESIGN.md` may run 6 lines over its 500-line budget (506 lines, section 14).
- A countdown is cancelled by the person who started it. A start without `Done` after five minutes is reported as not finished, with the unit left running.
- A stop may end a start that is still waiting for its Done line (owner, this pass).
- The daemon's source size is not enforced for now: the owner suspended the 7,000-line approval, and the budget in DESIGN section 14 is not enforced until the owner sets one (owner, this pass).
- Any holder of power may cancel a scheduled countdown; a person's own countdown only by the person who started it (owner, this pass).
- A custom start command is loaded while its unit is active, with no Done wait (owner, this pass).
- Removing a server deletes its grants, so a server added later under the same id starts with none (owner, this pass).
- Plugin sources are per server: up to 8 repositories, each with its own optional token and up to 16 plugins, and a plugin name is listed
  once across the server. The owner asked for several repositories per server; the limits are the panel's choice, and the owner may change them.
- The owner can make an ADMIN account a panel operator (`panel.operator`, a wildcard grant). An operator has the owner's abilities, exactly, on every server, present and future, until the owner removes the status. Operators can also write grants and make or remove other operators (owner, this pass).
- A grant change or a removed server closes the affected open streams at once (owner, this pass).
- A plugin jar's version may carry a qualifier such as SNAPSHOT or `_1`, but it must start with digits, so `jass` does not take `jass-2fa-1.0.jar` (owner, this pass).
- Discord posting is not connected for now: each incident is recorded in the audit log as not sent, the webhook form stays out of the settings screen, and the stored address and the code remain (owner, this pass).
- The panel works with the website's existing accounts, on a website that has been live: nothing is re-created or migrated, and the Access
  screen lists the website's OWNER and ADMIN accounts to an owner or a panel operator, asked with their own cookie from
  `/api/panel/accounts`; anyone else with access.manage sees the people the panel has seen. The panel's record of
  people it has seen is the fallback, and the screen says when it is in use. The list only offers people for grants; grant rows and the
  session answer decide access (owner, this pass).
- The account list is not restricted further: panel operators receive it, because an operator holds every power an owner holds (owner).
- The website's contract is identity plus the account list for the Access screen, and the owner has confirmed that boundary (owner).
- Start with the machine is a per-server choice, set when a server is added and changed on its page by a person with the server's
  `settings` capability. A ticked server's unit is enabled, and an unticked one is not. Servers that existed before the choice keep the
  enabled units they had (owner).
- A plugin check that finished with a failed plugin holds the next check back for one minute, then two, four and eight minutes, and ten
  from then on, while such checks repeat in a row. A clean check holds it back for ten minutes (owner).

## Decisions settled

- The panel is a separate daemon beside the website; the website supplies identity only (`/api/panel/session`, and
  `/api/panel/identity` for scheduled actions). Both exist and are tested in the website repository.
- Servers are systemd user units the panel writes. The panel and the servers run as an ordinary user; no polkit rule, no
  sudoers entry, no stored privilege. Setup steps that need root are a closed catalogue of actions, each confirmed with the account's
  password on the spot (user decision: the web UI may ask for the password).
- It must work on any Linux with systemd, Node 22 and a reverse proxy, with no particular account name or directory.
- The installer takes one input, the website's URL, and changes no game server and no proxy file.
- Servers are added from the web UI after the panel is running.
- In-game `/restart` is supported as an opt-in per server, and plugin updates run on every start when a server has them enabled.
- Features wrap OS tools; there is no job engine, no root broker, no driver layer, and no rehearsal harness.
- The hardening library is curated (cap 55 patterns), not append-only. It holds 42 patterns now.
- A scheduled firing that failed after it began is a failure and alerts. Only a firing refused before it began is recorded as skipped.
- A server not made from the Paper preset (its start command is custom) prints no Done line, so it is loaded while its unit is active.
- A scheduled countdown is cancellable by any holder of power on the server, on the server page; a person's own countdown only by the
  person who started it.
- Removing a server deletes its grant rows and its loaded marker in the same transaction as its row.
- A scheduled start or restart that the server never reports as loaded is a failure that alerts: the start began, so it is not a refusal.

## Open questions for the user

- A person who holds only a server's `settings` capability can make the server start with the machine without holding `power`. DESIGN
  records that capability for this choice. Confirm that it is intended, or give the choice its own capability.
