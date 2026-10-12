# Journal fixtures

`paper-26.3-141-user-scope.jsonl` is `journalctl --user -u <unit> -o json` for one complete run (start to `systemctl stop`) of
Paper build 141, run locally as a transient **user-manager** unit with `StandardOutput=journal`. Hostname, machine and boot
ids, and local paths are replaced; cursors are rebuilt from the kept timestamps. Measured 2026-10-08, systemd 259.5.

## What this verifies

- The console `MESSAGE` text as journald stores it: `[HH:MM:SS LEVEL]: text`, with **no thread name** and no date. This differs
  from `latest.log` (`[HH:MM:SS] [Server thread/INFO]: text`), so a parser keyed by transport must not reuse the file patterns.
  A line from the logging library before Paper's own formatter starts has an ISO timestamp (`2026-…Z ServerMain WARN …`), and a
  few JVM warnings have no prefix at all.
- Console lines arrive with `_TRANSPORT=stdout`, `SYSLOG_IDENTIFIER=java`, `PRIORITY=6`, and `_SYSTEMD_INVOCATION_ID` (the unit
  invocation) on every record; the manager's own lines (`Started …`, `Stopping …` for a `systemctl stop`, `Main process exited …`,
  `Failed with result …`, `Stopped …`, resource summary) arrive with `_TRANSPORT=journal` and a different priority. Output is
  plain text: no ANSI escapes.
- The shutdown sequence in the journal ends with the I/O-pool line and no closing line, as in `latest.log`.
- `stop-attribution/*.jsonl` keeps a single Paper invocation per file for RCON `stop`, `systemctl stop`, JVM `SIGTERM`, JVM
  `SIGKILL`, and a scratch-shim `/restart`. Game output is selected with `_SYSTEMD_INVOCATION_ID`; user-manager lifecycle lines
  are selected with `USER_UNIT` and `USER_INVOCATION_ID`. The manager's `Stopping <unit>` line appears only in the
  `systemctl-stop.jsonl` capture. Real invocation ids and cursors are replaced or rebuilt, and the files omit player, host and
  scratch-path data.

## What this does not verify

- Chat, join and leave lines in the journal (no player connected during the capture).
- Rotation and vacuuming of a long-lived journal.
- Anything about a system-scope unit: the panel runs its servers as user-manager units, and the system-scope captures that
  once sat beside these were removed with the old design.
