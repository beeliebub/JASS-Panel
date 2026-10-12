# JASS Panel

A control panel for the JASS Minecraft servers, served at `/panel` beside the JASS website. From the browser you can start, restart and
stop each server, read its console, edit its files, take and restore backups, run schedules, install plugins from GitHub releases, and read
an audit trail.

The panel is one daemon that runs as an ordinary Linux user on the same machine as the website. Each game server is a systemd user unit that
the panel writes, so servers keep running when the panel restarts, and nothing needs root.

The panel has no accounts of its own. A person signs in on the website, and the panel asks the website who they are on every request. Passwords
stay in the website's database.

## Status

The daemon, the web app, the installer and the test suite exist and pass. The design and the decisions behind it are in
[`docs/DESIGN.md`](docs/DESIGN.md). What has been verified on a real machine, and what has not, is in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#verified-and-not-yet-verified). Read that section before relying on a feature on a live server.

## How it fits together

```
browser ──https──▶ Caddy (TLS, one public origin)
                    ├─ /panel and /panel/*  ──▶ 127.0.0.1:29200   the panel daemon (this repository)
                    ├─ /api/panel/*         ──▶ 404               refused at the proxy, never public
                    └─ everything else      ──▶ 127.0.0.1:3000    the JASS website

panel daemon ──GET  /api/panel/session    (the browser's Cookie, forwarded)──▶ website
             ──GET  /api/panel/accounts   (the browser's Cookie, forwarded)──▶ website
             ──POST /api/panel/identity   (scheduled actions only, no cookie)──▶ website
             ──systemctl --user──▶ one unit per game server (ListenFIFO for commands)
```

- Identity comes only from the website. The panel does not trust a header for it, and a website that cannot be asked means
  "unavailable", never access.
- An OWNER has every capability. An ADMIN has what its grants allow.
- The panel and the servers never run as root. The few steps that need root (turning lingering on) are a closed list, and each one asks for the
  account's password.

## Requirements

| Needed | Notes |
|---|---|
| Linux with systemd, and a user manager | `systemctl --user is-system-running` must answer `running` or `degraded`. Tested on systemd 259; the installer warns on anything older. |
| Lingering for the account | Without it the panel and its servers stop at logout and do not start at boot. See Install, step 4. |
| Node.js 22.12 or newer | `node -v`. The installer runs the `node` found on `PATH`. |
| `tar` | backups and restores |
| `zstd` (optional) | archives are `.tar.zst`; without it they are `.tar.gz` |
| A Java runtime, for Paper servers | the Paper preset takes the absolute path of `java` |
| The JASS website, on loopback | answering `/api/panel/session`, `/api/panel/accounts` and `/api/panel/identity`, on `127.0.0.1:3000` |
| A reverse proxy in front of both | Caddy today, one origin with TLS |

Nothing depends on a particular account name or directory.

## Install

These steps assume the website is already live behind Caddy, and that one Linux account will own the panel and the game servers. Run
everything as that account unless a step says `sudo`. They were tested on Ubuntu 26.04 with systemd 259, Node.js 22.22, OpenJDK 25.0.4,
Paper 26.3 build 141 and Caddy 2.11.6.

### 1. Install the requirements

On Ubuntu 26.04 the archive provides everything except Caddy:

```sh
sudo apt update
sudo apt install nodejs npm tar zstd openjdk-25-jre-headless
node -v    # must print 22.12 or newer
```

Caddy 2 comes from its own repository, because the archive's package is 2.6, older than the version the proxy rules were tested with.
See <https://caddyserver.com/docs/install>. Java is needed only for Paper servers. `zstd` is optional: without it, backups are `.tar.gz`.

### 2. Get the code

Clone the repository, or copy its folder, into the directory you will run the panel from. Choose the final location now. The installer
writes the checkout's path into the systemd unit, so if you move the folder later, run `scripts/install.sh` again from its new location.

### 3. Bring the website up to date first

The website must have the panel's routes before the panel can start. Its own deploy document (`docs/DEPLOYMENT.md` in the website repository)
has the steps: deploy the version with the panel routes, run its migrations and its pages-only seed, check for `/panel` page collisions, and
update Caddy as that document describes.

Check the website on loopback:

```sh
curl -i http://127.0.0.1:3000/api/panel/session
```

A `401` with a JSON body means the route exists and no cookie is signed in. A `404` means the panel routes are not deployed yet.

If the website has no OWNER account yet, create one on the website's machine, in the website's directory, with its own environment:

```sh
npm run create-admin -- <email> <password> --role OWNER
```

Run this only for an email that has no account yet. `create-admin` replaces the password and the role of an existing account; see
[Existing website and accounts](#existing-website-and-accounts).

The panel adds no environment variable to the website and needs no database change. `AUTH_URL` must already be the public HTTPS origin, as the
website's deploy document says; a wrong value makes the panel refuse every signed-in browser.

Existing accounts are not touched by any of this. See [Existing website and accounts](#existing-website-and-accounts) below before you run
`create-admin` on the website.

### 4. Turn lingering on

Lingering keeps the account's user manager running after logout and starts enabled units at boot:

```sh
sudo loginctl enable-linger "$USER"
```

The installer offers this when it runs in a terminal. The Health screen can do the same later, asking for the account's password. Check it with `loginctl show-user "$USER" -p Linger`, which prints `Linger=yes` once it is on.

### 5. Build the panel

```sh
cd /path/to/JASS-Panel
npm ci
npm run build
```

`npm run build` compiles the daemon to `dist/server`, with the database migrations beside it, and the web app to `web/dist`.

### 6. Run the installer

```sh
PANEL_PUBLIC_ORIGIN=https://example.net scripts/install.sh
```

Use the website's public origin, with no path. The installer:

- checks `tar`, `systemctl` and `loginctl`, Node.js 22.12 or newer, that the daemon is built, that the user manager is running, and that
  lingering is on;
- writes `~/.config/jass-panel/panel.env` with mode 0600, unless it already exists;
- writes `~/.config/systemd/user/jass-panel.service`, reloads the user manager, enables the unit and starts it;
- prints the proxy block, and does not change the proxy, the website or any server.

Running it again changes nothing if nothing has changed. An existing `panel.env` is kept. If you pass a different `PANEL_PUBLIC_ORIGIN`, the
installer says so and keeps the value in the file; edit the file to change it, then run `systemctl --user restart jass-panel`.

### 7. Add the proxy block

The website's Caddyfile must do two things before its default handler: refuse `/api/panel` and `/api/panel/*`, and import `/etc/caddy/conf.d/*.caddy` inside its site block. Confirm both first:

```sh
grep -n -E 'conf.d|api/panel' /etc/caddy/Caddyfile
```

You should see the import line, and a matcher for `/api/panel` and `/api/panel/*` answered with `respond 404`.

Then write the block the installer printed. Its port and base path come from `panel.env`:

```sh
sudo mkdir -p /etc/caddy/conf.d
sudo tee /etc/caddy/conf.d/jass-panel.caddy >/dev/null <<'EOF'
@panel path /panel /panel/*
handle @panel {
    reverse_proxy 127.0.0.1:29200
}
EOF
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Write the snippet before you reload Caddy: the `/panel` route exists only
once the file does. Caddy takes one matcher per `handle`, which is why the paths sit in a named `path` matcher. If you changed `PANEL_PORT` or `PANEL_BASE_PATH`, use the block the installer printed, which has your values.

### 8. Check it

Replace `example.net` with your public host in the `curl` commands below.

- `systemctl --user status jass-panel` shows `active (running)`, and `systemctl --user is-enabled jass-panel` prints `enabled`.
- `journalctl --user -u jass-panel -n 50` shows `panel listening on loopback` and no errors.
- `curl -I https://example.net/panel/` includes `Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `X-Content-Type-Options` and `X-Robots-Tag: noindex`.
- `curl -i https://example.net/api/panel/session` answers `404`.
- Signed out, `GET /panel/api/v1/me` answers `401` with `unauthenticated`. With the website down it answers `503` with `unavailable`, and
  neither answer ever redirects.

### 9. Sign in

Sign in on the website as an owner, then open `https://example.net/panel/`. The Servers page opens. If you are signed out, the panel sends you
to the website's sign-in page and brings you back afterwards.

### 10. Prepare the first server

The panel does not download Paper, and it does not write a server's `eula.txt` or `server.properties`, so prepare the server folder yourself:

1. Create the server's folder outside the panel's data directory, and put a Paper jar in it. Get the jar from <https://papermc.io/downloads/paper>.
2. In that folder, run Paper once by hand, for example `java -jar paper.jar nogui`. On its first run it writes `eula.txt` and stops.
3. Read the Minecraft EULA, then set `eula=true` in `eula.txt`. Accepting it is your decision; the panel does not do it for you.
4. Run the same command again. When the console prints `Done`, type `stop`.
5. Give the server its own port: set `server-port` in `server.properties`. Two servers that use the same port cannot both start, and the panel does not choose ports.
6. Add the server under Servers → Add a server, as described in [Adding a server](#adding-a-server).

## Existing website and accounts

The panel works with the accounts a live website already has:

- OWNER and ADMIN accounts keep their email, password, role and sessions. The panel reads them and never writes to the website's database.
- An OWNER signs in as before and is the panel's owner at once.
- An owner or a panel operator sees every OWNER and ADMIN account the website has on the Access screen, including accounts that have never
  opened the panel. The website is asked with that person's own session. If it cannot be asked, the screen says so and lists only the people
  the panel has seen. Anyone else with access.manage sees only the people the panel has seen.
- An ADMIN can still sign in to the website, but has no panel access until an owner grants it something. An ADMIN with no grant rows sees the
  "No access to anything yet" screen.
- Redeploying the website does not change its accounts. The website's pages-only seed does not touch users.

One command can change an existing account. `npm run create-admin -- <email> <password>` on an email that already exists replaces that
account's password and sets its role, which is ADMIN unless you pass `--role OWNER`. Pass `--role OWNER` only when you mean to reset an owner's
password; leaving it out turns an owner into an ADMIN.

The full checklist is in the panel's `docs/DEPLOYMENT.md`, under "Installing beside a website that is already live".

## Configuration

The installer writes the first four variables into `~/.config/jass-panel/panel.env` (mode 0600). Edit the file and restart the panel to change
them.

| Variable | Default | Meaning |
|---|---|---|
| `PANEL_PUBLIC_ORIGIN` | none, required | The website's public origin, for the `Origin` check and the `Host` check. An origin only, with no path. |
| `SITE_INTERNAL_URL` | `http://127.0.0.1:3000` | Where the panel asks the website who is signed in. Must be a loopback `http` origin. |
| `PANEL_PORT` | `29200` | The loopback port the daemon listens on. |
| `PANEL_BASE_PATH` | `/panel` | The URL prefix of the UI and API. It must match the proxy block. |
| `PANEL_DATA_DIR` | `~/.local/share/jass-panel` | The database, backups, file history, markers and event logs. |

No secret is an environment variable. Plugin access tokens and the Discord webhook address are stored in the panel's database, which is
created with mode 0600, and a saved token or address is never shown again.

## Using the panel

### Signing in and what you can see

The header shows your name and whether you are the owner, an operator or an admin. The pages are:

- **Servers**: every server you may see, with its state and Start, Restart and Stop buttons, and an Add a server button.
- **Access**: who holds what. It needs `access.manage`.
- **Audit**: the audit trail. Without `audit.read`, you see the rows about servers you can view.
- **Health**: the checks the panel depends on.
- **Settings**: how many backups to keep per server. It needs `settings.manage`.

If the website cannot confirm who you are, the panel shows "Sign-in cannot be checked right now" and changes nothing. It never guesses.

### Adding a server

Servers → Add a server. The directory must already exist, be an absolute path, and not be inside the panel's data directory. The panel never
changes anything in it.

| Field | What to enter |
|---|---|
| Id | Lowercase letters, digits and dashes; it starts with a letter or digit and is at most 32 characters. It names the unit files and cannot change later. |
| Display name | Up to 64 characters, shown in the list. |
| Server directory | The absolute path of the existing server folder. |
| Paper preset | The Java program (absolute path, default `/usr/bin/java`), the jar file (a name ending in `.jar`, default `paper.jar`), the minimum and maximum memory in MB (defaults 1024 and 2048), and up to 16 extra Java flags. The unit runs `java -Xms…M -Xmx…M`, your flags, `-jar <jar> nogui`. |
| Custom command | One argument per line. The first line is the absolute path of the program. The command is run as an argument list, never through a shell. |
| Log file | Relative to the server directory. Default `logs/latest.log`. |
| Start this server when the machine starts | Unticked by default. Ticked, the server's unit is enabled, so it starts when the machine does: at boot, once lingering is on. Unticked, you start it from the panel. The choice can be changed later, on the server's page. |

Removing a server needs it stopped. The panel removes the server's two unit files, its grants and its record, and keeps the server's folder.

To move a server that already runs elsewhere, follow [`docs/RUNBOOK.md`](docs/RUNBOOK.md). Before the first start, check that the world loads on
the Paper build the server will run: the runbook records a copy that did not.

### The server page

Each server has its own page with Start, Restart and Stop, and six tabs: Console, Files, Backups, Schedules, Plugins and Players.

Under the server's name, *Starts with the machine* shows whether its unit is enabled. A person who holds the server's `settings` capability can change it there. The change is made in systemd, and the page shows the state after systemd accepted it. It takes effect at the next boot, with lingering on. The panel reads each unit's state when it starts and records it, so a change made by hand while the panel was not running shows after that start. While the panel runs, the page shows what it last recorded, so if you enable or disable a unit by hand, set the choice on the page again to match.

**Starting** waits for the server's `Done` line, up to five minutes. A Paper server prints that line when it finishes loading. When it
arrives, the server is shown as running. A custom command has no such line, so the panel shows it loaded while its unit is active. If the unit
stops during the wait, the page says the server stopped while it was starting, and the journal has the reason. If five minutes pass without a
`Done` line, the page says the server did not report that it had finished loading, and leaves it running. If the panel cannot confirm the start
at all, it says so and asks you not to start the server again until its state is clear.

**Restarting and stopping** offer a warning choice first: no warning, or 30, 60, 120 or 300 seconds of chat warnings before the action. A
countdown you start can be cancelled only by you, until the stop begins. A scheduled countdown can be cancelled by anyone with power on the
server. A stop can end a start that is still waiting for its `Done` line. If the panel restarts during a countdown, the countdown is abandoned
and the server keeps running.

**Console** streams the server's log. It shows the last 1,000 lines. A command goes to the server's console, up to 1,024 bytes, and is
accepted only while the server is running and has finished loading.

**Files** browses the server folder. Text files open in an editor; saving keeps the previous version, up to ten per file and 512 MiB per
server. Upload sends one file of up to 256 MiB; a file with the same name is replaced, and its old version is kept. A folder shows up to 2,000
entries.

**Backups** makes a backup of the server, saving a running server first and checking each archive against its recorded checksum before a
restore. A restore needs the server stopped. It renames the current server folder aside rather than deleting it, puts the archive in its place,
and asks you to type the archive's file name to confirm. Folders moved aside by earlier restores are listed; the panel removes one only when you
remove it, and asks you to type its name. If a restore did not finish, the tab shows the folders it named and whether each is present. Clearing
the record changes no folder. After each backup, the panel removes the oldest archives beyond the number set in Settings.

**Schedules** runs one of five actions on a five-field cron time in a time zone you choose: start, stop, restart, backup, or a console command
that runs with your own console access. Stop and restart can warn players first, with the same choices as the server page. A server holds up
to 20 schedules. A schedule runs as a fresh check of its creator, so it stops working as soon as its creator loses the capability or the
panel access. A firing that fails after it begins raises an alert, which is recorded in the audit log.

**Plugins** installs jars from GitHub releases.

- The plugin folder is `plugins` by default, inside the server folder.
- Each server may name up to eight repositories, as `owner/name`. Each has its own optional access token, which the panel never shows again
  and sends only to `api.github.com`. Give the token read access to that one repository only.
- "List its plugins" reads the newest release and offers its jars. Tick the ones to install. Up to 16 plugins per repository, and a plugin
  name may appear once across the server.
- Save the sources before you update, because an update uses the saved sources. "Update plugins now" runs once. "Update on every start" checks
  each time the server starts, and "Stop updating on start" turns that off. After a start-time check that had a failed plugin, the next start-time check waits one minute, then two, four and eight minutes, and then ten. After a clean check it waits ten minutes. A start inside the wait starts with the jars it already has.
- A release jar must have a sha256 digest on GitHub, and it is installed only if the digest matches. An older version of the same plugin is
  removed once the new one is in place. Each jar's version may carry a qualifier such as `SNAPSHOT`, but it must start with digits.

**Players** shows who is online, as far as the log shows since the server last started, which is approximate. You can send a message to
everyone (up to 256 characters), kick a player, or add or remove a player from the whitelist. The chat needs the console capability. Kick and
whitelist need the players capability.

### Access

Access lists the grants, which are rows of *person, server, capability*. A server may be a single server or *all servers*, which covers servers
added later too.

Anyone with `access.manage` can see the grants. Owners and panel operators also see every OWNER and ADMIN account the website has; anyone
else sees the people this panel has seen. Only an owner, or a panel operator, can change grants. The form offers the people the
website has as OWNER or ADMIN, and the capabilities below. A capability marked *high risk* can make code run as the panel's account.

| Capability | What it allows |
|---|---|
| `server.view` | See the server. Any other capability on a server also lets its holder see it. |
| `console.read` | Read the console. |
| `console.send` | Send console commands and chat (high risk). |
| `power` | Start, restart and stop. |
| `files.read`, `files.write` | Browse and read files, and edit or upload them (write is high risk). |
| `backups` | See the backups, make one, restore one, clear a restore record, and remove folders moved aside. |
| `schedules` | See, add and remove schedules (high risk). |
| `plugins` | See and change plugin sources, and update plugins (high risk). |
| `players` | Kick and whitelist players. |
| `settings` | Change whether a server starts with the machine, from its page. |
| `panel.access` | Enter the panel. An ADMIN with no grant rows is refused, so granting any capability lets it in. |
| `servers.manage` | Add and remove servers (high risk). |
| `access.manage` | See the grants. Only an owner or a panel operator can change them, and sees the website's accounts. |
| `settings.manage` | Open and change Settings. |
| `audit.read` | Read every row of the audit trail. Without it, you see the rows about servers you can view. |
| `root.run` | Run privileged steps, such as turning lingering on (high risk). |
| `panel.operator` | Everything the owner can do, on every server, now and later (high risk). |

An **owner** has every capability with no grants needed. An **ADMIN** holds only what its grant rows allow. **Operators** are a special case: a
panel operator is an ADMIN with the `panel.operator` grant, and holds the owner's abilities exactly, on every server, until the status is
removed. An operator can write grants and can make or remove other operators, so the status should go only to people you would trust with the
whole panel. Removing operator status leaves any grants that were made separately.

### Audit

The audit trail shows when, who, which server, the action, the outcome and details. It records every change: grants, servers, power,
backups, files, schedules, plugins, players and chat, console commands, privileged steps and settings. It also records an attempt that a
capability refused, once per person, route and server within a short window. An
incident that would have been posted to Discord is recorded with the outcome `not_sent`, because Discord posting is not connected yet.

### Health

Health runs these checks, each marked ok, warning, error or unknown:

- **systemd version** and **systemd user manager**: the units cannot be managed without them.
- **Lingering**: when it is off, the page offers *Turn lingering on*. It asks for the account's password and runs
  `sudo loginctl enable-linger <account>` once, showing the output.
- **Data directory**: the panel can read and write its data.
- **Website**: whether the website answers on its loopback address. If it does not, sign-in shows as unavailable.
- **Save messages**: after a backup fails because Paper did not confirm its save messages, this warns. A Paper upgrade can change those
  messages, so after any upgrade take one backup of each server and check the warning clears.
- **tar** and **zstd (optional)**.
- **Java for each server**: whether the program each server starts with exists and is executable.

### Settings

- **Backups kept per server**: between 1 and 100. The default is 7.

Posting alerts to Discord is not connected in this version, so its webhook form is not shown.

## Operations

### Logs

```sh
journalctl --user -u jass-panel -n 100        # the panel
journalctl --user -u jass-mc-<id>.service     # one game server, by its id
```

### Restart the panel

```sh
systemctl --user restart jass-panel
```

The servers keep running through a panel restart.

### Upgrade

```sh
git pull                 # or update the checkout by your own means
npm ci
npm run build
systemctl --user restart jass-panel
```

Starting the daemon applies pending database migrations after keeping a verified copy of the database. The migration that adds the start-with-the-machine choice sets it on for every existing server, so those servers keep the units they have. If the Node.js binary the panel uses
has moved, for example after a Node upgrade through another install, run `scripts/install.sh` again. It rewrites the unit, and restarts the
panel only if the unit changed.

### The panel's database copies

Before a migration the daemon keeps a copy of the database (the newest five), and it keeps a daily copy (the newest seven). They are in
`<PANEL_DATA_DIR>/db-backups/`, with mode 0600.

### Where things live

| What | Where |
|---|---|
| The installer's settings | `~/.config/jass-panel/panel.env` (mode 0600) |
| The panel's unit | `~/.config/systemd/user/jass-panel.service` |
| Each server's units | `~/.config/systemd/user/jass-mc-<id>.service` and `jass-mc-<id>.socket` |
| The database | `<PANEL_DATA_DIR>/panel.db` (mode 0600) |
| Database copies | `<PANEL_DATA_DIR>/db-backups/` (mode 0600) |
| Backups | `<PANEL_DATA_DIR>/backups/<server id>/` |
| Earlier versions of edited files | `<PANEL_DATA_DIR>/file-history/<server id>/` |
| Markers for work in progress | `<PANEL_DATA_DIR>/markers/` |
| How each server's last run ended | `<PANEL_DATA_DIR>/events/<server id>.log` |

### Uninstall

```sh
systemctl --user disable --now jass-panel
rm ~/.config/systemd/user/jass-panel.service
rm -r ~/.config/jass-panel
sudo rm /etc/caddy/conf.d/jass-panel.caddy && sudo systemctl reload caddy
```

Server units are left alone unless their servers were removed from the panel first. The data directory is kept until you remove it.

## Troubleshooting

| What you see | What it means and what to do |
|---|---|
| Installer: `the systemd user manager is not running for <account>` | Log in on the machine, or run `sudo loginctl enable-linger <account>` and log in again, then run the installer again. |
| Installer: `lingering is off` | Run `sudo loginctl enable-linger <account>`, then run the installer again. |
| Installer: `Node.js … or newer is needed` | Install Node.js 22.12 or newer, so that `node` on `PATH` is that version. |
| Installer: `the daemon is not built` | Run `npm ci && npm run build` in the checkout. |
| Daemon exits: `PANEL_PUBLIC_ORIGIN is required` | Set it in `~/.config/jass-panel/panel.env`, then restart. |
| `Sign-in cannot be checked right now` | The website did not confirm who you are. Check that it answers on `127.0.0.1:3000`, that its `/api/panel/session` route is deployed, and that its `AUTH_URL` is the public HTTPS origin. |
| `No access to anything yet` | The account is an ADMIN with no grants. An owner grants it something on Access. |
| Access says the accounts could not be listed | The website could not be asked for its accounts. Check that it is up and that `/api/panel/accounts` answers `401` without a cookie. The list then shows only people the panel has seen. |
| Access says only owners and panel operators can list the website's accounts | Expected for an ADMIN with `access.manage`: the screen shows the people this panel has seen. |
| The panel URL shows the website's page, or no panel headers | The `conf.d` import is missing from the Caddyfile, or the snippet was not written or reloaded. See Install, step 7. |
| `The server stopped while it was starting. The journal has the reason.` | The unit stopped during start. Read `journalctl --user -u jass-mc-<id>.service`. A world another process still holds is a common cause: stop the old process first. |
| `The server did not report that it had finished loading within five minutes` | The server was left running. Check its log; it may still be loading, or it may not print a `Done` line. |
| `The panel could not confirm that the server started.` | Do not start it again. Read its state on the page, and check its journal, until the state is clear. |
| `Stop the server before restoring it.` | Stop the server, then restore. |
| `The unit file was edited by hand` | The panel shows the server but does not overwrite that file. Change it by hand, or remove it by hand, as the message says. |
| Servers stop when you log out, or do not start at boot | Lingering is off (Install, step 4), or the server's *Starts with the machine* is off. |
| Health: *Save messages* warning | A backup did not see Paper's save messages. Take a backup of each server after a Paper upgrade, then check the warning clears. |

## Security

- The panel never runs as root. It needs no sudoers entry and no polkit rule. A step that needs root is a closed list, and each step asks for
  the account's password.
- Identity comes from the website, asked on loopback with the browser's own cookie forwarded unchanged. The panel forwards no other header
  to the website, and treats any answer other than a clean one as no access.
- The daemon listens on loopback only. The proxy refuses `/api/panel/*` publicly, and the daemon refuses any Host other than the public host
  and loopback.
- Mutating requests need the panel's own request header and the public origin.
- Responses carry a content security policy, `frame-ancestors 'none'`, no-store caching for the API, and `X-Robots-Tag: noindex`.
- Plugin tokens and the Discord address are kept in the database, never shown again, and never written to a log, an error or an audit row.
- The website and the panel share one origin. The website's own deploy document records the accepted risk: a site admin who can author raw
  HTML can run script in an owner's browser session and reach the panel as that owner.

## Testing against a copy of the live website

A copy of the live website holds the live accounts and data, so it is live data. It must stay off the live site and away from the live servers.

Keep to these rules, in order of importance:

1. **Run the copy under a different Linux account, or on a different machine.** The servers are systemd user units named `jass-mc-<id>`, and the panel's own unit is `jass-panel.service`. Units belong to the account that runs them, so a copy under the live account would manage the live servers.
2. **Do not run `scripts/install.sh` for the copy where the live panel is installed.** The installer writes `jass-panel.service` for the account and would replace the live panel's unit.
3. **Add only throwaway server folders, with ids that are not live ids.** Never add a live server folder to the copy.
4. **Keep the copy on loopback, with its own secret.** Use 127.0.0.1 only, never the live host name: browser cookies do not separate by port, so the copy and the live site must not share a host name. Give the copy a new `AUTH_SECRET`, so no live session is accepted there.
5. **Keep the copy private.** Do not put it behind Caddy, and do not share it. Its database holds real email addresses and password hashes.

Set up the copy of the website first, as its deployment document describes, on `http://127.0.0.1:3100`. Then, for the panel:

```sh
cd /path/to/JASS-Panel
npm ci
npm run build
mkdir -p "$HOME/jass-panel-copy/data"
PANEL_PORT=29201 \
PANEL_BASE_PATH=/panel \
PANEL_PUBLIC_ORIGIN=http://127.0.0.1:29201 \
SITE_INTERNAL_URL=http://127.0.0.1:3100 \
PANEL_DATA_DIR="$HOME/jass-panel-copy/data" \
npm start
```

`npm start` reads no `.env` file, so the variables above must be set in the command, as shown. Open `http://127.0.0.1:29201/panel/` in the browser that signs in to the copy's website at `http://127.0.0.1:3100`. The panel's own database starts empty. The accounts come from the copy's website database, so the Access screen should list the live OWNER and ADMIN accounts.

Check, in this order:

- Sign in on the copy's website with a live OWNER account. The panel shows that person as the owner.
- Access lists the live OWNER and ADMIN accounts, including ADMIN accounts that have never opened the panel. An ADMIN with no grant sees "No access to anything yet".
- Health lists its checks, and the Website check is ok.
- Add a throwaway server folder, start it with a harmless command, stop it and remove it. Never use a live folder.
- Give an ADMIN a grant on that throwaway server only, and check that the audit trail records it.

When the test is over:

- Stop the copy's panel and the copy's website.
- Delete the copy's data directory, its database snapshot and backups, its uploads, and its `.env` file.
- If a unit was created for the copy, disable it and delete its unit file. Following rule 2, there should be none.
- Remove the throwaway server folders.

Passwords in the copy are the live passwords, and a change made in the copy stays in the copy. Do not run `npm run create-admin` on an existing email unless you mean to replace its password and role; see [Existing website and accounts](#existing-website-and-accounts).

## Development

```sh
npm ci
cp .env.example .env     # then set PANEL_PUBLIC_ORIGIN and the rest
npm run dev              # builds the daemon and runs it on PANEL_PORT, reading .env
npm run dev:web          # Vite on 127.0.0.1:5173: the UI, proxying /panel/api to the daemon on 29200,
                         # and /login and /api/auth to the website on 3000
npm run db:migrate       # apply pending migrations to PANEL_DATA_DIR and exit
```

`npm run dev` needs a website answering on `SITE_INTERNAL_URL`, or every request is refused as unavailable. For mutating requests through
`dev:web`, `PANEL_PUBLIC_ORIGIN` must match the origin the browser sends.

The gates, which must all pass before a change is called done:

```sh
npm run typecheck   # the web and shared project, and the node and test project
npm run lint        # eslint, with the typed and accessibility rules
npm test            # vitest; the lifecycle and backup tests use the real user manager, real tar and zstd, and skip without a user manager
npm run build       # the daemon to dist/server and the web app to web/dist
```

The code is laid out as follows. `src/shared/` holds the wire schemas both sides use. `src/server/` is the daemon: `api/` for routes and
streams, `gate/` for the website's identity, `authz/` for the one permission check and the route table, and then `servers/`, `power/`,
`console/`, `files/`, `backups/`, `schedules/`, `plugins/`, `alerts/`, `privileged/`, `health/`, `access/`, `audit/`, `db/`, `config/` and
`systemd/`. `web/` is the React app. `test/` holds the integration tests, and `scripts/` the installer and the migration helper.
