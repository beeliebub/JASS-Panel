# Runbook: moving a server to the panel

This was written from a simulation on the development machine: a copy of the Test server, a copy of the website, and the panel's own daemon, all in a
scratch directory. The live Test server and the real proxy were not touched. Repeat each step there before the move is called done.

## Before the move

- **Check that the world loads on the Paper build the server will run.** The simulation's copy did not load on Paper 26.3: the datapacks
  failed because the world-gen settings were missing (`world/dimensions/minecraft/overworld/data/minecraft/world_gen_settings.dat`). The
  panel answered "The server stopped while it was starting. The journal has the reason." The reason is in the unit's journal, not in the
  panel: `journalctl --user -u jass-mc-<id>.service`. Fix or restore the world first.
- Note the server's Paper jar name, Java path and memory. The add form needs them.
- Take a backup of the server folder before the move.

## The move, one server at a time

1. **Stop the old process first.** The live setup starts a server with its own script (`start.sh`, `restart.sh`), outside the panel. The
   panel will not start a world that another process still holds. In the simulation the first start, made while the old process still
   ran, failed: the unit's journal shows `DirectoryLock$LockException ... world/session.lock: already locked`, and the panel reported that
   the server stopped while it was starting.
2. **Add the server in the panel**: its id, its folder (the panel does not copy it), and the Paper preset (Java path, memory, jar file).
3. **Start it from the panel** and wait for the start to report done, which means the server printed its Done line. A start that reports
   unknown means the panel could not confirm it. Read the server's state on its page before doing anything else, and do not start it again
   while the state is unknown.
4. **Check it**: send a console command, take a backup, and confirm the start appears in the audit log.
5. **Retire the old script or unit by hand.** The panel does not touch the old launcher.

## Smoke checklist

These are the checks the simulation ran, in order:

- Sign in through the website as an owner. The panel's servers, access, audit, health and settings calls all answer.
- Add the server, start it (Done), send a console command, take a backup, stop it (done), and remove it from the panel.
- The removal appears in the audit log. The server's folder is kept: removal takes the unit files, the grants and the panel's record only.
- No secret appears in the daemon's log, the website's log or the results.

## Health after a Paper upgrade

A backup that did not see the save messages Paper prints fails, and the Health screen shows a "Save messages" warning. A Paper upgrade can
change those messages. After any upgrade, take one backup of each server and check that the warning clears.

## Not covered by the simulation

- The real proxy. The simulation called the panel on loopback with the public origin's headers, not through Caddy.
- A reboot with lingering. The owner has skipped this check for now.
- The live Test server, the VPS and the plugin install on the VPS.
