// The one seam for running programs. Every subprocess is an argv array passed to execFile, never a shell string, so data from a
// request can only ever be an operand. Tests substitute the runner; production uses this.
import { execFile } from "node:child_process";

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  /** The most output kept from the process. A process whose output exceeds it is stopped, and its result has no exit code. */
  readonly maxOutputBytes?: number;
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type Runner = (argv: readonly string[], options?: RunOptions) => Promise<RunResult>;

const MAX_OUTPUT_BYTES = 1024 * 1024;

export const runProcess: Runner = (argv, options = {}) => {
  const [program, ...args] = argv;
  if (program === undefined) return Promise.reject(new TypeError("a command needs a program"));
  return new Promise((resolve) => {
    const child = execFile(
      program,
      args,
      {
        encoding: "utf8",
        maxBuffer: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? 30_000,
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        const signal = error?.signal ?? null;
        resolve({ code, signal, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
};
