// The compiler does not copy SQL, so the migrations are copied beside the compiled migration runner after every server build.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src", "server", "db", "migrations");
const target = join(root, "dist", "server", "db", "migrations");
mkdirSync(target, { recursive: true });
for (const name of readdirSync(source).filter((file) => file.endsWith(".sql"))) {
  copyFileSync(join(source, name), join(target, name));
}
