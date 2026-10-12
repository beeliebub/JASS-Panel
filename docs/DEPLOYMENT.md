# Deploying JASS Panel

The panel is one daemon that runs as an ordinary user beside the JASS website. It needs no root. Servers are systemd user units the
panel writes; the daemon and the servers outlive each other, so restarting the panel never stops a running server.

## Requirements

| Needed | Notes |
|---|---|
| Linux with systemd and a user manager | `systemctl --user is-system-running` must answer `running` or `degraded` |
| Lingering for the account | Without it the panel and its servers stop at logout and do not start at boot. See below. |
| Node.js 22.12 or newer | `node -v` |
| `tar` | backups and restores |
| `zstd` (optional) | archives are `.tar.zst`; without it backups are `.tar.gz` |
| A Java runtime, for Paper servers | the Paper preset takes the absolute path of `java` |
| The JASS website, running on loopback, with its panel routes | the panel asks it who is signed in (`/api/panel/session`) and lists its OWNER and ADMIN accounts for the Access screen (`/api/panel/accounts`) |
| A reverse proxy in front of both | Caddy today. One origin, TLS. |

The units have been tested on systemd 259 only. The installer warns on anything older.

## Install

```sh
npm ci
npm run build
PANEL_PUBLIC_ORIGIN=https://example.net scripts/install.sh
```

The installer takes one input, the website's public origin. It checks the requirements above and stops with the exact fix when one
is missing. It writes `~/.config/jass-panel/panel.env` (mode 0600, kept if it exists) and `~/.config/systemd/user/jass-panel.service`,
reloads the user manager, enables the unit and starts it. Running it again changes nothing.

It does not edit the proxy, the website or any game server. It prints the reverse-proxy block. Write it to
`/etc/caddy/conf.d/jass-panel.caddy`: the website's Caddyfile imports that directory inside its site block, and the website's deploy
document (`docs/DEPLOYMENT.md` in the website repository) describes the same step. Then validate and reload Caddy:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

The block the installer prints is:

```text
@panel path /panel /panel/*
handle @panel {
    reverse_proxy 127.0.0.1:29200
}
```

The `handle` must come before the website's default handler and must be a block of its own. Caddy 2.x accepts one matcher per `handle`
(`handle /panel /panel/* { … }` is a load error), so the paths go in a named `path` matcher. The website's block must keep refusing `/api/panel` and
`/api/panel/*` before it proxies anything else; those paths are the daemon's own and are never meant to reach the public.

### Lingering

Lingering keeps the account's user manager running after logout and starts enabled units at boot. The installer stops without it. A server's
unit is enabled only when its *Starts with the machine* choice is on, which the server's page sets.
Either of these turns it on:

- on a terminal, answer yes when the installer offers to run `sudo loginctl enable-linger <account>` (sudo asks for the password there);
- in the panel: Health, then Turn lingering on, which asks for the account password and runs the same command once.

Boot ordering (the network being up before a server starts) has not been exercised on a real reboot yet.

## Installing beside a website that is already live

The panel is built for a website that is already in use. Existing accounts keep working as they are:

- OWNER and ADMIN accounts keep their email, password, role and sessions. The panel only reads them. It never writes to the website's
  database, and the website's panel routes need no database change.
- An OWNER signs in on the website as before, and is the panel's owner at once.
- An owner or a panel operator sees every OWNER and ADMIN account the website has on the Access screen, including accounts that have never
  opened the panel. The website is asked with that person's own session. If it cannot be asked, the screen says so and lists only the people
  the panel has seen. Anyone else with access.manage sees only the people the panel has seen.
- An ADMIN can still sign in to the website, but has no panel access until an owner grants it something on the Access screen. An ADMIN with
  no grant rows sees the no-access screen.

Before installing the panel, bring the website to the version that has the panel's routes, using the website's own deploy document. Then:

1. Confirm the live Caddyfile imports `/etc/caddy/conf.d/*.caddy` inside its site block, and refuses `/api/panel` and `/api/panel/*` before it
   proxies anything else. A Caddyfile written before the panel existed does neither, so update it first. The installer never edits
   `/etc/caddy`.
2. Check that the website answers on loopback: `curl -i http://127.0.0.1:3000/api/panel/session` returns `401` with a JSON body when no cookie
   is sent. A `404` means the website's panel routes are not deployed yet.
3. Do not run `npm run create-admin -- <email> <password>` for an email that already has an account unless you mean to change that account.
   It replaces the account's password and sets its role, which is ADMIN unless `--role OWNER` is given. Passing `--role OWNER` is how an
   owner's password is reset; leaving it out turns an owner into an ADMIN.

## Configuration

Read from the environment; the installer writes the first four into `panel.env`.

| Variable | Default | Meaning |
|---|---|---|
| `PANEL_PUBLIC_ORIGIN` | none, required | the website's public origin, for the `Origin` check and the `Host` check. An origin only: no path. |
| `SITE_INTERNAL_URL` | `http://127.0.0.1:3000` | where identity is asked; must be a loopback `http` origin |
| `PANEL_PORT` | `29200` | loopback port the daemon listens on |
| `PANEL_BASE_PATH` | `/panel` | URL prefix of the UI and API; must match the proxy block |
| `PANEL_DATA_DIR` | `$XDG_DATA_HOME/jass-panel` (default `~/.local/share/jass-panel`) | database, backups, file history, markers, events, the update socket |

`XDG_CONFIG_HOME` (unit files) and `XDG_RUNTIME_DIR` (the per-server stdin FIFOs, default `/run/user/<uid>`) are read from the
environment as systemd sets them. No secret is an environment variable: GitHub tokens and the Discord webhook are stored in the
database, which is created mode 0600.

Plugin repositories are set per server, on its Plugins tab, not here. A server may name several repositories, and each may have its own
optional token. Give each token read access to its one repository only: a fine-grained token limited to that repository is enough. The
panel keeps the token in its database and never shows it again, and it sends a repository's token only to `api.github.com`.

## Where things live

| What | Where |
|---|---|
| Database | `<PANEL_DATA_DIR>/panel.db` (mode 0600) |
| Copies of the database: before a migration (`panel-…`, newest 5), and at each start and once a day (`daily-…`, newest 7); mode 0600 | `<PANEL_DATA_DIR>/db-backups/` |
| Backups | `<PANEL_DATA_DIR>/backups/<server id>/` |
| Previous versions of edited files | `<PANEL_DATA_DIR>/file-history/<server id>/` (ten per file, 512 MiB per server) |
| Markers for a backup in progress, a restore in progress, a restart in progress (`<id>.restart`), and each server's loaded marker | `<PANEL_DATA_DIR>/markers/` |
| How each server's last run ended | `<PANEL_DATA_DIR>/events/<server id>.log` |
| Unit files for servers and the panel | `$XDG_CONFIG_HOME/systemd/user/` |

Removing a server in the panel needs it stopped first. The panel disables and deletes its two unit files, its access grants, its row and its loaded marker. It never deletes the server's directory.

## Upgrade

```sh
git pull            # or update the checkout by your own means
npm ci
npm run build
systemctl --user restart jass-panel
```

Starting the daemon applies pending database migrations after keeping a verified copy of the database. The servers keep running
through the restart.

## Uninstall

```sh
systemctl --user disable --now jass-panel
rm ~/.config/systemd/user/jass-panel.service
rm -r ~/.config/jass-panel
```

Server units are the operator's servers and are left alone unless they were removed from the panel first. The data directory is kept
until you remove it yourself.

## Checks after install

- `systemctl --user status jass-panel` shows `active (running)`.
- `journalctl --user -u jass-panel -n 50` shows `panel listening on loopback` and no errors.
- Through the public address, `curl -I https://<host>/panel/` includes `Content-Security-Policy`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `X-Content-Type-Options`, and `X-Robots-Tag: noindex`, and `curl -i https://<host>/api/panel/session` answers `404`.
- Signed out, `GET /panel/api/v1/me` answers `401` with `unauthenticated`; with the website down it answers `503` with `unavailable`.
  Neither answer ever redirects.
- Signed in on the website, the panel's Servers page loads, and Health lists the checks.
- Signed in as the owner, Access lists the website's OWNER and ADMIN accounts. If the screen says the accounts could not be listed, the
  daemon could not get them from the website: check `SITE_INTERNAL_URL` and the website's `/api/panel/accounts`.

## Testing against a copy of the live website

The steps are in the README, under "Testing against a copy of the live website". Two rules matter most. The copy runs under a different Linux account or on another machine, because its units belong to the account that runs them. And the copy never uses `scripts/install.sh` where the live panel is installed, because the installer writes the live panel's unit name.

## Verified and not yet verified

Verified on this machine with a real Paper 26.3 build 141 server (a scratch copy): add, start, the server's `Done` line, a command through
the stdin FIFO, a confirmed `save-all flush`, and a clean stop that ends with exit status 143. The same server also ran a start with the update step, a countdown stop, a live backup, a restore, a binary upload and a daemon stop during a countdown. Verified with the test suite: every
rule in the gate, the file jail, the unit renderer, the privileged-action runner, the backup and restore paths, the scheduler and
the update path, against the real user manager and real `tar` and `zstd`.

A start with update on start on installed the five jars a server named from the JASS plugin repository on this machine. Each matched the
sha256 GitHub publishes for it, and a manual update found them current; a repository with no release failed on its own. The same run on
the VPS, with the VPS's token, has not been done.

Not verified: a literal reboot with lingering; the start's wait for the Done line, a stop ending that wait, and the countdown's warnings and cancel on a live Paper server (the tests use a fake Paper, and the journal line format comes from a captured Paper run); a server moved from another manager on the live Test server (simulated on the development machine, see the runbook); the same install on the VPS, with its token; the public proxy's path handling on the VPS (the matrix was run against a local Caddy 2.11.6
with the same rules). The handover of the servers to the live Test server has not been run.

The account list is tested in two places: the daemon's client, the access list's answers (an owner, a panel operator, an ADMIN with access.manage, a refusal, an unavailable website)
and the Access screen's notices, against a fake website; and the
website's `/api/panel/accounts` route, against the website's test database. That test replaces the Auth.js cookie with a fixed user id, so the
live role lookup is exercised but the cookie is not. Neither has run against the live website.

The start-with-the-machine choice is verified with a fake systemd in the test suite: a unit is enabled or disabled as the choice changes, a refusal leaves the choice as it was, and the choice is read back from each unit when the panel starts. A real user manager has not been used for it, and a reboot has not been run.

Simulated on the development machine, not on the live server: a sign-in walkthrough against a copy of the website with a test owner account (API calls, not a browser), the calls the screens make, and a copy of the Test server through the panel (add, start to Done, console, backup, stop, remove). A move with the old process still running was refused by the world lock until that process stopped. The copied Test world did not load on Paper 26.3. `docs/RUNBOOK.md` records the steps and what broke.
