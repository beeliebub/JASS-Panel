// Server-Sent Event streams. A person may hold at most eight at once. Each one re-checks identity and the capability it was opened with
// every ten seconds, and at once when that person's grants change or a server is removed. It ends the moment a check fails, and a stream
// that cannot be checked (the website is unavailable) ends too: unknown never keeps access open.
import type { FastifyReply, FastifyRequest } from "fastify";
import { SECURITY_HEADERS } from "./headers.js";

export const MAX_STREAMS_PER_PERSON = 8;
export const REVALIDATE_MS = 10_000;
const HEARTBEAT_MS = 15_000;

export class StreamRegistry {
  readonly #open = new Map<string, number>();
  readonly #checks = new Map<string, Set<() => void>>();

  /** Returns a release function, or null when the person already holds the maximum. */
  acquire(userId: string): (() => void) | null {
    const current = this.#open.get(userId) ?? 0;
    if (current >= MAX_STREAMS_PER_PERSON) return null;
    this.#open.set(userId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#open.get(userId) ?? 1) - 1;
      if (left <= 0) this.#open.delete(userId);
      else this.#open.set(userId, left);
    };
  }

  /** Registers a stream's check for its person. Returns the function that removes it when the stream ends. */
  watch(userId: string, check: () => void): () => void {
    const checks = this.#checks.get(userId) ?? new Set<() => void>();
    checks.add(check);
    this.#checks.set(userId, checks);
    return () => {
      checks.delete(check);
      if (checks.size === 0 && this.#checks.get(userId) === checks) this.#checks.delete(userId);
    };
  }

  /** Runs the open checks now, for one person or for everyone, so a change of grants or a removal ends the affected streams at once. */
  recheck(userId?: string): void {
    for (const [id, checks] of this.#checks) {
      if (userId === undefined || id === userId) for (const check of [...checks]) check();
    }
  }
}

export interface StreamOptions {
  /** Aborted when the daemon is stopping, so an open stream ends and the shutdown is not held up by it. */
  readonly signal?: AbortSignal;
  readonly intervalMs: number;
  readonly reauthorize: () => Promise<boolean>;
  /** Registers the stream's check with the registry, so a grant change runs it at once. Returns the function that removes it. */
  readonly watch?: (check: () => void) => () => void;
  readonly tick: (send: (event: string, data: unknown, id?: string) => void) => void;
  /** Runs once when the stream ends, for whatever the stream joined when it opened. */
  readonly onClose?: () => void;
  readonly revalidateMs?: number;
  readonly heartbeatMs?: number;
}

/** Takes over the response and sends events until the client leaves, the check fails, or the server stops. */
export function openEventStream(request: FastifyRequest, reply: FastifyReply, release: () => void, options: StreamOptions): void {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  // A reader whose buffer is full is given no further ticks until it drains, so a slow client cannot make the daemon hold events for it.
  let blocked = false;
  const send = (event: string, data: unknown, id?: string): void => {
    if (closed) return;
    const head = id === undefined ? [] : [`id: ${id}`];
    // A blank line ends the event, so the joined text ends with two newlines.
    if (!raw.write([...head, `event: ${event}`, `data: ${JSON.stringify(data)}`, "", ""].join("\n")) && !blocked) {
      // One listener per blockage, however many events a tick writes while the buffer stays full.
      blocked = true;
      raw.once("drain", () => {
        blocked = false;
      });
    }
  };
  const stop = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pump);
    clearInterval(revalidate);
    clearInterval(heartbeat);
    unwatch?.();
    options.onClose?.();
    options.signal?.removeEventListener("abort", stop);
    release();
    if (!raw.writableEnded) raw.end();
  };
  const pump = setInterval(() => {
    if (!closed && !blocked) options.tick(send);
  }, options.intervalMs);
  const check = (): void => {
    void options.reauthorize().then((allowed) => {
      if (!allowed) stop();
    }, stop);
  };
  const revalidate = setInterval(check, options.revalidateMs ?? REVALIDATE_MS);
  const unwatch = options.watch?.(check);
  const heartbeat = setInterval(() => {
    if (!closed) raw.write(": keep-alive\n\n");
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  request.raw.on("close", stop);
  raw.on("close", stop);
  if (options.signal?.aborted === true) stop();
  else options.signal?.addEventListener("abort", stop, { once: true });
  // A client that left while the request was being answered never reaches the close listeners above.
  if (request.raw.destroyed || raw.destroyed) stop();
  send("ready", { ok: true });
}
