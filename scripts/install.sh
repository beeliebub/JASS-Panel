#!/usr/bin/env bash
# Installs the panel daemon as this account's user unit. It takes one input, the website's public origin, and changes nothing outside
# the panel's configuration and unit. It prints (never applies) the reverse-proxy block and any linger command. Running it twice
# changes nothing the second time. A failed check stops the script with the exact fix.
set -euo pipefail

readonly MIN_NODE="22.12.0"
readonly MIN_SYSTEMD=259
readonly UNIT="jass-panel.service"

checkout="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
env_dir="$config_home/jass-panel"
env_file="$env_dir/panel.env"
unit_dir="$config_home/systemd/user"
unit_file="$unit_dir/$UNIT"

fail() { printf 'install: %s\n' "$1" >&2; exit 1; }
say() { printf 'install: %s\n' "$1"; }

# The last value of a key in the environment file, which is the one systemd uses, without quotes or carriage returns.
env_value() { sed -n "s/^$1=//p" "$env_file" | tail -n 1 | tr -d "\"'\r"; }

# True when version $1 is at least $2 (major.minor.patch). Avoids sort -V, which a minimal system may lack.
version_at_least() {
  local IFS=.
  local -a have need
  read -r -a have <<< "$1"
  read -r -a need <<< "$2"
  local i
  for i in 0 1 2; do
    if (( ${have[i]:-0} > ${need[i]:-0} )); then return 0; fi
    if (( ${have[i]:-0} < ${need[i]:-0} )); then return 1; fi
  done
  return 0
}

# A plain unit value still expands %specifiers, so a literal % is doubled.
systemd_value() { printf '%s' "${1//%/%%}"; }

# An ExecStart argument: a literal \, ", %, or $ is escaped so systemd passes it through unchanged.
systemd_arg() {
  local value="${1//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  value="${value//\$/\$\$}"
  printf '"%s"' "$value"
}

for tool in tar systemctl loginctl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed. Install it, then run this script again."
done

command -v node >/dev/null 2>&1 || fail "Node.js $MIN_NODE or newer is needed. Install it, then run this script again."
node_path="$(readlink -f "$(command -v node)")"
node_version="$("$node_path" -p 'process.versions.node')"
version_at_least "$node_version" "$MIN_NODE" || fail "Node.js is $node_version; $MIN_NODE or newer is needed."

[[ -f "$checkout/dist/server/main.js" ]] || fail "the daemon is not built. Run 'npm ci && npm run build' in $checkout, then run this script again."

case "$(systemctl --user is-system-running 2>/dev/null || true)" in
  running|degraded) ;;
  *) fail "the systemd user manager is not running for $USER. Log in to a session on this machine (or run 'sudo loginctl enable-linger $USER' and log in again), then run this script again." ;;
esac

linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
if [[ "$linger" != "yes" && -t 0 ]]; then
  say "lingering is off. The command that turns it on is: sudo loginctl enable-linger $USER"
  read -r -p "install: run that now with sudo (it asks for your password here)? [y/N] " answer
  if [[ "$answer" == [yY]* ]] && sudo loginctl enable-linger "$USER"; then linger=yes; fi
fi
[[ "$linger" == "yes" ]] || fail "lingering is off, so the panel and its servers would stop at logout and not start at boot. Run 'sudo loginctl enable-linger $USER', then run this script again."

systemd_version="$(systemctl --version | sed -n 's/^systemd \([0-9]*\).*/\1/p' | head -n 1)"
if [[ -z "$systemd_version" ]]; then
  say "warning: could not read the systemd version; the units are tested only on systemd $MIN_SYSTEMD."
elif (( systemd_version < MIN_SYSTEMD )); then
  say "warning: systemd $systemd_version is older than $MIN_SYSTEMD, the only version the units have been tested on. Continuing."
fi

origin="${PANEL_PUBLIC_ORIGIN:-}"
if [[ -z "$origin" && -f "$env_file" ]]; then
  origin="$(env_value PANEL_PUBLIC_ORIGIN)"
fi
origin="${origin%/}"
[[ -n "$origin" ]] || fail "give the website's public origin, for example PANEL_PUBLIC_ORIGIN=https://example.net $0"

mkdir -p "$env_dir" "$unit_dir"
chmod 0700 "$env_dir"
if [[ -f "$env_file" ]]; then
  existing_origin="$(env_value PANEL_PUBLIC_ORIGIN)"
  existing_origin="${existing_origin%/}"
  [[ -n "$existing_origin" ]] || fail "$env_file has no PANEL_PUBLIC_ORIGIN line. Add PANEL_PUBLIC_ORIGIN=<the website's public origin> to it, then run this script again."
  if [[ "$origin" != "$existing_origin" ]]; then
    say "warning: $env_file already sets PANEL_PUBLIC_ORIGIN=$existing_origin, so $origin was not written. Edit the file to change it, then restart the panel."
  fi
  say "kept $env_file (edit it to change the origin, port or base path)."
else
  umask 077
  printf 'PANEL_PUBLIC_ORIGIN=%s\nSITE_INTERNAL_URL=http://127.0.0.1:3000\nPANEL_PORT=29200\nPANEL_BASE_PATH=/panel\n' "$origin" > "$env_file.tmp"
  mv "$env_file.tmp" "$env_file"
  say "wrote $env_file."
fi

port="$(env_value PANEL_PORT)"
port="${port:-29200}"
base_path="$(env_value PANEL_BASE_PATH)"
base_path="${base_path:-/panel}"

unit_text="$(cat <<EOF
# Managed by $checkout/scripts/install.sh. Edit the environment file, not this unit.
[Unit]
Description=JASS Panel (control panel for Minecraft servers)
After=network.target

[Service]
Type=simple
WorkingDirectory=$(systemd_value "$checkout")
EnvironmentFile=$(systemd_value "$env_file")
ExecStart=$(systemd_arg "$node_path") $(systemd_arg "$checkout/dist/server/main.js")
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
)"

unit_changed=1
if [[ -f "$unit_file" ]] && [[ "$(cat "$unit_file")" == "$unit_text" ]]; then
  say "unit $unit_file is unchanged."
  unit_changed=0
else
  printf '%s\n' "$unit_text" > "$unit_file.tmp"
  mv "$unit_file.tmp" "$unit_file"
  say "wrote $unit_file."
fi

systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null
if systemctl --user is-active --quiet "$UNIT"; then
  if (( unit_changed )); then
    systemctl --user restart "$UNIT"
    say "restarted the panel to pick up the new unit. Servers keep running."
  fi
else
  systemctl --user start "$UNIT"
  say "started the panel."
fi

cat <<EOF

This script does not change the proxy. Write the block below to /etc/caddy/conf.d/jass-panel.caddy. The website's Caddyfile imports
that directory inside its site block, and that import must be there:

    @panel path $base_path $base_path/*
    handle @panel {
        reverse_proxy 127.0.0.1:$port
    }

Then check the Caddyfile and reload Caddy:

    sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
    sudo systemctl reload caddy

The website's own block must still refuse /api/panel and /api/panel/* before it proxies anything else.
EOF
