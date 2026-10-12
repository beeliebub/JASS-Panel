// Identity for a browser request or a stream. The daemon has no login: it forwards the browser's Cookie header to the website and
// believes only a direct 200 with a user. Everything else is "signed out", "no access" or "unavailable", and unavailable is never
// access and never remembered. Positive and definite refusals are cached for a few seconds so a page that polls does not call
// the website for every request; a mutating request always checks fresh.
import { createHash } from "node:crypto";
import { z } from "zod";
import { panelUserSchema, type PanelUser } from "../../shared/api.js";
import { Limiter } from "./limiter.js";

export type SessionAnswer =
  | { readonly kind: "user"; readonly user: PanelUser }
  | { readonly kind: "signed_out" }
  | { readonly kind: "no_access" }
  | { readonly kind: "unavailable" };

/** Requests and streams draw on separate allowances, so a flood of requests cannot close the streams of people who are signed in. */
export type SessionChannel = "request" | "stream";

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export interface SessionGateOptions {
  readonly siteOrigin: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly requestConcurrency?: number;
  readonly streamConcurrency?: number;
  readonly positiveTtlMs?: number;
  readonly negativeTtlMs?: number;
  readonly cacheLimit?: number;
}

export interface SessionLookupOptions {
  readonly fresh?: boolean;
  readonly channel?: SessionChannel;
}

export interface SessionGate {
  lookup(cookie: string | undefined, options?: SessionLookupOptions): Promise<SessionAnswer>;
}

const sessionBody = z.object({ data: z.object({ user: panelUserSchema }) });

const UNAVAILABLE: SessionAnswer = { kind: "unavailable" };
const SIGNED_OUT: SessionAnswer = { kind: "signed_out" };

interface CacheEntry {
  readonly answer: SessionAnswer;
  readonly issued: number;
  readonly ttl: number;
}

export function createSessionGate(options: SessionGateOptions): SessionGate {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 3000;
  const positiveTtl = options.positiveTtlMs ?? 5000;
  const negativeTtl = options.negativeTtlMs ?? 2000;
  const cacheLimit = options.cacheLimit ?? 512;
  const limiters: Record<SessionChannel, Limiter> = {
    request: new Limiter(options.requestConcurrency ?? 8),
    stream: new Limiter(options.streamConcurrency ?? 4),
  };
  const cache = new Map<string, CacheEntry>();
  const target = new URL("/api/panel/session", options.siteOrigin);

  function remember(key: string, answer: SessionAnswer): void {
    if (answer.kind === "unavailable") return;
    cache.delete(key);
    cache.set(key, { answer, issued: now(), ttl: answer.kind === "user" ? positiveTtl : negativeTtl });
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  function recall(key: string): SessionAnswer | null {
    const entry = cache.get(key);
    if (entry === undefined) return null;
    // A clock that stepped back must not keep an entry alive past its time to live, so an age outside [0, ttl) is expired.
    const age = now() - entry.issued;
    if (age < 0 || age >= entry.ttl) {
      cache.delete(key);
      return null;
    }
    return entry.answer;
  }

  async function ask(cookie: string): Promise<SessionAnswer> {
    let response: Response;
    try {
      response = await fetchImpl(target, {
        method: "GET",
        headers: { cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return UNAVAILABLE;
    }
    if (response.status === 401) {
      await response.body?.cancel();
      return SIGNED_OUT;
    }
    if (response.status === 403) {
      await response.body?.cancel();
      return { kind: "no_access" };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return UNAVAILABLE;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return UNAVAILABLE;
    }
    const parsed = sessionBody.safeParse(body);
    return parsed.success ? { kind: "user", user: parsed.data.data.user } : UNAVAILABLE;
  }

  return {
    async lookup(cookie, lookupOptions = {}) {
      // No cookie means no call: an unauthenticated caller can never make the daemon contact the website.
      if (cookie === undefined || cookie.trim() === "") return SIGNED_OUT;
      const key = createHash("sha256").update(cookie).digest("base64url");
      if (lookupOptions.fresh !== true) {
        const hit = recall(key);
        if (hit !== null) return hit;
      }
      const release = limiters[lookupOptions.channel ?? "request"].tryAcquire();
      if (release === null) return UNAVAILABLE;
      try {
        const answer = await ask(cookie);
        remember(key, answer);
        return answer;
      } finally {
        release();
      }
    },
  };
}
