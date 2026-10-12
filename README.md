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

Check every row before you start. Each **Expect** cell must match. If it does not, do the step named in **If not** first.

| Requirement | Run | Expect | If not |
|---|---|---|---|
| systemd with a user manager | `systemctl --user is-system-running` | `running` or `degraded` | Log in to a session on this machine, then check again |
| systemd 259 or newer | `systemctl --version` | the first line starts with `systemd 259`, or a higher number | The installer warns on older versions. The panel is tested on 259 |
| Lingering | `loginctl show-user "$USER" -p Linger` | `Linger=yes` | Step 4 |
| Node.js 22.12 or newer | `node -v` | `v22.12.0` or higher | Step 1 |
| `tar` | `tar --version` | the first line starts with `tar` | Step 1 |
| `zstd`, optional | `zstd --version` | a line containing `Zstandard` | Without `zstd`, backups are `.tar.gz` |
| Java, optional, for Paper servers | `java -version` | a line starting with `openjdk version` or `java version` | Step 1 |
| The JASS website, on loopback | `curl -i http://127.0.0.1:3000/api/panel/session` | `HTTP/1.1 401 Unauthorized` and a JSON body | Step 3a |
| Caddy 2 | `caddy version` | a line starting with `v2.` | Step 1 |
| **Local test:** the local site port is free (this guide uses `8080`) | `ss -ltn \| grep ':8080 '` | no output | Choose another free port, and use it everywhere this guide says `8080` |
| **Live:** DNS | `getent hosts justasimpleserver.net` | an address that belongs to this server | Point the DNS record for `justasimpleserver.net` at this server, then wait for it to update |
| **Live:** ports 80 and 443 | `ss -ltn \| grep -E ':(80\|443) '` | a listener on `:80` and one on `:443`, once Caddy runs (step 3c) | Caddy must run. Another program on either port blocks it |

Nothing depends on a particular account name or directory.

## Install

This guide installs the panel beside a JASS website that already runs behind Caddy. The panel and the game servers belong to one Linux account. The guide covers two installs:

- a **local test install** on this machine, for the website at `http://127.0.0.1:3000`, and
- a **live install** on the server behind `https://justasimpleserver.net`.

Where a line differs between the two, it starts with **Local test:** or **Live:**. Read only the lines for the install you are doing. Lines with no label apply to both.

Do the steps in order, and do not go on until each **Expect** line matches. If a step fails, its **Stop if** line says what to do. The [Troubleshooting](#troubleshooting) section lists the exact messages.

**Choose your install**

| | Local test install | Live install |
|---|---|---|
| Where the website runs | This machine, at `http://127.0.0.1:3000` | This server, at `http://127.0.0.1:3000`, behind Caddy |
| Site address (what people type into the browser) | `http://127.0.0.1:8080` | `https://justasimpleserver.net` |
| `PANEL_PUBLIC_ORIGIN` and the website's `AUTH_URL` | The site address | The site address |
| `SITE_INTERNAL_URL` (where the panel asks the website who is signed in) | `http://127.0.0.1:3000` | `http://127.0.0.1:3000` |
| Caddy site block, first line | `http://127.0.0.1:8080 {` | `justasimpleserver.net {` |
| HTTPS | None. Plain HTTP | Caddy obtains the certificate for `justasimpleserver.net` by itself |
| DNS | Not needed | `justasimpleserver.net` must point at this server |
| Panel address in the browser | `http://127.0.0.1:8080/panel/` | `https://justasimpleserver.net/panel/` |

**Before you start**

- If the website is a copy of the live site, with real accounts in its database, do not use this guide. Use [Testing against a copy of the live website](#testing-against-a-copy-of-the-live-website) instead. That copy must not sit behind Caddy.
- The steps were tested on Ubuntu 26.04 with systemd 259, Node.js 22.22, OpenJDK 25.0.4, Paper 26.3 build 141 and Caddy 2.11.6. On other versions, read each **Expect** line before you go on.

**Words used in this guide**

- **Terminal:** the window where you type commands.
- **Checkout:** the folder that holds the panel's code. It contains `scripts/install.sh`.
- **Loopback:** this machine only, at the address `127.0.0.1`.
- **Site address:** the address people type into their browser to reach the website. The panel calls it `PANEL_PUBLIC_ORIGIN`.
- **`sudo`:** runs one command as the administrator. It asks for your password.

**How each step is laid out**

- **Run:** a command to type in a terminal. Run it as your own account, unless the command starts with `sudo`.
- **Expect:** what the output must show before you go on.
- **Stop if:** what a different output means, and what to do about it.

### Values and files

**Values you will set**

| Value | Local test install | Live install | Where it lives |
|---|---|---|---|
| `PANEL_PUBLIC_ORIGIN` | `http://127.0.0.1:8080` | `https://justasimpleserver.net` | `~/.config/jass-panel/panel.env` |
| `AUTH_URL` (website) | `http://127.0.0.1:8080` | `https://justasimpleserver.net` | The website's `.env.production`. Step 3a shows how to find and check it |
| `SITE_INTERNAL_URL` | `http://127.0.0.1:3000` | `http://127.0.0.1:3000` | `~/.config/jass-panel/panel.env` |
| `PANEL_PORT` | `29200` | `29200` | `~/.config/jass-panel/panel.env`. The Caddy snippet must match |
| `PANEL_BASE_PATH` | `/panel` | `/panel` | `~/.config/jass-panel/panel.env`. The Caddy snippet must match |
| Caddy site block | `http://127.0.0.1:8080 {` | `justasimpleserver.net {` | `/etc/caddy/Caddyfile` |

In the checks in steps 3c, 8 and 9, **`SITE`** means the site address. It must match `PANEL_PUBLIC_ORIGIN` exactly, including the scheme. Set it in each terminal you use.

**Local test:**

```sh
SITE=http://127.0.0.1:8080
```

**Live:**

```sh
SITE=https://justasimpleserver.net
```

**The local test port is an example.** This guide uses port `8080` for the local test everywhere: `SITE`, `PANEL_PUBLIC_ORIGIN`, the website's `AUTH_URL`, the Caddy site block and Repair A. If your Caddy site for the website uses another port, use that port in all of them. The port is on the first line of that site block (step 3b).

**What `panel.env` must contain** after step 6.

**Local test:**

```text
PANEL_PUBLIC_ORIGIN=http://127.0.0.1:8080
SITE_INTERNAL_URL=http://127.0.0.1:3000
PANEL_PORT=29200
PANEL_BASE_PATH=/panel
```

**Live:**

```text
PANEL_PUBLIC_ORIGIN=https://justasimpleserver.net
SITE_INTERNAL_URL=http://127.0.0.1:3000
PANEL_PORT=29200
PANEL_BASE_PATH=/panel
```

Keep one `NAME=value` per line. Do not add comments or quotes.

**Files this guide creates or uses**

| File or folder | Written by | Edit it yourself? |
|---|---|---|
| `~/.config/jass-panel/panel.env` | The installer, step 6. An existing file is kept | Yes, to change the site address. Then run `systemctl --user restart jass-panel` |
| `~/.config/systemd/user/jass-panel.service` | The installer, step 6 | No. Run the installer again from the checkout to change it |
| `<checkout>/dist/server/main.js` | `npm run build`, step 5 | No |
| `~/.local/share/jass-panel/` | The panel | No. Deleting it removes the panel's database and backups (see Uninstall) |
| `/etc/caddy/Caddyfile` | Provisioning, or you, step 3b. Find the path with `systemctl cat caddy --no-pager` (look for `--config`) | Yes, with `sudo`, for the refusal, the import and the website's proxy line |
| The website's `.env.production` (holds `AUTH_URL`) | The website's deploy, or you, step 3a | Yes, for `AUTH_URL`. Step 3a shows how to find it and recreate the website |
| `/etc/caddy/conf.d/jass-panel.caddy` | You, step 7 | No. Run step 7 again to change it |

### 1. Install the requirements

Both installs need these.

**Run** on Ubuntu 26.04, the tested system:

```sh
sudo apt update
sudo apt install nodejs npm tar zstd openjdk-25-jre-headless
```

**Expect:** no line starting with `E:`, which is apt's error prefix.

**Run:**

```sh
node -v
```

**Expect:** `v22.12.0` or higher.

**Stop if** the version is older: install Node.js 22.12 or newer another way, such as NodeSource or nvm. The installer uses the `node` that your terminal's `PATH` finds first, so check it in the terminal you will run the installer from.

**Install Caddy 2** from Caddy's own package repository, not from the Ubuntu archive, whose package is version 2.6. See <https://caddyserver.com/docs/install>.

**Run:**

```sh
caddy version
```

**Expect:** a line starting with `v2.` and a version number.

- `zstd` is optional. Without it, backups are `.tar.gz`. Java is needed only for Paper servers. On other systems, install the same tools with that system's package names.

### 2. Get the code

Both installs need this. Put the checkout in the folder where you will keep it. The installer writes that folder's full path into the systemd unit, so do not use a temporary folder or the Trash. If you move the folder later, run the installer again from its new location (step 6).

**Run**, from the checkout's top folder:

```sh
ls scripts/install.sh package.json
```

**Expect:** both names are printed.

**Stop if** you see `No such file or directory`: you are not in the checkout's top folder. Change to it with `cd`, then run the command again.

### 3. Website and Caddy

There are three checks, in order: **3a** the website, **3b** the website's Caddyfile, and **3c** Caddy.

**3a. The website answers and has the panel's routes.** Deploy the website version that has the panel routes, following the website's deploy document (`docs/DEPLOYMENT.md` in the website repository). It covers the migrations, the pages-only seed and checking for `/panel` page collisions.

**Local test:** the website runs on this machine. The panel reaches it at `127.0.0.1:3000`, which is `SITE_INTERNAL_URL`. Set the website's `AUTH_URL` to `http://127.0.0.1:8080`.

**Live:** the website runs on this server. The check below must work on `127.0.0.1:3000`. If your website listens on another loopback port, use that port everywhere this guide says `3000`. Set the website's `AUTH_URL` to `https://justasimpleserver.net`.

**Run** (both installs):

```sh
curl -i http://127.0.0.1:3000/api/panel/session
```

**Expect:** `HTTP/1.1 401 Unauthorized` and a JSON body. The `401` is correct: it means the route exists and nobody is signed in.

**Stop if** you see `404`: the panel routes are not deployed yet. If nothing answers at all, the website is not running on port 3000.

**Live: `/panel` may already belong to the website.** Before the panel is installed, `/panel` on the live site can be a page of the website. Once step 7 is done, Caddy sends `/panel` and `/panel/*` to the panel, so that page is no longer reachable through Caddy. The website's deploy document asks you to check for `/panel` page collisions for this reason. Make sure the change is what you want before you go on.

If the website has no OWNER account yet, create one on the website's machine, in the website's folder, with its environment. Only do this for an email that has no account yet. Read [Existing website and accounts](#existing-website-and-accounts) first.

```sh
npm run create-admin -- <email> <password> --role OWNER
```

The panel adds no environment variable to the website and needs no database change.

**The website's `AUTH_URL`** must equal the site address from step 6. It is set in the website's `.env.production`. To find the file and check the running value:

1. Find the folder of the website's Docker Compose project. Run:

   ```sh
   sudo docker compose ls
   ```

   **Expect:** a line for the website's project, with its `docker-compose.yml` path under `CONFIG FILES`.

2. Check the running value. Replace the path with the one from step 1:

   ```sh
   sudo docker compose -f /path/to/docker-compose.yml exec web printenv AUTH_URL
   ```

   **Expect:** the site address.

   **Stop if** it is not: edit `.env.production` in the same folder as `docker-compose.yml` and set `AUTH_URL=` to the site address. Then recreate the website's container so it reads the file: `sudo docker compose -f /path/to/docker-compose.yml up -d --force-recreate web`. Run step 2 again.

If the website does not run under Docker Compose, set `AUTH_URL` where the website reads it, restart the website, and check the value. On a VPS provisioned from the website's repository, provisioning already set `AUTH_URL` to `https://<domain>`, so check it rather than change it.

**3b. The website's Caddyfile refuses the panel's API and imports the snippet.**

Find the site block that serves the website. Its first line is the site address.

**Local test:** the block is `http://127.0.0.1:8080 {`. If you do not have one, add this whole block. Its last `reverse_proxy` line is the link to the website on this machine: every request that is not the panel's goes to `127.0.0.1:3000`.

```caddy
http://127.0.0.1:8080 {
    @panel_api path /api/panel /api/panel/*
    handle @panel_api {
        respond 404
    }
    import /etc/caddy/conf.d/*.caddy
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

**Live:** the block is `justasimpleserver.net {`. Keep everything it already has. On a VPS provisioned from the website's repository, this file already has these lines, because provisioning installs it: check it, and do not copy them in by hand. Make sure it contains the refusal and the import below, and that its catch-all `handle` block proxies to `127.0.0.1:3000`.

```caddy
justasimpleserver.net {
    @panel_api path /api/panel /api/panel/*
    handle @panel_api {
        respond 404
    }
    import /etc/caddy/conf.d/*.caddy
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

Use `handle` for the refusal, not a bare `respond`. In tests with Caddy 2.11.6, a bare `respond` next to the website's `handle` block did not stop `/api/panel` requests from reaching the website. Step 8 checks that the refusal works.

**Run** (both installs):

```sh
grep -n -E 'conf.d|api/panel' /etc/caddy/Caddyfile
```

**Expect:** two lines, both inside that site block:

- `import /etc/caddy/conf.d/*.caddy`
- `@panel_api path /api/panel /api/panel/*`

**Stop if** either line is missing: add the lines from the example for your install inside the site block, then run the grep again.

**Run:**

```sh
grep -n '@panel' /etc/caddy/Caddyfile
```

**Expect:** only lines that contain `@panel_api`.

**Stop if** another matcher is named `@panel`: rename it, because the panel's snippet defines `@panel`.

**Check the website's proxy line.** The catch-all `handle` block of your site must send the website's requests to `127.0.0.1:3000`. **Run:**

```sh
grep -n 'reverse_proxy' /etc/caddy/Caddyfile
```

**Expect:** a line `reverse_proxy 127.0.0.1:3000` for the website. Other `reverse_proxy` lines may belong to other sites in the file.

**Stop if** the website's line names another port, such as `127.0.0.1:4000`. Nothing answers there, so Caddy returns `502` for the website. Change the port to `3000`, then validate and reload with the command in step 7d.

**3c. Caddy is valid and running.**

**Run** (both installs):

```sh
systemctl cat caddy --no-pager
```

**Expect:** an `ExecStart=` line that contains `--config`, followed by a file path. This guide uses `/etc/caddy/Caddyfile`.

**Stop if** the path is different: use that path in every command in this guide instead of `/etc/caddy/Caddyfile`. **Stop if** systemd cannot find `caddy.service`: install Caddy so that it provides that service, then check again.

**Run:**

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

**Expect:** several log lines, and the last line is `Valid configuration`. Until step 7 writes the snippet, a warning that the import pattern matches no files is expected.

**Stop if** the last line is not `Valid configuration`: read the error, fix the Caddyfile, and run the command again.

**Run:**

```sh
systemctl is-active caddy
```

**Expect:** `active`.

**Stop if** it prints `inactive` or `failed`. Start Caddy, and make it start at boot too:

```sh
sudo systemctl enable --now caddy
systemctl is-active caddy
```

**Expect:** `active`.

**Stop if** it is still not active: run `sudo journalctl -u caddy -n 50 --no-pager`. The reason is among the last few lines. Fix it, then start Caddy again.

**Run** the website check through Caddy, then directly.

**Local test:**

```sh
SITE=http://127.0.0.1:8080
curl -s -o /dev/null -w '%{http_code}\n' "$SITE/"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

**Live:**

```sh
SITE=https://justasimpleserver.net
curl -s -o /dev/null -w '%{http_code}\n' "$SITE/"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

**Expect:** the same number on both lines, normally `200`.

**Stop if** the first number is `000`, with `curl` exit code 7 (connection refused). Nothing listens at `SITE`, so the port in `SITE` is not the port your Caddy site uses. Take the port from the first line of your Caddy site block (step 3b), use that address for `SITE`, `PANEL_PUBLIC_ORIGIN` and the website's `AUTH_URL`, then repeat this step.

**Stop if** the first number is `502`: Caddy cannot reach the website. Run the `reverse_proxy` check in step 3b, and set the website's port to `3000`.

**Stop if** the numbers differ in any other way, see Troubleshooting.

**Live only: ports and certificate.** **Run:**

```sh
ss -ltn | grep -E ':(80|443) '
```

**Expect:** a listener on port 80 and one on port 443, from Caddy. Caddy needs both to obtain the certificate for `justasimpleserver.net`.

**Stop if** the live `curl` above reports a certificate problem: see Troubleshooting, "Live: `curl` reports a certificate problem".

### 4. Turn lingering on

Both installs need this. Lingering keeps your user manager running after logout, and starts your enabled user services at boot. The panel and its game servers depend on it.

**Run:**

```sh
loginctl show-user "$USER" -p Linger
```

**Expect:** `Linger=yes`.

**Stop if** it prints `Linger=no`: run the command below. It asks for your password and prints nothing on success. Then run the check above again.

```sh
sudo loginctl enable-linger "$USER"
```

The installer offers the same command when it runs in a terminal, and the Health screen can run it later.

### 5. Build the panel

Both installs need this. **Run**, in the checkout folder:

```sh
cd /path/to/JASS-Panel
npm ci
npm run build
ls dist/server/main.js web/dist/index.html
```

**Expect:**

- `npm ci` prints a line starting with `added`.
- `npm run build` prints a line starting with `✓ built in`. A warning about large chunks is harmless.
- `ls` prints both paths.

**Stop if** any line contains `ERR!` or `error`: read it, fix it, and run the three commands again.

### 6. Run the installer

Run it in a terminal, as your own account, from the checkout folder. Do not use `sudo`: the installer writes into your home folder and manages your own user services.

The panel runs the program from the folder the installer was started in. Keep the checkout where it is. A copy in the Trash, or a folder you move later, stops the panel once that folder is gone. [Repair B](#repair-b-run-the-installer-from-your-checkout) fixes that.

**Check the folder first.** **Run** in the checkout folder:

```sh
pwd
```

**Expect:** the checkout path, such as `/path/to/JASS-Panel`.

**Stop if** it shows a Trash folder or another copy: change to the checkout with `cd`, then run `pwd` again.

**Check the port.** Before the first install, nothing else may listen on port `29200`. **Run:**

```sh
ss -ltn | grep ':29200 '
```

**Expect:** no output.

**Run** the installer for your install. The site address must match step 3b.

**Local test:**

```sh
cd /path/to/JASS-Panel
PANEL_PUBLIC_ORIGIN=http://127.0.0.1:8080 scripts/install.sh
```

**Live:**

```sh
cd /path/to/JASS-Panel
PANEL_PUBLIC_ORIGIN=https://justasimpleserver.net scripts/install.sh
```

`PANEL_PUBLIC_ORIGIN` is the site address: the scheme, the host and an optional port, with no path. The installer removes a trailing slash.

**Expect**, on the first run, these lines in this order:

- `install: wrote …/panel.env.`
- `install: wrote …/jass-panel.service.`
- `Created symlink …`, a line about `default.target.wants`
- `install: started the panel.`
- A blank line, then `This script does not change the proxy.` and the proxy block for step 7.

`install: started the panel.` means systemd accepted the start. It does not prove the panel stays up. The checks below do.

**Expect**, on a later run with no changes: `install: kept …/panel.env` and `install: unit … is unchanged.` In that case the installer does not restart a running panel. After you rebuild, restart it yourself with `systemctl --user restart jass-panel`.

**Stop if** an `install:` line says a check failed, such as `the daemon is not built` or `lingering is off`. The message says what to fix. Fix it, then run the installer again.

An existing `panel.env` is kept, and the installer does not change the address in it. If you pass a different `PANEL_PUBLIC_ORIGIN`, it warns and keeps the file's value. To change the address, use [Repair A](#repair-a-fix-the-site-address). To start over, see [Uninstall](#uninstall).

**Check the site address.** **Run:**

```sh
grep PANEL_PUBLIC_ORIGIN ~/.config/jass-panel/panel.env
```

**Local test: expect** `PANEL_PUBLIC_ORIGIN=http://127.0.0.1:8080`.

**Live: expect** `PANEL_PUBLIC_ORIGIN=https://justasimpleserver.net`.

**Stop if** the value is different, has the wrong scheme, or names `127.0.0.1:3000`. That address is the website's port, not the site address. Use [Repair A](#repair-a-fix-the-site-address).

**Check the folder.** **Run:**

```sh
grep '^WorkingDirectory=' ~/.config/systemd/user/jass-panel.service
```

**Expect:** `WorkingDirectory=` followed by the checkout folder you ran the installer from. The `pwd` check above printed the same path.

**Stop if** it names a Trash folder or any other copy: use [Repair B](#repair-b-run-the-installer-from-your-checkout).

**Check the service.** **Run:**

```sh
systemctl --user is-active jass-panel
```

**Expect:** `active`.

**Stop if** it prints `activating`: the panel exits right after it starts, and systemd keeps restarting it. Run `journalctl --user -u jass-panel -n 30 --no-pager`. The line just before each `Main process exited` line says why. A `PANEL_PUBLIC_ORIGIN` message means [Repair A](#repair-a-fix-the-site-address). `Cannot find module` means [Repair B](#repair-b-run-the-installer-from-your-checkout).

**Check the startup line.** **Run:**

```sh
journalctl --user -u jass-panel --no-pager | grep 'panel listening on loopback'
```

**Expect:** at least one line containing `panel listening on loopback`.

#### Repair A: fix the site address

Use this when the site address check fails, or the journal shows a `PANEL_PUBLIC_ORIGIN` message. The installer keeps `panel.env`, so fix the file, and do not pass a different `PANEL_PUBLIC_ORIGIN` to the installer. The commands below use port `8080`, the example in this guide. If your Caddy site uses another port, use that port in the value.

**Local test: run**

```sh
sed -i 's|^PANEL_PUBLIC_ORIGIN=.*|PANEL_PUBLIC_ORIGIN=http://127.0.0.1:8080|' ~/.config/jass-panel/panel.env
grep PANEL_PUBLIC_ORIGIN ~/.config/jass-panel/panel.env
systemctl --user restart jass-panel
systemctl --user is-active jass-panel
```

**Live: run**

```sh
sed -i 's|^PANEL_PUBLIC_ORIGIN=.*|PANEL_PUBLIC_ORIGIN=https://justasimpleserver.net|' ~/.config/jass-panel/panel.env
grep PANEL_PUBLIC_ORIGIN ~/.config/jass-panel/panel.env
systemctl --user restart jass-panel
systemctl --user is-active jass-panel
```

**Expect:** the `grep` line shows the value for your install, and the last line prints `active`.

**Stop if** the `grep` prints nothing: the file has no `PANEL_PUBLIC_ORIGIN` line. Open the file in an editor, add `PANEL_PUBLIC_ORIGIN=` followed by the value for your install, save, then run the `systemctl` lines again.

**Stop if** `is-active` still prints `activating`: read the journal, as in "Check the service" above. If it says `Cannot find module`, use Repair B.

#### Repair B: run the installer from your checkout

Use this when the folder check fails, or the journal says `Cannot find module`. The panel runs from the folder the installer was started in. This repair points it at your checkout. Do [Repair A](#repair-a-fix-the-site-address) first if the site address is also wrong, because the installer keeps the value in `panel.env`.

**Run:**

```sh
cd /path/to/JASS-Panel
npm ci
npm run build
scripts/install.sh
```

**Expect**, in the installer output:

- `install: kept …/panel.env`, because the installer reads the site address from the file.
- `install: wrote …/jass-panel.service.`
- `install: restarted the panel to pick up the new unit.`, or `install: started the panel.` if the panel was stopped.

**Stop if** the output says `has no PANEL_PUBLIC_ORIGIN line` or `give the website's public origin`: do [Repair A](#repair-a-fix-the-site-address) first, then run the installer again.

**Run:**

```sh
grep '^WorkingDirectory=' ~/.config/systemd/user/jass-panel.service
systemctl --user is-active jass-panel
```

**Expect:** `WorkingDirectory=` followed by your checkout path, and then `active`.

After either repair, check the site address, the folder, the service and the startup line again, in that order. The Trash copy is no longer used once Repair B is done, so you can delete it.

### 7. Serve the panel through Caddy

Both installs use the same snippet. Caddy must be active (step 3c). This step adds the panel's route and reloads Caddy. On a live VPS this is the one Caddy step that provisioning does not do: the website's deploy document says the operator writes it.

**7a. Check the port and path.** **Run:**

```sh
grep -E '^(PANEL_PORT|PANEL_BASE_PATH)=' ~/.config/jass-panel/panel.env
```

**Expect:** `PANEL_PORT=29200` and `PANEL_BASE_PATH=/panel`.

**Stop if** the values differ: use the block the installer printed in step 6 instead of the block below, because it has your values.

**7b. Write the snippet.** **Run:**

```sh
sudo mkdir -p /etc/caddy/conf.d
sudo tee /etc/caddy/conf.d/jass-panel.caddy >/dev/null <<'EOF'
@panel path /panel /panel/*
handle @panel {
    reverse_proxy 127.0.0.1:29200
}
EOF
```

**Expect:** no output. Paste all of it, including the closing `EOF` line.

**Stop if** the terminal shows a `>` prompt: the closing `EOF` line is missing. Press Ctrl+C and paste the whole block again.

**7c. Check the snippet.** **Run:**

```sh
cat /etc/caddy/conf.d/jass-panel.caddy
```

**Expect:** exactly these lines:

```text
@panel path /panel /panel/*
handle @panel {
    reverse_proxy 127.0.0.1:29200
}
```

**7d. Validate and reload.** **Run:**

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

**Expect:** the last line of the validation output is `Valid configuration`. The reload prints nothing.

**Stop if** `Valid configuration` is missing: the reload did not run, and Caddy keeps its previous configuration. Read the error, fix it, and run this command again. If the reload itself fails, `sudo journalctl -u caddy -n 50 --no-pager` shows why.

Caddy takes one matcher per `handle` block, so the paths sit in a named `path` matcher. Writing `handle /panel /panel/*` is a parse error.

### 8. Check it

Set `SITE` in this terminal to your site address, as in Values and files.

**Local test:**

```sh
SITE=http://127.0.0.1:8080
```

**Live:**

```sh
SITE=https://justasimpleserver.net
```

**Local test:** no DNS is involved. **Live:** the name must resolve to this server (step 3c). The checks connect to whatever the name points to, so if the name points at another server, the results describe that server.

Run the checks in order. The GET requests use `-i`, not `-I`. The panel answers a HEAD request (`curl -I`) with `404`, so `-I` gives a false failure.

**8.1 The service runs.** **Run** `systemctl --user is-active jass-panel`. **Expect** `active`. **Run** `systemctl --user is-enabled jass-panel`. **Expect** `enabled`.

**8.2 The daemon answers on loopback**, without Caddy. **Run** (both installs):

```sh
curl -s -i http://127.0.0.1:29200/panel/api/v1/me
```

**Expect:** `HTTP/1.1 401 Unauthorized`, and a body containing `"code":"unauthenticated"`.

**Stop if** you see `Connection refused`: the panel is not listening on port 29200. Check step 6.

**8.3 The panel page through Caddy.** **Run:**

```sh
curl -s -i "$SITE/panel/"
```

**Expect:** a status line showing `200`, and these headers: `content-security-policy`, `x-frame-options: DENY`, `referrer-policy: same-origin`, `x-content-type-options: nosniff` and `x-robots-tag: noindex`.

**Stop if** you see `502`: Caddy cannot reach the panel. Check that `systemctl --user is-active jass-panel` prints `active`, and that the snippet's port matches `PANEL_PORT`.

**8.4 The website's API is refused through Caddy.** **Run:**

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$SITE/api/panel/session"
curl -s -o /dev/null -w '%{http_code}\n' "$SITE/api/panel"
```

**Expect:** `404` on both lines.

**Stop if** either line shows another number: the refusal is not in effect. Fix step 3b, then run step 7d again.

**8.5 Signed out, the panel refuses you through Caddy.** **Run:**

```sh
curl -s -i "$SITE/panel/api/v1/me"
```

**Expect:** `401 Unauthorized`, and `"code":"unauthenticated"`.

**8.6 Signed in.** Follow step 9.

### 9. Sign in

**Local test:** in the browser where you are signed in to the website, open `http://127.0.0.1:8080/panel/`.

**Live:** in the browser where you are signed in to the website, open `https://justasimpleserver.net/panel/`.

**Expect:** the Servers page opens. A signed-out visitor is sent to the website's sign-in page, then back to the panel.

**Stop if** the page says `Sign-in cannot be checked right now`: the website did not confirm who you are. Check that the website answers in step 3a, and that its `AUTH_URL` equals `SITE`.

**Stop if** an action such as starting a server fails with `csrf_refused`: `PANEL_PUBLIC_ORIGIN` is not exactly the address in your browser. Correct `panel.env` (see step 6), then restart the panel.

Sign in on the website as an owner to see the Access and Health screens.

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
| `PANEL_PUBLIC_ORIGIN` | none, required | The address people type into their browser to reach the website: `https://` or `http://`, the host, an optional port, and no path, for example `https://justasimpleserver.net` (live) or `http://127.0.0.1:8080` (local test). It must equal the website's `AUTH_URL`. |
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

This removes the panel from this account. It keeps the website, the website's Caddyfile (including its import line), and every game server folder.

**1. Remove the game servers from the panel first.** On the Servers page, stop each server, then remove it. Removing a server deletes its two unit files and its panel record. The server's folder stays.

**2. Stop the panel and remove its files.** Run as your own account:

```sh
systemctl --user disable --now jass-panel
rm ~/.config/systemd/user/jass-panel.service
systemctl --user daemon-reload
rm -r ~/.config/jass-panel
```

**Expect:** the first command prints a line starting with `Removed`. Then `systemctl --user is-active jass-panel` prints `inactive`.

**3. Remove the panel's snippet from Caddy.** This needs `sudo`. The website's import line stays. While the snippet is missing, Caddy only warns that the import matches no files.

```sh
sudo rm /etc/caddy/conf.d/jass-panel.caddy
systemctl is-active caddy && sudo systemctl reload caddy
```

**Expect:** `active` (then the reload runs and prints nothing), or `inactive` (nothing is reloaded). The warning about the import is expected.

**4. Optional: delete the panel's data.** This deletes the database, the backups, the file history and the event logs. Do it only if the next install must start empty. The default folder is `~/.local/share/jass-panel`. If you set `PANEL_DATA_DIR`, delete that folder instead.

```sh
rm -r ~/.local/share/jass-panel
```

**To install again,** check install steps 3 to 5 first, then run the installer from install step 6. The installer writes a new `panel.env`, because uninstall step 2 removed the old one.

## Troubleshooting

| What you see | What it means and what to do |
|---|---|
| `install: <tool> is not installed` | Install the named tool (`tar`, `systemctl` or `loginctl`), then run the installer again. |
| `install: the systemd user manager is not running for <account>` | Log in on this machine, or run `sudo loginctl enable-linger <account>`, log in again, then run the installer again. |
| `install: lingering is off` | Step 4. Run the installer in a terminal to be offered the command. |
| `install: Node.js … or newer is needed`, or `install: Node.js is …; 22.12.0 or newer is needed.` | Install Node.js 22.12 or newer, so that `node -v` in the same terminal prints it. |
| `install: the daemon is not built` | Step 5: run `npm ci` and `npm run build` in the checkout. |
| `install: give the website's public origin` | Run the installer again with `PANEL_PUBLIC_ORIGIN=https://…` in front of the command. |
| `install: … has no PANEL_PUBLIC_ORIGIN line` | Add `PANEL_PUBLIC_ORIGIN=<site address>` to `~/.config/jass-panel/panel.env`, then run the installer again. |
| `install: warning: … already sets PANEL_PUBLIC_ORIGIN=…` | The existing `panel.env` was kept, so the new address was not written. Fix the file with [Repair A](#repair-a-fix-the-site-address). Do not pass a different address to the installer. |
| `systemctl --user is-active jass-panel` prints `activating` | The panel exits as soon as it starts, and systemd retries every 5 seconds. Run `journalctl --user -u jass-panel -n 30 --no-pager`. The line just before each `Main process exited` line says why. A `PANEL_PUBLIC_ORIGIN` message means [Repair A](#repair-a-fix-the-site-address). `Cannot find module` means [Repair B](#repair-b-run-the-installer-from-your-checkout). |
| `PANEL_PUBLIC_ORIGIN must be an absolute URL such as https://example.net` | The value has no scheme. Fix it with [Repair A](#repair-a-fix-the-site-address). |
| `PANEL_PUBLIC_ORIGIN must use http or https` | The scheme is something else. Use `https://`, or `http://` for plain HTTP. |
| `PANEL_PUBLIC_ORIGIN must be an origin only, with no path, query or credentials` | Remove everything after the host, such as `/panel`. |
| `PANEL_PUBLIC_ORIGIN is required, for example https://example.net` | `panel.env` has no value for it. Add the line, then restart the panel. |
| `SITE_INTERNAL_URL must be a loopback http URL` | Keep `http://127.0.0.1:3000`, unless the website listens on another loopback port. |
| `PANEL_PORT must be an integer from 1 to 65535` | Fix the value in `panel.env`, and use the same port in the Caddy snippet (step 7). |
| `PANEL_BASE_PATH must be an absolute path with no trailing slash, such as /panel` | Fix the value in `panel.env`, and use the same path in the Caddy snippet (step 7). |
| `403` with `wrong_host`: "This address is not served by the panel." | The `Host` in the request is neither the host of `PANEL_PUBLIC_ORIGIN` nor loopback. Make `SITE` the same address as `PANEL_PUBLIC_ORIGIN`, or fix the value with [Repair A](#repair-a-fix-the-site-address). |
| `403` with `csrf_refused`: "The request did not come from the panel's origin." | The browser's address is not exactly `PANEL_PUBLIC_ORIGIN`. Make them equal with [Repair A](#repair-a-fix-the-site-address). |
| `401` with `unauthenticated` | Expected when you are signed out. Sign in on the website (step 9). |
| `503` with `unavailable` | The panel cannot reach the website on `SITE_INTERNAL_URL`. Check step 3a. |
| `curl` reports `Connection refused` (exit code 7) | Nothing listens at that address and port. Compare `sudo ss -ltnp` with your site address from step 3b. |
| **Local test:** `curl` reports `Connection refused` on `127.0.0.1:8080` | Caddy is not serving the local site. Check that the site block's first line is `http://127.0.0.1:8080 {`, that `systemctl is-active caddy` prints `active`, and that `ss -ltn` lists `127.0.0.1:8080`. |
| **Live:** `curl` reports a certificate problem | Caddy has not obtained a certificate for `justasimpleserver.net` yet. Check that `getent hosts justasimpleserver.net` shows this server, that ports 80 and 443 reach this server, and read `sudo journalctl -u caddy -n 50 --no-pager`. |
| `000` with `curl` exit code 7 for `SITE` | Nothing listens at `SITE`. The port in `SITE` is not the port of your Caddy site. Use the port on the first line of your Caddy site block, everywhere it appears (step 3c). |
| Caddy journal shows `dial tcp 127.0.0.1:NNNN: connect: connection refused` | Caddy sends a request to a port where nothing listens. For the website, set the `reverse_proxy` target to `127.0.0.1:3000` (step 3b), then validate and reload. |
| `502` from Caddy on `/panel/` | Caddy cannot reach the panel. Check that the panel is `active`, and that the snippet's port matches `PANEL_PORT`. |
| `502` from Caddy on the website's `/` | Caddy's upstream for the website is not the port the website answers on. The website answers `200` on `http://127.0.0.1:3000/` directly. Set the website's `reverse_proxy` target to `127.0.0.1:3000` (step 3b), then validate and reload. |
| The checks pass on `127.0.0.1` but fail on your public name | The name points somewhere else. `getent hosts <name>` prints the addresses it points to. They must be this machine's. |
| After a rebuild, the panel still runs old code | The installer does not restart a running panel that did not change. Run `systemctl --user restart jass-panel`. |
| The unit's `WorkingDirectory=` names a Trash folder or another copy | [Repair B](#repair-b-run-the-installer-from-your-checkout). The panel runs from the folder the installer was started in. |
| `caddy.service is not active, cannot reload.` | Caddy is stopped, so there is nothing to reload. Step 3c starts it. |
| `sudo: caddy: command not found` | Use the full path, for example `sudo "$(command -v caddy)" validate --config /etc/caddy/Caddyfile --adapter caddyfile`. |
| Caddy will not start, and its journal shows a bind error | Another program holds port 80 or 443. `sudo ss -ltnp \| grep -E ':(80\|443) '` shows which one. Stop it, then start Caddy again. |
| `curl -I https://…/panel/` answers `404` | `-I` sends a HEAD request, which the panel answers with `404`. Use `curl -i`, which answers `200`. |
| `curl -i https://…/api/panel/session` answers anything but `404` | The refusal is not in effect. Make it a `handle @panel_api { respond 404 }` block (step 3b), then run step 7 again. |
| The panel URL shows the website's page, or no panel headers | The import is missing from the website's Caddyfile, the snippet was not written, or Caddy was not reloaded or started after the snippet was written. See step 7. |
| `Sign-in cannot be checked right now` | The website did not confirm who you are. Check that it answers on `127.0.0.1:3000` (step 3a), that its `/api/panel/session` route is deployed, and that its `AUTH_URL` equals `PANEL_PUBLIC_ORIGIN`. |
| `No access to anything yet` | The account is an ADMIN with no grants. An owner grants it something on Access. |
| Access says the accounts could not be listed | The website could not be asked for its accounts. Check that it is up and that `/api/panel/accounts` answers `401` without a cookie. The list then shows only people the panel has seen. |
| Access says only owners and panel operators can list the website's accounts | Expected for an ADMIN with `access.manage`: the screen shows the people this panel has seen. |
| `The server stopped while it was starting. The journal has the reason.` | The unit stopped during start. Read `journalctl --user -u jass-mc-<id>.service`. A world another process still holds is a common cause: stop the old process first. |
| `The server did not report that it had finished loading within five minutes` | The server was left running. Check its log; it may still be loading, or it may not print a `Done` line. |
| `The panel could not confirm that the server started.` | Do not start it again. Read its state on the page, and check its journal, until the state is clear. |
| `Stop the server before restoring it.` | Stop the server, then restore. |
| `The unit file was edited by hand` | The panel shows the server but does not overwrite that file. Change it by hand, or remove it by hand, as the message says. |
| Servers stop when you log out, or do not start at boot | Lingering is off (step 4), or the server's *Starts with the machine* is off. |
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
