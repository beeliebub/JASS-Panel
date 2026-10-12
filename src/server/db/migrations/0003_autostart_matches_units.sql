-- The start-with-the-machine choice is the unit's enablement, and the flag beside each server records it. Every unit was enabled when its
-- server was added, whatever the checkbox said, so every server that exists now starts with the machine. This keeps those servers as they
-- are: the flag follows the units that already exist. The panel corrects any flag that differs from its unit when it starts, which covers a
-- unit disabled by hand before this change. A server added from now on is enabled only when its choice is on.
UPDATE servers SET autostart = 1;
