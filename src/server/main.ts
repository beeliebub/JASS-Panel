// Entry point. Loads the configuration, opens the database under its exclusive lock, applies pending migrations, and listens on
// loopback only: the public site reaches the daemon through the reverse proxy, never directly.
import { setMaxListeners } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./api/app.js";
import { ConfigError, loadConfig } from "./config/config.js";
import { bundledMigrationsDirectory, migrate, MigrationError } from "./db/migrate.js";
import { DatabaseLockedError, openDatabase } from "./db/open.js";
import { createSessionGate } from "./gate/session.js";
import { createIdentityLookup } from "./gate/identity.js";
import { OperationLocks } from "./power/lock.js";
import { Readiness } from "./power/readiness.js";
import { runProcess } from "./systemd/run.js";
import { createScheduler } from "./schedules/scheduler.js";
import { reconcileMarkers, reconcileRestores } from "./backups/backup.js";
import { reconcileRestarts } from "./power/power.js";
import { reconcileAutostart } from "./servers/autostart.js";
import { copyDatabase } from "./db/copy.js";
import { createAlerts } from "./alerts/alerts.js";
import { runWatchdog } from "./alerts/watchdog.js";
import { createControlHandler } from "./control/handle.js";
import { ControlSocketError, startControlSocket } from "./control/socket.js";
import { ensureUpdateRequest } from "./control/update-request.js";
import { ensureStopEvent } from "./servers/files.js";
import { getServer, listServers } from "./servers/store.js";
import { sweepPartials } from "./files/jail.js";

// How long a stopping daemon waits for scheduled work that is already running before it closes the database.
const SHUTDOWN_DRAIN_MS = 30_000;
// How long the listener is given to finish requests that are still open. Together with the drain this stays well inside the 90 seconds systemd allows.
const SHUTDOWN_CLOSE_MS = 15_000;
// How often auto-save that a backup could not restore is tried again, and how many daily database copies are kept.
const SAVE_RETRY_MS = 5 * 60_000;
const DATABASE_COPIES = 7;

async function main(): Promise<void> {
  const config = loadConfig(process.env, { uid: process.getuid?.() ?? 0 });
  const db = openDatabase(config.paths.database);
  const migrations = migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  // The built app sits two levels above both dist/server and src/server, so one relative path serves either layout.
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  const run = runProcess;
  const locks = new OperationLocks();
  const readiness = new Readiness({ markers: config.paths.markers, paperServer: (id) => getServer(db, id)?.memory !== null });
  // Set when the daemon begins to stop, so a countdown in progress is abandoned and open streams end before the close waits on them.
  const stopping = new AbortController();
  // Every open stream and countdown listens on this signal, which is more than the default listener limit.
  setMaxListeners(0, stopping.signal);
  const identity = createIdentityLookup({ siteOrigin: config.siteOrigin });
  // Discord posting is not connected yet, so incidents are recorded as not sent. Passing a poster here connects it.
  const alerts = createAlerts({ db });
  const scheduler = createScheduler({
    db,
    config,
    run,
    locks,
    readiness,
    identity,
    alerts,
    stopping: stopping.signal,
    onError: (error) => console.error("a scheduled action could not be finished or recorded:", error instanceof Error ? error.name : "unknown"),
  });
  const zstd = (await run(["zstd", "--version"])).code === 0;
  const fetcher = (url: string, init: { headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => fetch(url, init);
  const app = createApp({
    config,
    db,
    sessionGate: createSessionGate({ siteOrigin: config.siteOrigin }),
    run,
    locks,
    readiness,
    identity,
    scheduler,
    zstd,
    alerts,
    fetcher,
    webDir,
    logger: { level: "info", redact: { paths: ["req.headers.cookie", "req.headers.authorization"], censor: "[redacted]" } },
    stopping: stopping.signal,
  });
  if (migrations.applied.length > 0) app.log.info({ applied: migrations.applied }, "applied database migrations");
  // Start-up reconciliation first: a backup that died between save-off and save-on must be undone before schedules can fire.
  const settleSaveStates = async (): Promise<void> => {
    for (const serverId of await reconcileMarkers({ db, config, run, locks, zstd, readiness })) {
      app.log.error({ serverId }, "auto-save could not be confirmed after a backup was interrupted");
      await alerts.raise("auto-save", serverId, "A backup was interrupted and the server did not confirm that auto-save is back on.");
    }
  };
  await settleSaveStates();
  for (const serverId of await reconcileRestarts({ db, config, run })) {
    app.log.error({ serverId }, "a restart was interrupted when the panel stopped");
    await alerts.raise("restart-interrupted", serverId, "A restart was interrupted when the panel stopped, and the server is not running. Start it from its page.");
  }
  // A restore that a death interrupted is settled before anything can act on the server's folder.
  for (const problem of reconcileRestores({ db, config })) {
    app.log.error({ serverId: problem.serverId }, "an interrupted restore was found at start-up");
    await alerts.raise("restore-interrupted", problem.serverId, problem.message);
  }
  // A write that a death interrupted can leave its temporary file in a server folder. The sweep finishes before anything can write there.
  for (const row of listServers(db)) {
    const removed = await sweepPartials(row.directory);
    if (removed > 0) app.log.info({ serverId: row.id, removed }, "removed temporary files left by an interrupted write");
  }
  // The stored start-with-the-machine choices are set from the units systemd has, so a change made by hand while the panel was down shows.
  await reconcileAutostart({ db, run, now: () => new Date() });
  scheduler.load();
  ensureStopEvent(config.paths);
  ensureUpdateRequest(config.dataDir, process.execPath);
  const control = await startControlSocket(config.paths.controlSocket, createControlHandler({ db, config, run, locks, fetcher }));
  const watchdog = setInterval(() => {
    void runWatchdog({ db, config, run, alerts }).catch((error: unknown) => app.log.error({ name: error instanceof Error ? error.name : "unknown" }, "watchdog check failed"));
  }, 15_000);
  // Auto-save that a backup could not restore is tried again while the panel runs, and the database is copied at each start and once a day.
  const retrySaveStates = setInterval(() => void settleSaveStates().catch((error: unknown) => app.log.error({ name: error instanceof Error ? error.name : "unknown" }, "auto-save check failed")), SAVE_RETRY_MS);
  // A start copies the database only when the newest copy is a day old, so a restart loop cannot replace every retained copy with a recent one.
  const copyDatabaseOnce = (minAgeMs: number): void => {
    try {
      copyDatabase(db, config.paths.databaseBackups, new Date(), DATABASE_COPIES, minAgeMs);
    } catch (error) {
      app.log.error({ name: error instanceof Error ? error.name : "unknown" }, "the database could not be copied");
    }
  };
  copyDatabaseOnce(24 * 60 * 60_000);
  const dailyCopy = setInterval(() => copyDatabaseOnce(0), 24 * 60 * 60_000);
  await app.listen({ host: "127.0.0.1", port: config.port });
  app.log.info({ port: config.port, basePath: config.basePath }, "panel listening on loopback");

  const stop = (): void => {
    stopping.abort();
    scheduler.stop();
    clearInterval(watchdog);
    clearInterval(retrySaveStates);
    clearInterval(dailyCopy);
    void control.close();
    void shutDown();
  };
  // The listener closes first, so no request can start an action while scheduled work drains. Scheduled work already running gets a
  // bounded wait; a backup or restart cut short here is settled by start-up, and the log says so.
  const shutDown = async (): Promise<void> => {
    const closing = app.close().then(
      () => undefined,
      () => app.log.error("the panel did not close its connections cleanly"),
    );
    const unfinished = await scheduler.drain(SHUTDOWN_DRAIN_MS);
    if (unfinished > 0) app.log.error({ unfinished }, "scheduled actions were still running when the panel stopped");
    await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_CLOSE_MS))]);
    db.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof DatabaseLockedError || error instanceof MigrationError || error instanceof ControlSocketError) {
    console.error(error.message);
  } else {
    console.error("The panel failed to start:", error);
  }
  process.exit(1);
});
