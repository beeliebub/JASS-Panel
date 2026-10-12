# Fixtures

Captured server and systemd output, used to pin parsers to what the real programs print. Nothing here is written by hand.

A parser is verified only against a fixture whose provenance is **real** or **observed locally**. Output produced by a
test double is never evidence for a parser: it proves only that the double matches the fixtures.

## Provenance

| Path | Source | Status |
|---|---|---|
| `latest-log/startup-main.txt` | Main server `logs/latest.log`, start-up (several excerpts, lines elided) | real |
| `latest-log/shutdown-main.txt` | Main server, rotated log, one complete `Stopping server` sequence | real |
| `latest-log/players-main.txt` | Main server: join, leave, transfer, chat and command lines (three excerpts) | real |
| `latest-log/death-main.txt` | Main and Archive rotated logs; eight observed death message forms | real |
| `latest-log/advancements-main.txt` | Main rotated logs; advancement, goal and challenge messages | real |
| `latest-log/crash-markers-main.txt` | Rotated logs of five servers; exception and report-saved markers, report path removed | real |
| `latest-log/spoke-warning-test.txt` | Test server: a plugin warning with a stack trace, then joins and leaves | real |
| `crash-reports/*.txt` | A server failing to bind its port at start-up; a server dying of heap exhaustion (both trimmed) | real |
| `latest-log/console-replies-fifo.txt` | A scratch Paper 26.3 build 141 run as a user unit with a stdin FIFO: `list`, `say`, `save-all flush`, `save-off`, `save-on`, `tps` sent through the FIFO and read back from `latest.log` | observed locally |
| `latest-log/in-game-restart.txt` | The same server: start-up, then an in-game `/restart` with a restart script, through `Stopping server` | observed locally |
| `rcon/*.txt` | Command replies from a scratch Paper 26.3 (build 141 and 26.3-7-dev): `list`, `tps`, `mspt`, `save-all flush`, `save-off`, `save-on`, `stop`, `whitelist list` | observed locally |
| `systemd/` | `systemctl show` output for units shaped like a game server, and the `ExecStopPost=` environment for each way a unit ends; see `systemd/README.md` | observed locally, user manager, systemd 259.5 |
| `journal/` | `journalctl --user -o json` for Paper runs as user-manager units; see `journal/README.md` | observed locally, user manager |

The `rcon/` replies are the bare reply text (`Saved the game`). The same commands sent through the console print the reply into
`latest.log` as `System chat: Saved the game` (see `console-replies-fifo.txt`), so a parser must not reuse the RCON text as the log
pattern. The panel does not use RCON in its first version; the files stay as the only captured samples of those outputs.

## Anonymisation

Every fixture was reduced to what a parser needs and then scrubbed, keeping each line's exact shape. Timestamps in the death,
advancement and crash-marker excerpts are normalised to a fixed time:

- player names are replaced (`PlayerOne`, `PlayerTwo`, `PlayerThree`; port scanners are `ScannerOne`, `ScannerTwo`);
- IP addresses are replaced with addresses from the documentation range `203.0.113.0/24` (loopback is kept);
- UUIDs are replaced with `00000000-0000-4000-8000-0000000000NN`;
- Discord channel names and ids are replaced;
- crash reports lose the hardware, kernel and thread-dump sections.

`test/support/fixtures.test.ts` scans every file here and fails on a public IP address, a UUID that is not a placeholder, a
long numeric id, a credential-looking string or a home-directory path. Add new fixtures through the same scrub, never by
hand-copying a log. Never use `server.properties` (it holds the RCON password in clear text), `usercache.json`, `ops.json`,
`whitelist.json` or `.console_history` as a source.

Files are named `.txt` because `*.log` is ignored by the repository.
