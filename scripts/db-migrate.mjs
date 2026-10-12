// Applies pending migrations to the configured database and exits. The daemon also applies them on start; this is for doing it
// deliberately, before a new build is started. It imports the compiled runner, so it needs a server build first.
import { bundledMigrationsDirectory, migrate } from "../dist/server/db/migrate.js";
import { openDatabase } from "../dist/server/db/open.js";
import { loadConfig } from "../dist/server/config/config.js";

const config = loadConfig(process.env);
const db = openDatabase(config.paths.database);
try {
  const result = migrate(db, { dir: bundledMigrationsDirectory(), backupDir: config.paths.databaseBackups });
  console.log(result.applied.length === 0 ? "No migrations to apply." : `Applied: ${result.applied.join(", ")}`);
  if (result.backup !== null) console.log(`Backup written before applying: ${result.backup}`);
} finally {
  db.close();
}
