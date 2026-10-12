// Runs one catalogue action as root through sudo. The program is `sudo -S -k -p '' -- <argv>`: -S reads the password from standard
// input, -k forgets any earlier credential so every action asks again, and the empty prompt keeps the password out of the output.
// The password is written to standard input only; it is never in the argv, the environment, a log line or the audit row.
import type { Runner } from "../systemd/run.js";
import type { PrivilegedAction } from "./catalogue.js";

export type PrivilegedOutcome =
  | { readonly kind: "wrong_password" }
  | { readonly kind: "done"; readonly exitCode: number | null; readonly output: string };

const OUTPUT_LIMIT = 4000;

/** Removes anything that looks like the password from command output before it is shown; output is also cut to a fixed size. */
export function scrubOutput(text: string, password: string): string {
  const scrubbed = password.length > 0 ? text.split(password).join("[removed]") : text;
  return scrubbed.length > OUTPUT_LIMIT ? `${scrubbed.slice(0, OUTPUT_LIMIT)}\n[output truncated]` : scrubbed;
}

export async function runPrivileged(run: Runner, sudo: string, action: PrivilegedAction, password: string): Promise<PrivilegedOutcome> {
  // The C locale keeps sudo's messages in English, which is what the wrong-password check below recognises; a translated message
  // would count as an ordinary failure and reset the lockout.
  const env = { ...process.env, LC_ALL: "C", LANG: "C" };
  const result = await run([sudo, "-S", "-k", "-p", "", "--", ...action.argv], { input: `${password}\n`, timeoutMs: 120_000, env });
  const combined = `${result.stdout}${result.stderr}`;
  // sudo exits 1 with one of these when the password is wrong; the command itself never prints them.
  if (result.code === 1 && /incorrect password|Sorry, try again|no tty present/i.test(result.stderr)) {
    return { kind: "wrong_password" };
  }
  return { kind: "done", exitCode: result.code, output: scrubOutput(combined, password) };
}
