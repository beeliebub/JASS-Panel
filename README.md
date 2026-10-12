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

The Install steps below put these in place. Check each one before you start.

| Needed | How to check |
|---|---|
| Linux with systemd, and a user manager | `systemctl --user is-system-running` prints `running` or `degraded`. Tested on systemd 259; the installer warns on anything older (`systemctl --version` shows the version). |
| Lingering for the account | `loginctl show-user "$USER" -p Linger` prints `Linger=yes`. Without it the panel and its servers stop at logout and do not start at boot. Install, step 4. |
| Node.js 22.12 or newer | `node -v` prints `v22.12.0` or newer. The installer runs the `node` found on `PATH`. |
| `tar` | `tar --version`. Used for backups and restores. |
| `zstd` (optional) | `zstd --version`. Archives are `.tar.zst`; without `zstd` they are `.tar.gz`. |
| A Java runtime, for Paper servers | `command -v java`. The Paper preset takes the absolute path of `java`. |
| The JASS website, on loopback | `curl -i http://127.0.0.1:3000/api/panel/session` answers `401` with a JSON body. The panel also uses `/api/panel/accounts` and `/api/panel/identity` on the same address. Install, step 3. |
| Caddy 2, with a `caddy.service` unit | `caddy version` prints `v2.` and a version number. `systemctl cat caddy` shows the config file the unit loads. Install, step 3. |

Nothing depends on a particular account name or directory.

## Install

This guide installs the panel beside a JASS website that is already running behind Caddy, for one Linux account that will own the panel
and the game servers. Do the steps in order. Each step ends with a check, and a step is not finished until its check passes.

- Run every command as that account. Where a command uses `sudo`, it asks for that account's password.
- If the website is a copy of the live site, with real accounts in its database, do not use this guide. Use
  [Testing against a copy of the live website](#testing-against-a-copy-of-the-live-website) instead. That copy must not sit behind Caddy.
- The steps were tested on Ubuntu 26.04 with systemd 259, Node.js 22.22, OpenJDK 25.0.4, Paper 26.3 build 141 and Caddy 2.11.6. On other
  versions, read each step's output before you go on.

### 1. Install the requirements

On Ubuntu 26.04 the archive provides everything except Caddy:

```sh
sudo apt update
sudo apt install nodejs npm tar zstd openjdk-25-jre-headless
node -v    # must print v22.12.0 or newer
```

- `zstd` is optional: without it, backups are `.tar.gz`. Java is needed only for Paper servers. On other systems, install the same tools
  with that system's package names.
- If `node -v` prints an older version, install Node.js 22.12 or newer another way, such as NodeSource or nvm, then check again. The
  installer runs the `node` that comes first on `PATH`, so check it in the shell you will run the installer from.
- Install Caddy 2 from Caddy's own repository, not the Ubuntu archive. The archive's package is 2.6, older than the 2.11.6 the rules were
  tested with. See <https://caddyserver.com/docs/install>. Caddy's package installs the `caddy.service` unit that step 3 checks.

### 2. Get the code

Clone the repository, or copy its folder, into the directory you will run the panel from. Choose the final location now. The installer
writes the checkout's full path into the systemd unit. If you move the folder later, run `scripts/install.sh` again from its new location.

From the checkout's top folder, both files must be listed:

```sh
ls scripts/install.sh package.json
```

### 3. Bring the website and Caddy up

Before the panel is added, the website must have the panel's routes, and Caddy must be running with the website's Caddyfile. The installer
touches neither one.

**The website.** Follow the website's own deploy document (`docs/DEPLOYMENT.md` in the website repository). It covers deploying the version
with the panel routes, running its migrations and its pages-only seed, and checking for `/panel` page collisions. Then check the website on
loopback:

```sh
curl -i http://127.0.0.1:3000/api/panel/session
```

A `401` with a JSON body means the route exists and no cookie is signed in. A `404` means the panel routes are not deployed yet.

If the website has no OWNER account yet, create one on the website's machine, in the website's directory, with its own environment:

```sh
npm run create-admin -- <email> <password> --role OWNER
```

Run this only for an email that has no account yet. `create-admin` replaces the password and the role of an existing account; see
[Existing website and accounts](#existing-website-and-accounts) before you run it.

The panel adds no environment variable to the website and needs no database change. `AUTH_URL` must already be the public HTTPS origin, as
the website's deploy document says; a wrong value makes the panel refuse every signed-in browser.

**The website's Caddyfile.** Inside the site block for the public website, it needs two things:

1. The refusal for the panel's API paths, in a `handle` block of its own:

   ```caddy
   @panel_api path /api/panel /api/panel/*
   handle @panel_api {
       respond 404
   }
   ```

2. The import that loads the panel's snippet:

   ```caddy
   import /etc/caddy/conf.d/*.caddy
   ```

Use `handle` for the refusal, not a bare `respond`. In tests with Caddy 2.11.6, a bare `respond` did not stop `/api/panel` requests from
reaching the website's `handle` block; the `handle` form did. Step 8 checks the result, so the file check below only helps you read the file.

Read the file. The grep shows the import line and the `/api/panel` matcher; the listing shows everything else:

```sh
grep -n -E 'conf.d|api/panel' /etc/caddy/Caddyfile
cat -n /etc/caddy/Caddyfile
```

The refusal must be a `handle` block, the import must sit inside the site block, and no other matcher may be named `@panel`, because the
panel's snippet defines one. If something is missing, update the website's Caddyfile as the website's deploy document describes.

**Caddy.** The installer does not start or reload Caddy. Caddy must be running before step 7.

1. Check the Caddy binary, and the config file its service loads:

   ```sh
   caddy version
   systemctl cat caddy --no-pager
   ```

   `caddy version` prints `v2.` and a version number. The unit's `ExecStart` must run `caddy run` with `--config <file>` and
   `--adapter caddyfile`, and its `ExecReload` must reload the same `<file>`. This guide uses `/etc/caddy/Caddyfile`. If your `<file>` is
   different, use it in every command in this guide. If `systemctl cat caddy` reports no unit, install Caddy from its package repository,
   which provides one.

2. Validate the website's Caddyfile:

   ```sh
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   It must print `Valid configuration`. Until step 7 writes the snippet, Caddy also warns that the import pattern matches no files. That
   warning is expected, and it is not an error.

3. Check whether the service is enabled and running:

   ```sh
   systemctl is-enabled caddy
   systemctl is-active caddy
   ```

   The first prints `enabled` and the second prints `active`. If the second prints `inactive` or `failed`, go on to item 4.

4. Start Caddy, and enable it so that it starts at boot:

   ```sh
   sudo systemctl enable --now caddy
   systemctl is-active caddy
   ```

   `is-active` must print `active`. If it does not, read the cause, fix it, and start again:

   ```sh
   systemctl status caddy --no-pager
   sudo journalctl -u caddy -n 50 --no-pager
   ```

   Common causes: the Caddyfile is invalid (item 2 fails the same way); another program holds port 80 or 443, which
   `sudo ss -ltnp | grep -E ':(80|443) '` shows; or the `--config` file in the unit does not exist.

5. Check that the website answers through Caddy:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://example.net/
   ```

   Replace `example.net` with your public host, and see the note in step 8 if the name does not resolve to this machine yet. The result
   must be the website's normal answer, such as `200`. `502` means Caddy cannot reach the website on `127.0.0.1:3000`.

### 4. Turn lingering on

Lingering keeps your user manager running after logout and starts enabled user units at boot. The panel and its servers depend on it.

```sh
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

The second command must print `Linger=yes`. The installer offers the first command when it runs in a terminal. The Health screen can run
it later, asking for the account's password.

### 5. Build the panel

```sh
cd /path/to/JASS-Panel
npm ci
npm run build
ls dist/server/main.js web/dist/index.html
```

`npm ci` installs the exact dependencies in `package-lock.json`. `npm run build` compiles the daemon to `dist/server`, with the database
migrations beside it, and the web app to `web/dist`. The last command must list both files. The installer refuses to run without
`dist/server/main.js`.

### 6. Run the installer

Run it in a terminal, as the account from the earlier steps, from the checkout. Do not use `sudo`: the installer manages your own user
units, and `systemctl --user` talks to the account that runs it. Before the first install, nothing else may listen on `127.0.0.1:29200`,
because the panel uses that port.

```sh
cd /path/to/JASS-Panel
PANEL_PUBLIC_ORIGIN=https://example.net scripts/install.sh
```

`PANEL_PUBLIC_ORIGIN` is the address people type into their browser to reach the website: the origin only, with no path. The installer
removes a trailing slash. It must match the website's `AUTH_URL`.

The installer checks `tar`, `systemctl` and `loginctl`, Node.js 22.12 or newer, that the daemon is built, that the user manager is running,
and that lingering is on. If lingering is off and the installer is in a terminal, it offers the command from step 4. It stops at the first
failed check and prints the fix. When every check passes, it:

- writes `~/.config/jass-panel/panel.env` (mode 0600) with your origin, the website at `http://127.0.0.1:3000`, port `29200` and base path `/panel`;
- writes `~/.config/systemd/user/jass-panel.service`, reloads the user manager and enables the unit;
- starts the panel, or restarts it if the unit changed;
- prints the proxy block for step 7.

It does not change the proxy, the website or any game server. Running it again changes nothing that is already correct.

**An existing `panel.env` is kept.** The installer never changes the origin in a file that already exists. If the origin you pass differs
from the file's, it prints a warning and keeps the old value. To use a different origin, edit `~/.config/jass-panel/panel.env` and run
`systemctl --user restart jass-panel`. To start over, follow [Uninstall](#uninstall).

**Check the origin.** The `PANEL_PUBLIC_ORIGIN` value in `panel.env` must be the address you will type into the browser, and it must match
the website's `AUTH_URL`:

```sh
grep PANEL_PUBLIC_ORIGIN ~/.config/jass-panel/panel.env
```

If it is wrong, edit the file and run `systemctl --user restart jass-panel`.

**Check the service.** The first command prints `active`; the second prints a line containing `panel listening on loopback`:

```sh
systemctl --user is-active jass-panel
journalctl --user -u jass-panel --no-pager | grep 'panel listening on loopback'
```

### 7. Serve the panel through Caddy

Caddy is already running from step 3. This step adds the panel's route to Caddy and reloads it. The route is served at the base path in
`panel.env`, which is `/panel` by default.

1. Write the block the installer printed into the snippet folder. The block below uses the defaults. If you changed `PANEL_PORT` or
   `PANEL_BASE_PATH`, use the block the installer printed instead, since it has your values:

   ```sh
   sudo mkdir -p /etc/caddy/conf.d
   sudo tee /etc/caddy/conf.d/jass-panel.caddy >/dev/null <<'EOF'
   @panel path /panel /panel/*
   handle @panel {
       reverse_proxy 127.0.0.1:29200
   }
   EOF
   ```

   The closing `EOF` must be on a line of its own, with nothing before it. If the terminal shows a `>` prompt after you paste, that line
   is missing. The quotes around `'EOF'` stop the shell from changing anything inside the block.

2. Make sure Caddy is running. `systemctl is-active caddy` must print `active`. If it does not, go back to step 3 and start Caddy.

3. Validate, and reload only if validation passed:

   ```sh
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
   ```

   Validation must print `Valid configuration`. The warning about the import matching no files should now be gone, because the snippet
   exists. If the reload fails, the running configuration is unchanged, and the cause is in
   `sudo journalctl -u caddy -n 50 --no-pager`.

4. Run every check in step 8. Only those checks prove that the refusal and the panel route both work.

The `/panel` route exists only once the file does. Caddy takes one matcher per `handle`, so the paths sit in a named `path` matcher:
`handle /panel /panel/*` is a parse error.

### 8. Check it

Run the checks in order. Each one names the result to expect. Replace `example.net` with your public host. If the name does not resolve to
this machine yet, add `--resolve example.net:443:127.0.0.1` to each `curl`. Add `-k` only for a test certificate, because it skips
certificate checks.

1. The service runs. Each command prints the word shown:

   ```sh
   systemctl --user is-active jass-panel     # active
   systemctl --user is-enabled jass-panel    # enabled
   ```

2. The daemon answers on loopback, without going through Caddy. Signed out, the identity check answers `401`:

   ```sh
   curl -s -i http://127.0.0.1:29200/panel/api/v1/me
   ```

   The body contains `"code":"unauthenticated"`.

3. The panel's page through Caddy. Use `-i`, which sends a GET request. The panel answers a HEAD request (`curl -I`) with `404` even when
   the headers are there, so `-I` is the wrong check:

   ```sh
   curl -s -i https://example.net/panel/
   ```

   It answers `200`, and the response includes `Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy`,
   `X-Content-Type-Options` and `X-Robots-Tag: noindex`.

4. The website's API is refused through Caddy. This check proves that the refusal works:

   ```sh
   curl -s -i https://example.net/api/panel/session
   curl -s -i https://example.net/api/panel
   ```

   Both must answer `404`. Any other answer means the refusal is not in effect. Fix the website's Caddyfile as step 3 describes, then
   validate and reload Caddy as step 7 does.

5. Signed out, the panel refuses you through Caddy:

   ```sh
   curl -s -i https://example.net/panel/api/v1/me
   ```

   It answers `401` with `unauthenticated`. With the website down, the same request answers `503` with `unavailable`. Neither answer
   redirects.

6. Signed in, the panel works. Follow step 9: the Servers page opens, Health lists its checks, and Access lists the website's OWNER and
   ADMIN accounts. If Access says the accounts could not be listed, the panel could not get them from the website. Check `SITE_INTERNAL_URL`
   in `panel.env`, and that the website answers `/api/panel/accounts` on loopback.

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

This removes the panel from the account. It leaves the website, the website's Caddyfile (including its import line), and every server
folder.

1. Remove each game server from the panel first. Stop it, then remove it under Servers. Removing a server deletes its two unit files and its
   record in the panel. The server's folder stays.

2. Stop the panel, and remove its unit and its configuration:

   ```sh
   systemctl --user disable --now jass-panel
   rm ~/.config/systemd/user/jass-panel.service
   systemctl --user daemon-reload
   rm -r ~/.config/jass-panel
   ```

3. Remove the panel's route from Caddy, and reload Caddy if it is running. Caddy warns that the import matches no files, which is expected:

   ```sh
   sudo rm /etc/caddy/conf.d/jass-panel.caddy
   systemctl is-active caddy && sudo systemctl reload caddy
   ```

4. Optional: remove the panel's data. This deletes the database, the backups, the file history and the event logs, so do it only when you
   want the next install to start empty. The default location is `~/.local/share/jass-panel`. If you set `PANEL_DATA_DIR`, remove that
   folder instead.

   ```sh
   rm -r ~/.local/share/jass-panel
   ```

To install again, check that steps 3 to 5 still hold, then run the installer from step 6. Because step 2 removed `panel.env`, the installer
writes a new one with the origin you pass.

## Troubleshooting

| What you see | What it means and what to do |
|---|---|
| Installer: `<tool> is not installed` | Install the named tool (`tar`, `systemctl` or `loginctl`), then run the installer again. |
| Installer: `the systemd user manager is not running for <account>` | Log in on the machine, or run `sudo loginctl enable-linger <account>` and log in again, then run the installer again. |
| Installer: `lingering is off` | Run `sudo loginctl enable-linger <account>`, then run the installer again. Run the installer in a terminal to be offered the command. |
| Installer: `Node.js … or newer is needed` | Install Node.js 22.12 or newer, so that `node` on `PATH` is that version. |
| Installer: `the daemon is not built` | Run `npm ci && npm run build` in the checkout. |
| Installer: `give the website's public origin` | Run the installer again with `PANEL_PUBLIC_ORIGIN=https://…` in front of the command. |
| Installer: `… has no PANEL_PUBLIC_ORIGIN line` | Add `PANEL_PUBLIC_ORIGIN=<the website's public origin>` to `~/.config/jass-panel/panel.env`, then run the installer again. |
| Installer: `warning: … already sets PANEL_PUBLIC_ORIGIN=…` | `panel.env` was kept, so the new origin was not written. Edit the file to the origin you want, then run `systemctl --user restart jass-panel`. |
| Daemon exits: `PANEL_PUBLIC_ORIGIN is required` | Set it in `~/.config/jass-panel/panel.env`, then restart. |
| Browser shows `403` with `wrong_host` | The address in the browser is not `PANEL_PUBLIC_ORIGIN`. Make the origin the address you browse to, then restart the panel. |
| `Sign-in cannot be checked right now` | The website did not confirm who you are. Check that it answers on `127.0.0.1:3000`, that its `/api/panel/session` route is deployed, and that its `AUTH_URL` is the public HTTPS origin. |
| `No access to anything yet` | The account is an ADMIN with no grants. An owner grants it something on Access. |
| Access says the accounts could not be listed | The website could not be asked for its accounts. Check that it is up and that `/api/panel/accounts` answers `401` without a cookie. The list then shows only people the panel has seen. |
| Access says only owners and panel operators can list the website's accounts | Expected for an ADMIN with `access.manage`: the screen shows the people this panel has seen. |
| `sudo: caddy: command not found` | Run the same command with the full path, for example `sudo "$(command -v caddy)" validate --config /etc/caddy/Caddyfile --adapter caddyfile`. |
| `caddy.service is not active, cannot reload.` | Caddy is stopped, so there is nothing to reload. Install, step 3 starts it. Find the cause with `sudo journalctl -u caddy -n 50 --no-pager`. |
| Caddy will not start, and its journal shows a bind error | Another program holds port 80 or 443. `sudo ss -ltnp \| grep -E ':(80\|443) '` shows which one. Stop it, then start Caddy again. |
| `curl -I https://…/panel/` answers `404` | `-I` sends a HEAD request, which the panel answers with `404`. Use `curl -i`, which answers `200`. |
| `curl -i https://…/api/panel/session` answers anything but `404` | The refusal is not in effect. Make it a `handle @panel_api { respond 404 }` block, as Install, step 3 shows, then validate and reload Caddy. |
| The panel URL shows the website's page, or no panel headers | The import is missing from the website's Caddyfile, the snippet was not written, or Caddy was not reloaded after the snippet was written. See Install, step 7. |
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
