// Loads captured fixtures, and checks fixture text for anything that must not be committed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

/** The lines of a fixture, without the trailing empty element. */
export function fixtureLines(name: string): string[] {
  return fixture(name).replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

export function allFixtureFiles(dir = FIXTURES_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? allFixtureFiles(path) : [path];
  });
}

const DOC_RANGES = [/^203\.0\.113\.\d{1,3}$/, /^198\.51\.100\.\d{1,3}$/, /^192\.0\.2\.\d{1,3}$/, /^127\.0\.0\.1$/, /^0\.0\.0\.0$/];
const PLACEHOLDER_UUID = /^00000000-0000-4000-8000-\d{12}$/;
const PLACEHOLDER_SNOWFLAKES = new Set(["100000000000000001", "100000000000000002", "100000000000000003"]);
const CREDENTIAL_WORDS = /ghp_|github_pat_|password|passwd|secret|webhook|bottoken|token=|rcon\.password|\/home\/[a-z_][a-z0-9_-]*\//i;

/** Identifiers that must never be committed: public addresses, real UUIDs, long numeric ids (Discord snowflakes). */
export function findIdentifierProblems(text: string): string[] {
  const problems: string[] = [];
  for (const match of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
    if (!DOC_RANGES.some((range) => range.test(match[0]))) problems.push(`IP address ${match[0]}`);
  }
  for (const match of text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) {
    if (!PLACEHOLDER_UUID.test(match[0])) problems.push(`UUID ${match[0]}`);
  }
  for (const match of text.matchAll(/\b\d{17,20}\b/g)) {
    if (!PLACEHOLDER_SNOWFLAKES.has(match[0])) problems.push(`long numeric id ${match[0]}`);
  }
  return problems;
}

/** Returns a description of each problem found in a fixture's text; empty when it is safe to commit. */
export function findFixtureProblems(text: string): string[] {
  const problems = findIdentifierProblems(text);
  const credential = CREDENTIAL_WORDS.exec(text);
  if (credential !== null) problems.push(`credential-like text "${credential[0]}"`);
  return problems;
}
