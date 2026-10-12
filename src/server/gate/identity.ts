// Identity for a scheduled action, which has no browser cookie. The schedule's creator id is sent to the website's loopback-only
// identity route, and the answer is never cached: a demotion or a deletion must take effect on the next firing. A timeout, a
// refused connection, a 5xx and a malformed body are all "unavailable". Only a well-formed answer about the requested id decides.
import { z } from "zod";
import type { FetchLike } from "./session.js";
import { Limiter } from "./limiter.js";

export type ScheduledIdentityAnswer =
  | { readonly kind: "eligible"; readonly user: { readonly id: string; readonly role: "OWNER" | "ADMIN" } }
  | { readonly kind: "not_eligible" }
  | { readonly kind: "unavailable" };

export interface IdentityLookupOptions {
  readonly siteOrigin: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export interface IdentityLookup {
  lookup(userId: string): Promise<ScheduledIdentityAnswer>;
}

const identityBody = z.object({
  data: z.object({
    user: z.union([z.null(), z.strictObject({ id: z.string().max(64), role: z.enum(["OWNER", "ADMIN"]) })]),
  }),
});

// The website is asked for at most this many identities at once. A lookup that finds no slot is unavailable: nothing waits behind a slow website.
const lookupSlots = new Limiter(8);

export function createIdentityLookup(options: IdentityLookupOptions): IdentityLookup {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 3000;
  const target = new URL("/api/panel/identity", options.siteOrigin);

  return {
    async lookup(userId) {
      const release = lookupSlots.tryAcquire();
      if (release === null) return { kind: "unavailable" };
      let response: Response;
      try {
        response = await fetchImpl(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId }),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { kind: "unavailable" };
      } finally {
        release();
      }
      if (response.status !== 200) {
        // The body is discarded; a stream that cannot be cancelled must not turn a valid answer into an error.
        await response.body?.cancel().catch(() => undefined);
        return { kind: "unavailable" };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: "unavailable" };
      }
      const parsed = identityBody.safeParse(body);
      if (!parsed.success) return { kind: "unavailable" };
      const user = parsed.data.data.user;
      if (user === null) return { kind: "not_eligible" };
      // An answer about a different person is not an answer about this schedule's creator.
      if (user.id !== userId) return { kind: "unavailable" };
      return { kind: "eligible", user };
    },
  };
}
