// The warnings a countdown gives players before a stop or restart. Each warning is a `say` line written to the server's input, and each one
// must be echoed in the server's log before the next wait. A warning that was not delivered or not echoed did not reach the server's
// chat, so nothing further is done and nothing is stopped. The waits listen for a cancel, and for the daemon stopping, so neither has to
// wait for a timer to run out.
import { classify } from "../console/classify.js";
import { sendCommand } from "../console/fifo.js";
import { LogTail } from "../console/tail.js";
import { ServiceError } from "../servers/service.js";
import type { Countdown } from "./countdown.js";

const WARNING_ECHO_MS = 10_000;
// Fixed marks below the full countdown, so a long countdown warns again as the moment approaches.
const WARNING_MARKS = [60, 30, 10, 5, 4, 3, 2, 1];
const ECHO_POLL_MS = 250;

/** The seconds-before-action at which players are warned, largest first. The full countdown is always the first mark. */
export function warningMarks(countdownSeconds: number): number[] {
  return [countdownSeconds, ...WARNING_MARKS.filter((mark) => mark < countdownSeconds)];
}

export interface CountdownProgress {
  sent: number;
  due: number;
}

export interface WarningRun {
  readonly pipe: string;
  readonly log: string;
  readonly action: "stop" | "restart";
  readonly seconds: number;
  readonly countdown: Countdown;
  readonly progress: CountdownProgress;
  /** True while the server is the same running process the countdown began with. Checked before every warning after the first. */
  readonly sameProcess: () => Promise<boolean>;
  /** Whether each warning must be echoed in the log. A test with no server log turns it off. */
  readonly confirm: boolean;
  readonly echoMs?: number;
  /** Waits between warnings. It resolves early when the signal aborts; tests substitute a wait of their own. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Aborted when the daemon begins to stop. A countdown in progress is then abandoned, and the server is not stopped by that. */
  readonly daemonSignal?: AbortSignal;
}

export function changedDuringCountdown(): ServiceError {
  return new ServiceError("conflict", "The server changed during the countdown, so it was not stopped. Check its state, then try again.");
}

export function abandoned(): ServiceError {
  return new ServiceError("conflict", "The panel is stopping, so the countdown was abandoned. The server was not stopped.");
}

/** Waits for ms, or until the signal aborts, whichever comes first. The timer is cleared on abort, so a cancelled countdown leaves nothing running. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    // The listener is removed when the timer fires, so a countdown that polls many times does not pile listeners onto its signal.
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * True when the log shows the text within the window. The log is read from the point before the warning was sent. The log is read again
 * after the last wait, so an echo that arrives in the final moment of the window still counts.
 */
async function echoed(tail: LogTail, text: string, windowMs: number, signal: AbortSignal): Promise<"echoed" | "missing" | "aborted"> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (signal.aborted) return "aborted";
    for (const line of tail.poll()) {
      // The server echoes its own console command as the whole message. A player's line starts with the player's name, so it never equals this.
      if (classify(line.text).text === `[Not Secure] [Server] ${text}`) return "echoed";
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "missing";
    await pause(Math.min(ECHO_POLL_MS, remaining), signal);
  }
}

/**
 * Gives every warning of a countdown, in order. Resolves "completed" when the last warning has been echoed and its wait has passed, and
 * "cancelled" when the starter cancelled it first. Throws when a warning fails, so the caller stops nothing.
 */
export async function countDown(run: WarningRun): Promise<"completed" | "cancelled"> {
  const marks = warningMarks(run.seconds);
  const verb = run.action === "stop" ? "stopping" : "restarting";
  const signal = run.daemonSignal === undefined ? run.countdown.signal : AbortSignal.any([run.countdown.signal, run.daemonSignal]);
  // A cancel is an answer; a daemon stop is an abandonment, which is an error because the countdown did not finish.
  const interrupted = (): "cancelled" => {
    if (run.countdown.cancelled) return "cancelled";
    throw abandoned();
  };
  run.progress.due = marks.length;
  for (const [index, mark] of marks.entries()) {
    if (signal.aborted) return interrupted();
    const unit = mark === 1 ? "second" : "seconds";
    const text = `Server ${verb} in ${mark} ${unit}.`;
    // A later warning is a write into the server's socket, and a server that stopped on its own (an in-game stop leaves the socket open)
    // would be started by it. Each warning therefore needs the same process the countdown began with.
    if (index > 0) {
      const same = await run.sameProcess();
      // A cancel that arrived during the check is the answer: nothing further is written, and nothing is stopped.
      if (signal.aborted) return interrupted();
      if (!same) throw changedDuringCountdown();
    }
    // A fresh tail for each warning, so the echo search covers only what came after this warning was sent.
    const tail = run.confirm ? new LogTail(run.log, "end") : null;
    tail?.poll();
    if (!sendCommand(run.pipe, `say ${text}`).delivered) {
      throw new ServiceError("conflict", "The players could not be warned, so the server was not stopped. Stop it without a countdown to proceed.");
    }
    run.progress.sent += 1;
    if (tail !== null) {
      const result = await echoed(tail, text, run.echoMs ?? WARNING_ECHO_MS, signal);
      if (result === "aborted") return interrupted();
      if (result === "missing") {
        throw new ServiceError("conflict", "The server did not show the warning in its log, so it was not stopped. Stop it without a countdown to proceed.");
      }
    }
    const next = marks[index + 1] ?? 0;
    await run.sleep((mark - next) * 1000, signal);
    if (signal.aborted) return interrupted();
  }
  return "completed";
}
