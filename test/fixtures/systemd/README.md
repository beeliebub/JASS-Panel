# systemd fixtures

Raw `systemctl show -p <properties> -- <unit>` output for units that model a game server's unit shape. Provenance:
**observed locally** in the **user** manager on 2026-10-08 with systemd 259.5. `fixtures.test.ts` pins the rules below (every
captured file is a loaded unit with a real invocation id; the one exception is `static-unit/`).

The modelled shape: `ExecStart=/bin/sh start.sh`, where `start.sh` runs the JVM as a child **without** `exec` (so the unit's main
process is the `sh` wrapper), `KillMode=control-group`, and a stand-in JVM that exits 143 on SIGTERM like a Java process running
its shutdown hooks. The units are **enabled** (`WantedBy=default.target`); this matters (see `static-unit/`). `RestartSec=30` in
the matrix keeps a restarting unit in `auto-restart` long enough to read.

## What the panel takes from these

| Fact | Consequence for the unit the panel writes |
|---|---|
| `systemctl stop` makes Paper exit 143 (its shutdown hooks run, the world is saved) | `SuccessExitStatus=143`, so a stop is `Result=success` and not a failure |
| `Restart=on-failure` restarts exits 1, 137 and unaccepted 143, not exit 0 and not an accepted 143 | `Restart=on-failure`: a crash restarts, a stop and an in-game `/stop` stay stopped |
| `Restart=always` would undo an in-game `/stop` | never `always` |
| An unreferenced (static) unit drops its exit data when it ends cleanly | enable the unit; the panel decides "crashed" from `failed` or `auto-restart`, never from a clean end |
| A restarting unit keeps the ended invocation's `InvocationID` until the replacement starts | do not use `InvocationID` changes alone to detect a restart; use `NRestarts` |

## `matrix/<Restart>-<SuccessExitStatus>-<exit>.txt`

Voluntary exits (0, 1, 137, 143) × `Restart=` (no, on-success, on-failure, always) × `SuccessExitStatus=` (unset, 143), read
about three seconds after the process exited.

| Observation |
|---|
| The exit status is kept in every state, including `inactive/dead`: `ExecMainCode=1` (exited) and `ExecMainStatus=<exit>`; a `SuccessExitStatus`-accepted 143 shows `Result=success` with `ExecMainStatus=143`. |
| `Restart=no`: exit 0 → `inactive/dead`, `Result=success`; 1, 137, 143 → `failed`, `Result=exit-code`. |
| `SuccessExitStatus=143` turns exit 143 into `Result=success` and `inactive/dead` under `Restart=no` and `on-failure`. 137 and 1 stay failures. |
| `Restart=on-failure`: exit 0 → `inactive/dead`; 1, 137, 143 (without `SuccessExitStatus`) → `activating/auto-restart`. |
| `Restart=on-success`: exit 0 and (with `SuccessExitStatus=143`) 143 restart; 1, 137 and unaccepted 143 end `failed`. |
| `Restart=always`: every exit, including 0, ends `activating/auto-restart`. |

## `static-unit/`

The same clean exit on a **static** unit (not enabled, nothing references it) is dropped from memory at once: `InvocationID` is
empty and `ExecMainCode`/`ExecMainStatus` read `0`/`0`, even when the real exit was 143 and `SuccessExitStatus=143` is set.
Transient units made with `systemd-run` behave the same way (they read `LoadState=not-found` once collected) and are **not**
valid fixtures.

## `signals/`

| Scenario | `ActiveState/SubState` | `Result` | `ExecMainCode/Status` |
|---|---|---|---|
| `systemctl stop` (the `sh` wrapper is the main process and is signalled) | `inactive/dead` | `success` | `2/15` (killed by SIGTERM) |
| `kill -9` of the JVM only (wrapper survives and exits 137) | `failed/failed`, or `activating/auto-restart` under `on-failure` | `exit-code` | `1/137` |
| `kill -9` of the wrapper (main process) | same as above | `signal` | `2/9` |
| `systemctl kill -s KILL` (whole cgroup) | same as above | `signal` | `2/9` |

`paper-direct-stop-after.txt` is the real Paper build 141 as the unit's **main process** (no wrapper) after `systemctl stop`: the
JVM runs its shutdown hooks and exits 143, which systemd records as `failed`, `Result=exit-code`, `ExecMainCode=1`,
`ExecMainStatus=143` unless `SuccessExitStatus=143` is set. So the same stop is clean or failed depending on the unit's
launcher: the unit the panel writes runs the JVM directly and sets `SuccessExitStatus=143`.

## `stop-attribution/`

Five ways to stop or restart the real Paper build 141 as an enabled user-manager unit (`Type=simple`, `Restart=no`,
`SuccessExitStatus=143`, `KillMode=control-group`, `TimeoutStopSec=45s`, JVM as the main process). Game and RCON bound only to
`127.0.0.1`; the scratch copy had an empty world and no plugins.

| Trigger | ActiveState/SubState | Result | ExecMainCode/Status | Manager `Stopping <unit>` line | Paper `Stopping server` line |
|---|---|---|---|---|---|
| RCON `stop` | `inactive/dead` | `success` | `1/0` | no | yes |
| `systemctl --user stop` | `inactive/dead` | `success` | `1/143` | yes | yes |
| JVM `SIGTERM` | `inactive/dead` | `success` | `1/143` | no | yes |
| JVM `SIGKILL` | `failed/failed` | `signal` | `2/9` | no | no |
| `/restart` through a scratch shim | `inactive/dead` | `success` | `1/0` | no | yes |

Every graceful path ends `inactive/dead` with `Result=success`; only a kill is a failure. That is why the panel does not try to
tell a panel stop from an in-game stop: both are a normal stop, and neither raises an alert. The tuples apply to this exact unit
shape (direct JVM, `Restart=no`, `SuccessExitStatus=143`); do not carry them to a different `ExecStart` or `Restart` without a
new capture.

## Invocation ids across automatic restarts

Sampled every 0.5 s on an enabled `Restart=on-failure`, `RestartSec=2` unit that exits 1 after one second. While the unit waits
in `activating/auto-restart` its `InvocationID` is the **ended** invocation's and does not change; it changes only when the
next start begins. `NRestarts` increases as the restart is scheduled and may do so before the new invocation id appears.

## Restart-script survival (a model, not a measurement of production)

An in-game `/restart` makes Paper run `restart-script` as a plain child of the JVM, inside the unit's cgroup. The model exits
the stand-in JVM immediately after spawning it, the `sh` wrapper exits, and `KillMode=control-group` signals what remains. One
line per second was written for up to 12 s.

| Child | Result |
|---|---|
| plain child (`sh restart.sh &`), 20 trials | 0 lines in 20 of 20: signalled before it writes anything |
| `setsid` or `nohup` child | 0 lines: leaving the session or ignoring hangup does not leave the cgroup |
| child that ignores SIGTERM (`trap '' TERM HUP`), 20 trials | survived in 9 of 20: SIGTERM can arrive before the script installs its trap |
| `systemd-run --user --collect sh restart.sh` (escapes the cgroup) | 12 of 12 lines |
| `KillMode=process` | 12 of 12 lines |

A process started through `systemd-run --user` escapes the cgroup and survives. `paper-restart-handoff-user.json` records ten
real Paper 26.3 build 141 restarts in a user manager using that route: every run handed off while the JVM was alive, ended the
old invocation `inactive/dead` with `Result=success` and exit status 0, and reached the next invocation's `Done` line (the hand
off began 327 to 6,450 ms after the command, median 836.5 ms). The script that produced it was removed with the old daemon, so
repeat the experiment before building on it.
