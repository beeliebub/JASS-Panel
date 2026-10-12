# JASS Panel: design

A web control panel for Minecraft servers that run on the same Linux machine as the JASS website. People sign in to the
website; the panel asks the website who they are, then lets an OWNER or a granted ADMIN start, stop, watch, edit, back up and
schedule the servers. This is the architecture of record.

## 1. Principles

These exist because the first attempt failed by growing. They are the tie-breakers for every later decision.

1. **Wrap the operating system; do not reimplement it.** Lifecycle is systemd, backups are `tar`, restarts after a crash are
   `Restart=on-failure`, logs are the server's own `latest.log`. The panel decides *whether* and *when*; the OS does the work.
2. **No durable job engine.** An action runs and finishes. State that must survive a daemon restart is limited to the database
   rows below and a few marker files (section 8). Anything needing more is questioned before it is built.
3. **Servers outlive the panel.** Each server is its own systemd unit. Restarting, upgrading or losing the panel never touches a
   running server.
4. **Runs as an ordinary user, on any Linux.** The daemon and the servers never run as root, and there is no polkit rule, no
   sudoers entry and no stored privilege. The rare setup step that needs root is a fixed action the person confirms with their
   password on the spot (section 11). No particular account name or directory: every path is configuration or an input in the UI.
5. **Unknown is not a safe value.** If systemd, the website or a file cannot be read, the answer is "unknown", never "stopped",
   "healthy" or "0 players", and unknown never grants access.
6. **Small on purpose.** Budgets are in section 14. A module past 400 lines is split or justified.

## 2. Requirements

| Needed | Why |
|---|---|
| Linux with systemd (user instances, `systemctl --user`) | server lifecycle |
| Lingering enabled for the account that runs the panel | user units start at boot and survive logout; the installer or the panel's "Enable lingering" action sets it |
| Node.js 22.12 or newer | the daemon |
| A reverse proxy in front of both the website and the panel (Caddy today) | one origin, TLS |
| The JASS website, running, with `/api/panel/session` and `/api/panel/accounts` | identity; the Access screen's account list |
| `tar`; `zstd` optional (gzip is the fallback) | backups |
| A Java runtime, only for servers that need one | the panel resolves the `java` binary when a server is added |

Not needed: a particular distribution, a user called `ubuntu`, Docker on the panel side (the website may run in Docker), root.

## 3. Shape

```text
 Browser ──HTTPS──▶ reverse proxy ──┬── /panel/*  ─▶ 127.0.0.1:PANEL_PORT   jass-panel (Node, user unit)
                                    └── everything else ─▶ 127.0.0.1:3000   the website

 jass-panel ── GET /api/panel/session (forwards the browser's Cookie) ──▶ website        identity
            ── POST /api/panel/identity (loopback, no cookie) ──────────▶ website        scheduled actions only
            ── systemctl --user …            ─▶ one user unit (+ stdin socket) per game server
            ── write a line to the unit's stdin FIFO ─▶ console commands
            ── read <server dir>/logs/latest.log ─▶ console, chat, players
            ── tar / zstd ─▶ backups          ── fetch ─▶ GitHub releases (Discord posting not connected)
            ── SQLite (<data dir>/panel.db)
```

One daemon, one process, one database file. The UI is a React single-page app built with Vite and served by the daemon under
`PANEL_BASE_PATH`. The panel and the website share an origin, so the website's session cookie reaches the panel.

Stack: Node 22+, TypeScript (strict, ESM), Fastify, `better-sqlite3`, Zod, `croner`, React, Tailwind, Vitest.
OS access goes through two seams only, `run(argv)` for subprocesses and `fetch` for HTTP, so tests substitute them; everything
else uses Node directly against temporary directories. There is no driver layer.

## 4. Identity and the website contract

The daemon has no login. For every API request and every stream revalidation it calls the website's
`GET {SITE_INTERNAL_URL}/api/panel/session`, forwarding the browser's `Cookie` header verbatim and nothing else. The Access screen's list of accounts is asked the same way from `/api/panel/accounts`, for an owner or a panel operator only; the list only offers people for grants and never decides access.

| Website answer | Meaning |
|---|---|
| `200 { data: { user: { id, email, name, role } } }`, role `OWNER` or `ADMIN` | the caller |
| `401`, or no usable session cookie (no call is made) | not signed in: the UI sends the person to `/login?next=…` |
| `403`, or any other role | signed in, no panel access |
| anything else: timeout, network error, 5xx, malformed body | **unavailable**; never access, never a redirect |

Rules: no identity header from the client or the proxy is ever trusted. A positive answer is reused for 5 seconds; a definite
401/403 for 2 seconds; unavailable is never remembered; mutating requests always check fresh. Open streams are revalidated every
10 seconds, at once when the person's grants change or a server is removed, and closed when the answer
changes. The daemon listens on loopback only. Mutating requests must carry
`X-Panel-Request: 1` and an `Origin` equal to `PANEL_PUBLIC_ORIGIN`, and every request's `Host` must be the public host or
loopback (a DNS-rebinding guard).

**Protecting the website from the panel.** The gate is the one place an unauthenticated caller can make the daemon call the
website, so it is bounded: a request with no session cookie never causes a call; at most 8 website calls are in flight at once
and the rest are answered `unavailable`; and stream revalidation draws on its own allowance, so a flood of invented cookies can
neither starve it nor close the streams of people who are signed in.

**Scheduled actions** have no cookie. Each firing calls `POST {SITE_INTERNAL_URL}/api/panel/identity` with the schedule creator's
user id (loopback only, answered `user: null` when the person is gone or no longer OWNER/ADMIN), then re-checks the creator's
current grants. If the website is unreachable, answers with anything but a well-formed reply about that creator (a 5xx, a timeout, a
malformed body), or the creator no longer qualifies, that firing is skipped and recorded; there is no pending queue and no catch-up.
Pausing the firing until the website answers was considered and not built: a firing that waits can run after the situation that
justified it has changed. Both website endpoints already exist and are tested in the website repository.

## 5. Authorization

`authorize(user, capability, serverId?)` is the only permission check. No other module compares a role string or reads the
grants table. A route table declares each route's capability; a test fails if a route has none.

- **OWNER** holds every capability on every server with no rows.
- **ADMIN** holds exactly what a grant row allows: `(user id, server id or *, capability)`. `*` means every server, including
  ones added later. Grants are keyed by the website's `User.id`. A panel operator is an ADMIN with the wildcard row `panel.operator`: it holds every server
  capability on every server, present and future, and every panel capability: the owner's abilities, exactly (see below).
- Writing a grant is reserved to the OWNER role, or to a panel operator, who has the owner's abilities. `access.manage` lets an ADMIN see the grants and the access screen but not change
  them. This keeps the power to hand out panel-wide access with the owner, as the original requirement stated, and is recorded here
  because the table above reads as if every capability can be delegated. Making or removing a panel operator is a grant write, so it
  is owner-only too, or a panel operator's.
- A server capability asked about "no server" is denied for everyone; a handler that forgot its server must fail closed.
- `server.view` follows from any other grant on that server.

| Server capability | Allows |
|---|---|
| `server.view` | state, console history, players |
| `console.read` | live console and chat |
| `console.send` | run any command, including `op` (**high risk**) |
| `power` | start, stop, restart (with countdown); cancel a countdown: a person's own (for its starter) or a scheduled one (for any holder of power) |
| `files.read` / `files.write` | browse and read / edit and upload (`files.write` is **high risk**) |
| `backups` | create, restore, delete backups; clear a stuck restore record; remove a leftover folder by typed name |
| `schedules` | create and change schedules; each action also needs its own capability at creation and at firing (**high risk**, because a scheduled `command` is console access) |
| `plugins` | set a server's plugin repositories, their tokens and the plugins taken from each; list a repository's plugins; check and apply plugin updates (**high risk**: it installs code the server runs, and it can name any GitHub repository, which then receives the token saved for it) |
| `players` | whitelist, kick, ban, pardon. `op` and `deop` need `console.send` |
| `settings` | display name, log path, memory preset, autostart. Not the start command |

| Panel capability | Allows |
|---|---|
| `servers.manage` | add and remove servers, and edit a server's start command or unit (**high risk**) |
| `access.manage` | see the grants and the access screen; writing a grant is OWNER-only |
| `settings.manage` | Discord webhook (stored, not connected), backup location and retention. GitHub tokens are set per server, under `plugins` |
| `audit.read` | the full audit log |
| `root.run` | run a privileged action from the closed catalogue; still needs the account's password each time (**high risk**) |
| `panel.operator` | the owner's abilities, exactly: every capability on every server, present and future, and every panel capability, including writing grants and making or removing operators (**high risk**: console, files and plugins run as the panel's account) |

Panel capabilities are one panel-wide row and imply nothing on any server. The panel operator is the one exception: its row is
panel-wide, and it implies every capability, as the owner does.

Panel access is not a grant. An OWNER reaches the panel with no row. An ADMIN needs at least one grant row, panel-wide or on any server, to reach
it; an ADMIN with none is refused with the no-access answer. There is no implicit panel access: a grant row counts only while its server exists, and removing a server removes its rows.

**The trust boundary is the operating-system account, not the server.** Every server and the panel run as one user. A
capability marked high risk can make code run as that user, which can read the panel's database and rewrite every unit file;
per-server scoping does not change that. The UI says so beside each of them, and granting one is a decision to trust that person
with the machine's panel account. This is accepted: separating the panel from the servers would need a second account and root.
It is why the panel stores as few secrets as possible and why `servers.manage` is a separate capability from `settings`.

## 6. Servers

A server is a row plus two generated files. Adding one is a form in the UI; nothing about servers is known at install time.

**Row:** `id` (slug `[a-z0-9][a-z0-9-]{0,31}`, also the unit name suffix, so it can never start with `-`), display name,
absolute directory, start command as an argv array, optional memory preset, log path (default `logs/latest.log`), `autostart`.
Every `systemctl` call puts `--` before the unit name, and lookups keyed by id use a `Map`, because `constructor` is a valid id.

**Start command.** The form offers a Paper preset (java, minimum and maximum memory with the minimum no larger than the maximum, jar file name, extra flags) or a custom
argv. The `java` binary is resolved to an absolute path when the form is saved and stored. The command is always an argv array
written to `ExecStart=` with systemd quoting; it never passes through a shell. The panel refuses a directory that does not exist,
is inside the panel's data directory, or is already used by another server.

**Generated units** (in `$XDG_CONFIG_HOME/systemd/user`, written atomically, followed by `systemctl --user daemon-reload`).
One function renders them. It rejects NUL and newlines in every value (a newline would add a directive), escapes `%` as `%%`
and `$` as `$$`, quotes each `ExecStart` argument, and puts only the id, never the display name, in `Description`. It is tested
with hostile names, directories and arguments, and its output is checked with `systemd-analyze --user verify`:

```ini
# jass-mc-<id>.service
[Unit]
Description=Minecraft server <id> (managed by JASS Panel)
After=network.target
Requires=jass-mc-<id>.socket
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=<directory>
ExecStartPre=-<update command>          # only when "update plugins on start" is on for this server
ExecStart=<argv>
ExecStopPost=-<data>/bin/stop-event <id>
Sockets=jass-mc-<id>.socket
StandardInput=socket
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=5
SuccessExitStatus=143
TimeoutStartSec=300
TimeoutStopSec=120

[Install]
WantedBy=default.target

# jass-mc-<id>.socket
[Unit]
PartOf=jass-mc-<id>.service

[Socket]
ListenFIFO=%t/jass-mc-<id>.stdin
SocketMode=0600
RemoveOnStop=true
```

Each choice is backed by a captured fixture or an experiment on a real Paper (section 12):

- `SuccessExitStatus=143` makes a stop a success; `Restart=on-failure` restarts a crash but leaves a stop and an in-game `/stop`
  alone; the unit is enabled so its exit data is kept.
- `PartOf=` on the socket is essential. Without it, stopping the service leaves the socket and its FIFO alive, and a write to the
  FIFO **starts the stopped server** (socket activation) and queues the line to run at boot. With it, stopping the service stops
  the socket and removes the FIFO.
- The start limit makes a crash loop end as `failed` instead of looping forever, but it counts *every* start. So the panel runs
  `systemctl --user reset-failed` before any person-initiated start, and the in-game restart handoff does the same. After a
  start-limit failure systemd can leave the FIFO file behind, and `ListenFIFO` then refuses to open an existing path; the panel
  removes a leftover FIFO only when the socket unit is not active.
- `ExecStopPost` runs the panel's constant `stop-event` script (written by the panel into `<data>/bin`, never built from data),
  which appends one line to `<data>/events/<id>.log` from the environment systemd provides: `SERVICE_RESULT`, `EXIT_CODE`,
  `EXIT_STATUS`. That is exact and survives the panel being down; see "State". It is prefixed `-` and the script always exits 0,
  because a failing `ExecStopPost` turns an otherwise clean exit into a failed unit. The daemon trims each events file to its last
  1,000 lines after reading it.
- `TimeoutStartSec=300` because the optional `ExecStartPre` update counts against the start timeout (the default is 90 s).

The panel records a digest of each file it writes and shows a warning when a unit has been edited by hand; it never overwrites a
drifted unit silently.

**State** comes from one `systemctl --user show` call covering every server (`ActiveState`, `SubState`, `Result`,
`ExecMainStatus`, `NRestarts`, `MainPID`, `ActiveEnterTimestamp`, and `MemoryCurrent` when the manager reports it), every 3
seconds while someone is watching and every 15 otherwise, pushed to open streams on change. When the call fails the state is
`unknown`.

**How a unit ended** comes from the `stop-event` lines, not from polling. Captured on a real Paper: a panel stop is
`result=success code=exited status=143`, an in-game `/stop` and `/restart` are `result=success code=exited status=0`, and a kill
is `result=signal code=killed status=KILL`. A crash is any line whose result is not `success`. `NRestarts` and a 3-second poll are
not used for this: `NRestarts` was observed reading 0 after an automatic restart, and a crash's `auto-restart` window is only
`RestartSec` long. The poll still reports the state shown in the UI (`failed` with `Result=start-limit-hit` is how "gave up
restarting" is seen). The daemon remembers the last event it handled and reads missed lines on start, so a crash that happened while
the panel was down still alerts once. A panel stop, an in-game `/stop` and `systemctl stop` are not told apart and raise nothing.

**Power.** `start` and `stop` map to `systemctl --user start|stop` (stop is SIGTERM; Paper saves and exits, about half a second on
an idle server). A start first runs `reset-failed` and removes a stale FIFO as described above. `restart` is stop then start. A start returns
once Paper prints its `Done` line; until then the UI shows the server as starting and console commands are refused. If five minutes pass without
the line, the start is reported as not finished loading and the unit is left running. A start whose systemctl reply never came, or whose journal could not be read at the deadline, is reported as unknown instead: the unit's state is read once, and anything short of loaded is unknown, so the page does not invite a second start. A scheduled start or restart that is not reported as loaded is a failure: it is recorded as failed and alerts.
A countdown, for stop and restart, is chosen in the confirmation as none, 30, 60, 120 or 300 seconds. It sends `say` lines at the full
countdown and at fixed marks below it (60, 30, 10, 5, 4, 3, 2, 1, where smaller), then acts. The operation lock is held throughout. Every
warning must be delivered and echoed in the server's log within ten seconds, or nothing further is done and nothing is stopped. Before each
later warning, and again before the stop, the main process must be the one seen before the wait: a write into the socket of a server that
stopped on its own would start it again. At the end, the person who began the countdown must still hold the power capability. A countdown
can be cancelled by the person who started it, while that person still holds the power capability, before the stop: the players are told it was cancelled, the audit row says so, and the
countdown's own request answers `cancelled`, not as a failure. A scheduled countdown can be cancelled by any holder of power on the server, and the audit row names who did. A cancel names the countdown it cancels, by the id the page was shown: a countdown that has ended, or been replaced by another, is refused and nothing is cancelled. A daemon restart or shutdown abandons the countdown; the server keeps running
and the players are told. Scheduled stops and restarts may take a countdown of the same lengths under the same rules. Stop and restart ask
for confirmation in the UI. A stop without a warning may end a start or restart that is still waiting for its Done line, and nothing else may end that wait. The lock passes from the start to that stop in the same step in which the start releases it, so no other request can take the server between them. A plugin update that runs inside the start counts: while it runs the wait cannot be ended, and once a stop has claimed the wait no update may begin. The stop's audit row records an interrupted load only when the start was cut short. A server whose start command is not the Paper preset prints no Done line, so it is loaded while its unit is active.

**Removing a server** needs its service stopped. Each of the two units is read by name, and the removal is refused when the service is neither inactive nor failed, or when systemd cannot be asked. A socket that still listens is stopped before any file is touched, since a write into it would start the server again, and a socket that systemd will not stop refuses the removal. Then the service is disabled and the state is checked again, and only then are the two unit files deleted, the grants and row deleted in one transaction, and the loaded marker removed. A removal that an earlier attempt left part way is finished by the retry: a unit file that is already gone is accepted, and one still present must match what the panel wrote. It never touches the server's directory: the world and plugins stay where they are. The same applies when an operator removes the row by
hand. The directory is the operator's, and nothing the panel does to it is recoverable by the panel. It is refused while the server has an unsettled restore record, since that record names the folders its data is in.

**Health panel.** The panel reports what it depends on, so a machine that cannot work says why: systemd version (with a warning below 259), user manager
reachable, lingering enabled (without it units do not start at boot and the stdin FIFO's runtime directory is removed at
logout), data directory writable and free space, website reachable, `tar`/`zstd` present, each server's `java` still resolvable.

**Restart and plugin updates.** Both start paths, the panel's and the server's own, end in the same place: a unit start. So
updates hang off the start, not off either caller.

- With "update plugins on start" on, the unit has `ExecStartPre=-` running a small command that asks the daemon, over a unix
  socket in the data directory (mode 0600, same user only), to update that server and waits up to two minutes. The leading `-`
  means a failed or skipped update never blocks the start, exactly as the old restart script behaved. Because the daemon holds the
  database exclusively, the command cannot open it itself; if the daemon is down the update is skipped and the server starts.
  The update request is allowed while that server's own power operation holds the lock (otherwise a panel restart would wait on
  itself) and refused while a backup or restore holds it. The socket accepts that one request only, and the daemon honours it only
  while that server's unit is `activating` (inside `ExecStartPre`), so a plugin running as the same user cannot trigger updates at
  other times. The command's own deadline (two minutes) is below `TimeoutStartSec`, because a timeout inside `ExecStartPre` fails
  the start even with the `-`. The command gives up after two minutes, but the update it asked for runs on in the daemon and may outlive the start that began it; until it ends the server is busy, and only one update runs at a time. An update checked within the last 10 minutes is skipped, so a crash loop does not hammer GitHub, and
  a crash restart waits for the update step, which adds to its downtime by design.
- An update covers every plugin the server names, from every repository it names, and each plugin is reported on its own. A plugin that
  fails, or a repository whose release cannot be read, does not stop the others or the start. The audit row names what was updated,
  what was already current and what failed, and never a token.
- **In-game `/restart`** is opt-in per server ("Enable in-game /restart" in settings). The panel writes `restart-handoff.sh` into the
  server directory and points `restart-script` in `spigot.yml` at it, showing the change first and keeping a history copy of
  `spigot.yml`. Paper runs that script after the JVM has shut down, as a child in the unit's cgroup, which systemd kills when the
  main process exits, so the script's whole body is a `systemd-run --user --collect --no-block` that starts, outside the cgroup,
  `systemctl --user reset-failed <unit>` followed by `systemctl --user restart <unit>`. Three consecutive `/restart`s were observed to
  restart the server each time, with the update step running before each new start.
- A crash restart (`Restart=on-failure`) runs the update step too.

**Existing servers.** A server already running under some other manager is moved by adding it here with the same directory and
command, stopping the old service by hand, and starting the new unit. The panel warns if the port in `server.properties` is
already listening and says so and points to the journal; it does not show the journal's lines.

## 7. Console, chat and players

- **Output:** the panel tails `<directory>/<log path>`. It tracks inode and offset, restarts from the top when the file rotates
  or shrinks, caps a line at 8 KiB (cut and marked), holds back a partial last line and a split UTF-8 sequence until they
  complete, and streams to the UI over SSE. The event id is `inode:offset`, so an offset is never applied to a rotated file;
  after a rotation the stream restarts from the top and marks those lines `replay`, which the UI shows as history, never as
  something that just happened. Lines are classified by shape (chat, join/leave, death, advancement, warning/error, crash marker) with parsers pinned to
  `test/fixtures/latest-log`. The journal is read only to see whether a run has printed its Done line (section 6).
- **Input:** a command is one line, written to the unit's stdin FIFO with a single `write()` that includes the newline (writes
  under the pipe buffer size are atomic: two concurrent senders wrote 300 lines and all 300 arrived intact). The panel writes only when the unit is `active` and has loaded, opens the path with `O_WRONLY|O_NONBLOCK` and **never `O_CREAT`** (a missing FIFO must fail, not
  create a regular file), and checks with `fstat` that it opened a FIFO. A failed open or write is reported as "not running or not
  accepting input", never as success, and a successful write means "delivered", not "done". The panel rejects control characters
  (including U+2028 and U+2029) and anything over 1,024 bytes. There is no restricted-command mode: `console.send` is full control.
- **Composed commands.** When the panel builds a command from fields (`whitelist add`, `kick`, `say`), each field is validated as
  a token: player names match `[A-Za-z0-9_]{3,16}`, free text has no control characters and a length cap, and any JSON for
  `tellraw` is built with `JSON.stringify`. A composed command needs at least the capability that typing the same command in the
  console would need, which is why `op` and `deop` are under `console.send`.
- **Chat:** the same log, filtered to chat lines. Sending chat is `say`/`tellraw` through the console channel.
- **Players:** the online list is derived from join and leave lines since the unit's current start (reset when the invocation
  changes) and is **approximate**: a rotated log or a panel restart mid-session loses lines. It is shown as approximate, and no
  automation (skip-if-empty, restart warnings) depends on it. Reading `whitelist.json`/`ops.json` for display goes through the
  file jail.

## 8. Features and what they wrap

| Feature | Implementation | Recovery / safety |
|---|---|---|
| Files | The file jail (below), CodeMirror editor for text, and upload of one file of at most 256 MiB, stored byte for byte; an upload may replace a file | before an overwrite the old content is copied to `<data>/file-history/<server>/`: the last 10 versions per file and no more than 512 MiB per server, oldest pruned first; a file larger than the cap cannot be replaced. Writes and copies run asynchronously. A second write to the same file is refused while one runs, and a restore is refused while any write runs |
| Backups | Check free space, write the marker, `save-off`, `save-all flush`, then **wait for the `System chat: Saved the game` log line**, `tar` (zstd, else gzip) into a temporary name in `<data>/backups/<server>/`, `save-on` and wait for `System chat: Automatic saving is now enabled`, rename the archive to its final name, record its sha256. Keep the newest N (default 7) successful backups, pruned only after a new one succeeds | A missing confirmation fails the backup: unknown is not "saved". `save-on` is sent in `finally`. The marker `<data>/markers/<server>.save-off` is written before `save-off` and removed only after `save-on` is confirmed; on start the daemon sends `save-on` to every server that has a marker and alerts if it never confirms |
| Restore | Server must be stopped, and the archive must be listed in full (a listing that fails or is cut short refuses the restore). Verify the archive's sha256, refuse any member that is absolute, contains `..`, or is a link; extract beside the server folder; move the current folder to `<name>.before-restore-<stamp>` (skipped when the folder is already gone), then the restored tree into place | nothing is deleted; leftovers are the restore's own folders, listed by exact name, and removed only by typed confirmation under the server's lock |
| Schedules | rows in the database, fired by `croner` in the daemon, at most four at a time (a firing beyond that is skipped and recorded) and at most 20 to a server: `start`, `stop`, `restart`, `backup`, `command`. Each has an IANA time zone | a firing re-authorizes its creator (section 4); missed firings while the daemon was down are skipped and shown, never replayed; a firing that meets a held operation lock is skipped and recorded |
| Plugin updates | on demand from the UI, and on every start when "update plugins on start" is on (section 6). For each repository a server names (`owner/name`, with an optional token), read the newest release. Then, for each plugin the server names, take the release's jar of that name: the most recently uploaded jar whose name is the plugin followed by a version, matched without case. Download it through the release asset's API address, check its sha256 against the digest GitHub publishes, move it into the plugin directory atomically once the file under its name is still the one written, and remove the other jars of that plugin: the regular files named `<plugin>-<version>.jar`, matched without case, where the version starts with digits and may carry a qualifier such as `SNAPSHOT` (so `jass` does not take `jass-2fa-1.0.jar`). A jar already in place with the published digest is not downloaded again | A repository name is `owner/name` with no `.` or `..` segment, and a plugin name is letters, digits, dashes and underscores. A plugin name is listed once across a server, and a server names at most 8 repositories with 16 plugins each. The jar name must match `^[A-Za-z0-9._-]+\.jar$`. A release with no digest is refused. The token goes only to `api.github.com` over https, and every redirect must be https; a redirect is followed by hand without the token. A downloaded jar replaces the one in place only once its digest matches. A failed plugin leaves its old jar in place, and never stops another plugin or a start. A directory, pipe or link under a jar's name fails that plugin rather than being read, removals touch only regular files, and a run starts no new repository or plugin after ten minutes |
| Alerts | Raised for: server crashed, gave up restarting, backup failed, schedule failed, and a restore interrupted at start-up. Once posting is connected, an incident is posted to a Discord webhook, at most once per server and kind per 10 minutes once delivered, and a failed post is tried again after 1, 2, 4 and 8 minutes, then every 10 minutes. While posting is not connected (owner decision), each incident is recorded in the audit log as `not_sent`, once per server and kind per 10 minutes. An incident resolves when it clears, so the next one is a new alert | The webhook must be `https` on `discord.com` or `discordapp.com` under `/api/webhooks/`, with no redirects (otherwise a person with `settings.manage` could aim the daemon at an internal address). The URL is never returned by the API. While posting is not connected, the settings screen does not show the webhook form |
| Audit | one row per mutating request, plus refused attempts (rate-limited): who, what, which server, outcome | written in the same transaction as the change when there is one; an external effect writes a started and a finished row |

**File jail.** Every path from a request is a relative POSIX path. It is rejected if it is empty, contains NUL or `..`, or is
absolute. The target (or, for a new file, its parent) is resolved with `realpath` and must stay inside the realpath of the server
directory; the final component is opened with `O_NOFOLLOW`. Listings are capped at 2,000 entries, reads at 2 MiB. A plugin or
person who can plant a symlink inside the server directory between the check and the open can race this; that is accepted
because it requires write access to the directory already.

**Restore record.** A restore writes `<markers>/<id>.restore` (server folder, staging folder, aside folder) before it moves anything, and
removes it when it settles. Start-up first removes the panel's own temporary files from each server folder, before anything can write there. Start-up settles a surviving record after the save markers and before schedules load: a folder in place is
left as it is; a folder moved aside with nothing in its place is put back; a record that does not match the server, or cannot be read,
touches no folder and alerts. A restore is refused while a record exists, when the server started after its archive was checked, and
when there is less than 1 GiB free. A restore into a missing server folder is allowed, and the 1 GiB check stays as it is. A record that cannot be
settled is cleared from the server's backups screen by a holder of `backups`, after checking the folders and typing the server's name; the
clearing is audited. It is refused while the server folder is missing and folders from the restore are beside it; the folders are read on disk, so an unreadable record cannot lower that bar.

**Operations lock.** A per-server in-memory lock stops operations that must not overlap. A second request gets `409 conflict`
naming the running operation; there is no queue. After a daemon restart the lock is empty, which is why the markers above are
the only durable record. What refuses what:

| Running | Refuses |
|---|---|
| backup | stop, restart, restore, another backup, plugin update (a server stopped mid-archive would be saved into an inconsistent archive) |
| restore | everything on that server, and the restore record clear and leftover removal |
| plugin update | stop, restart, restore, backup |
| power (start, stop, restart, countdown) | backup, restore, plugin update, another power action; a stop without a warning may end a start or restart that is waiting for its Done line |
| file edit or upload | the same file only; refused while a restore runs |

## 9. Data model

One migration to start, `NNNN_name.sql`, forward-only, each applied in a transaction with its checksum recorded. Start-up refuses
when an applied file was edited or is missing. Before applying a migration to a database that already holds data, the runner
writes a verified `VACUUM INTO` copy to `<data>/db-backups/` (mode 0600, because it holds the same secrets; the newest 5 are
kept). The database is opened with `locking_mode=EXCLUSIVE` before anything else is written, so a second daemon pointed at the
same data directory fails to start instead of running schedules twice.

| Table | Holds |
|---|---|
| `servers` | the server row from section 6 plus the unit digests |
| `grants` | `user_id`, `server_id` (or `*`), `capability` |
| `known_users` | id, email, name, last seen: only so the Access screen can show names; never used to decide access |
| `schedules` | server, kind, cron, payload, enabled, creator id, last run time and result |
| `backups` | server, file, size, created time, creator, kind, status |
| `plugin_sources` | one row per server and repository: the repository, the plugin names taken from it, the plugin directory, the token (see below) |
| `settings` | key/value: backup directory, retention count, Discord webhook (stored, not connected) |
| `audit` | time, user id and label, server, action, details, outcome |

Persisted JSON is validated on write and on read; a bad value is an error, never silently replaced.

**Secrets** (GitHub tokens, the Discord webhook) are stored in the database, which is created mode 0600 under the data
directory. They are never in environment variables, logs, audit details, API responses or the client bundle. Encrypting them with
a key kept next to the database would protect nothing against the same account, so there is no master key.

## 10. API and streams

REST under `PANEL_BASE_PATH/api/v1`. Success is `{ data }`, failure is `{ error: { code, message, details? } }` (codes in
`src/shared/api.ts`). Every request body and response is a Zod schema shared with the UI. Identity is checked before a request body is read, so an anonymous caller
cannot make the daemon buffer one.

Two kinds of stream, both Server-Sent Events: one **events** stream per tab (server states and countdowns, alerts, schedule results for the servers the person may view, as the latest check saw them) and one **console** stream per open console (log lines with resumable ids). A person may hold at
most 8 streams. The console stream sends `lagged` with the number of lines a slow reader lost (more than 2,000 behind), and a failed events read sends each server as unknown. Each stream re-checks identity and its grants every 10 seconds, and at once when that person's grants change or a server is removed.

## 11. Install, layout and operations

The installer is one short script that takes one input, the website's public URL. It checks the requirements, writes
`~/.config/jass-panel/panel.env` (kept if it exists), writes the panel's own user unit, runs `daemon-reload` and
`enable --now`, then **prints** the reverse-proxy snippet and the `loginctl enable-linger` line for the person to apply. It
never edits proxy configuration, the website, or any game server, and running it twice changes nothing the second time. Before
changing anything it checks that the user manager is reachable (`systemctl --user is-system-running`), lingering, Node's version
and that `tar` exists, and on any failure it stops and prints the exact fix. It also warns, without refusing, when systemd is older
than 259, the only version the units have been tested on.
Generated files (the unit, the proxy snippet, the environment file) are rendered from the same configuration the daemon reads,
so a port or base path has one source.

| What | Where |
|---|---|
| Daemon build | the checkout it was built in (`dist/`), or a directory the installer is told |
| Configuration | `~/.config/jass-panel/panel.env` |
| Data (database, backups, file history, markers) | `PANEL_DATA_DIR`, default `$XDG_DATA_HOME/jass-panel` |
| Unit files for the panel and for servers | `$XDG_CONFIG_HOME/systemd/user/` |

Upgrade is: update the checkout, `npm ci && npm run build`, `systemctl --user restart jass-panel`. The servers keep running.
Uninstall is: `systemctl --user disable --now jass-panel`, remove its unit and the directories above. Server units are the
operator's servers and are left alone unless removed from the UI.

### Privileged actions

Some setup needs root: enabling lingering, installing a Java runtime, later perhaps a firewall rule. The panel does these without
running as root and without keeping any privilege. An OWNER, or an ADMIN granted `root.run` (**high risk**: it is the machine), picks
an action from a **closed catalogue** in the code, sees the exact command that will run, types the sudo password of the account the
panel runs as, and the daemon runs it once.

- **Closed catalogue.** Each action is an argv template with validated parameters, never a free-form command. `enable-lingering`
  always targets the account the daemon runs as (taken from the process, never from the request). `install-java` takes a package
  name from an allowlist for the detected package manager. Adding an action is a code change with its own review.
- **How the password travels.** Over TLS to the daemon, in a body field that every logger, error serializer and audit builder drops by
  name. The daemon starts `sudo -S -k -p '' -- <argv>` and writes the password to its standard input, then zeroes its copy. It is never
  in an environment variable, an argument, a log line, an audit row, a response or a database column, and nothing is cached: `-k`
  forgets any ticket, so every action asks again and there is no `NOPASSWD`.
- **Brute-force and lockout.** The form would otherwise let someone guess the account's password. A wrong password counts against a
  panel-wide limit of 2 consecutive failures, then actions are disabled for 15 minutes and an alert is raised; the limit sits below the
  default account-lockout threshold of 3, so the Linux account is not locked out by the panel. Failures are audited without the value.
- **Same-origin phishing.** Admin-authored HTML on the website shares the panel's origin, so panel responses carry a strict
  `Content-Security-Policy` (no inline script), `frame-ancestors 'none'` and `Cross-Origin-Opener-Policy: same-origin`, which stops a
  website page from opening the panel and reading or scripting its DOM. The password dialog exists only inside the panel document.
- **Output.** The command's output is shown to the person, truncated and scrubbed, and kept out of the audit row. The audit row
  records who, which action, its parameters and the exit status.
- **Terminal install.** The install script, run by a person at a terminal, offers to run `sudo loginctl enable-linger <account>` itself
  after showing it, so the common case needs no web step.
- **Tests.** No test uses real `sudo`: a fake `sudo` on the `PATH` records its argv and standard input, and the tests assert the
  password never appears in any log, error or audit output.

## 12. Verified facts and open questions

Captured on a real Paper 26.3 build 141 under a user manager (systemd 259.5, Java 25.0.4, Ubuntu 26.04); see
`test/fixtures/systemd/README.md` and the fixtures listed in `test/fixtures/README.md`:

- A graceful stop of every kind ends `inactive/dead`, `Result=success`; only a kill is a failure.
- Paper as the unit's main process exits 143 on `systemctl stop`; without `SuccessExitStatus=143` that is recorded as failed.
- `Restart=on-failure` restarts exits 1, 137 and unaccepted 143, and does not restart exit 0 or an accepted 143. A `kill -9` of the
  JVM was back as a new invocation five seconds later (`RestartSec=5`) with the update step run first.
- A unit that is not enabled loses its exit data after a clean end.
- Journal output from a user-manager unit carries the console text without a thread name; `latest.log` carries it with one.
- A restart helper started with `systemd-run --user` escapes the unit's cgroup and survives the JVM; a plain child does not.
- **The stdin FIFO works.** With `StandardInput=socket` and `ListenFIFO` Paper accepts console commands with no terminal and no RCON.
  `list`, `say`, `save-all flush`, `save-off`, `save-on` and `tps` all executed; two concurrent writers delivered 300 of 300 lines
  intact.
- **Console replies reach `latest.log`**, shaped `[time] [Server thread/INFO]: System chat: Saved the game` (and
  `System chat: Automatic saving is now enabled` / `disabled`). They are not the bare RCON text. `say` appears as
  `[Not Secure] [Server] <text>`.
- Without `PartOf=` a write to the FIFO of a stopped server starts it (socket activation). With `PartOf=` stopping the service stops
  the socket and removes the FIFO, and opening the missing path without `O_CREAT` fails with `ENOENT`.
- The start limit counts every start, including a person's. Exceeding it fails the service **and** the socket, and can leave a
  stale FIFO that blocks the next start until it is removed and `reset-failed` is run.
- `ExecStopPost` receives `SERVICE_RESULT`, `EXIT_CODE`, `EXIT_STATUS` (captured for stop, in-game stop, kill and in-game restart).
- **In-game `/restart` works** through a `restart-script` that runs `systemd-run --user --collect --no-block` with
  `reset-failed` then `restart`: three consecutive restarts each produced a new invocation within about a second, with
  `ExecStartPre` run before each.
- `MemoryCurrent` is reported in a user manager here (`cpu memory pids` controllers are delegated).
- **Lingering on:** enabling lingering for an account with no session starts its user manager at once, and enabled units
  (`WantedBy=default.target`) start with it. A panel-shaped unit saw `XDG_RUNTIME_DIR=/run/user/<uid>` and could run
  `systemctl --user` against its own manager; a console line reached the server through the FIFO with nobody logged in; opening and
  closing a session did not touch the units; disabling lingering stopped the manager and sent the server a SIGTERM (clean exit 143).
- **Lingering off:** units start when the first session opens and keep running while any session exists. About ten seconds after the
  last session ends (`UserStopDelaySec`) the manager sends every unit SIGTERM and `/run/user/<uid>` is removed, FIFO included.
  Nothing starts at boot without a login. This is why the installer requires lingering and the health panel shows it.

**Checked on the same machine.** On the real Paper 26.3 build, a start through the panel ran the update step (answered, with the
release missing, and the start went ahead); a three-warning countdown was echoed in the log and the stop followed; a live backup
confirmed both save steps; a restore and a binary upload both checked out; a countdown was cancelled cleanly on a daemon stop, with
the players told. A warning sent while Paper is still loading fails inside Paper (a `NullPointerException` in the console `say`
handler), so a start returning at `active`, before `Done`, leaves a window; a start now waits for `Done` (section 6). On a start with update on start on, the five jars a server named were installed from the
repository's newest release, each matching the sha256 GitHub publishes for it, and a jar the server did not name was left alone. A
second repository with no release failed on its own, and the start still returned done. The token appeared in no response, log or
audit row.

**Not yet verified:**

1. **A literal reboot.** Lingering was verified by enabling it with no session, which is what systemd does at boot for a lingering
   account, but boot ordering (for example the network being up before a server's unit) was not exercised.
2. **`MemoryCurrent` on other machines**: depends on the cgroup controllers delegated to the user, and reads as an unset marker or
   the maximum integer when they are not; that is "unknown", not a number.
3. **Port conflicts** when a server is moved from an old unit to a new one.
4. **Installs on the production VPS.** The install from a release ran on this machine, against the JASS plugin repository, with a start and a
   manual update (see "Checked on the same machine"). The same run on the VPS, with its own token, has not been done.

Everything above was run on systemd 259 only. Older versions are untested; the installer says so and does not refuse them.

A real Paper 26.3 build 141 server (a scratch copy of a live backup, on alternative ports) was added through the panel, started,
given `save-all flush` through its FIFO (the save was confirmed in its log), and stopped through the panel. The stop ended
`result=success` with `execMainStatus=143`, as the table above records.

## 13. Deliberately out of scope

RCON (the stdin FIFO passed), a restricted-command console mode, suite restarts as a durable multi-server job, server
creation from a template, cloning, Paper jar download and promotion, a trash and retention engine, statistics history and charts,
crash-report parsing, adoption wizards, personal access tokens for the API, multi-user locking of files, running anything as root
other than the closed catalogue of privileged actions, a stored or passwordless sudo grant, and arbitrary root commands. Each can be added later as one feature if it is missed; none is a reason to add machinery now.

## 14. Size budget

| Part | Budget |
|---|---|
| Daemon source, excluding tests | 6,000 lines. The owner approved 7,000, then suspended the budget for now, so it is not enforced until the owner sets one |
| UI source, excluding tests | 6,000 lines |
| Installer | 150 lines of shell |
| This file | 500 lines (506 allowed by the owner) |

Passing a budget is a decision to make out loud, not something that happens during a feature.

## 15. Testing

- Pure logic (unit-file rendering and quoting, `show` parsing, log-line classification, the jail, `authorize`, migrations, the gate)
  is tested directly, with fixtures for anything parsed from a real program.
- Lifecycle is tested against a **fake Paper**, a small script that prints Paper-shaped lines from the fixtures, reads stdin,
  and exits 143 on SIGTERM, run under the **real** `systemctl --user` with uniquely named units that are removed in a `finally`.
  The suite skips those tests, loudly, on a machine with no user manager.
- Nothing is considered verified until the same flow has run on a real Paper server (a copy, then the Test server) through the
  real proxy. The fakes prove the plumbing, not Paper.
- Every test uses its own temporary directory and leaves nothing behind. Tests never touch the host's real units, proxy
  configuration, or any real server.
