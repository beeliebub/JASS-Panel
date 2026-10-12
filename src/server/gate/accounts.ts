// The website's list of OWNER and ADMIN accounts, for the Access screen. It is asked with the signed-in person's own Cookie, the same
// way the session is checked, and only on behalf of an owner or a panel operator (the access list decides that before asking). The list
// is used to choose people for grants and never to decide access: grant rows and the session answer decide that. A 401 or 403 means the
// website refused this session, and that refusal is passed on. Any other answer that is not a 200 with exactly the expected shape is
// "unavailable", and the Access screen then falls back to the people this panel has seen.
import { z } from "zod";
import { Limiter } from "./limiter.js";
import type { FetchLike } from "./session.js";

const MAX_ACCOUNTS = 1000;
// A few hundred bytes per account, so a body beyond this size is not an answer this panel should read in full.
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 3000;
// Each call holds a connection to the website until it answers or times out, so concurrent calls are capped. A call beyond the cap is
// unavailable, and the screen shows the people the panel has seen.
const MAX_CONCURRENT = 4;

const accountSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  email: z.string().min(1).max(1000),
  name: z.string().max(1000).nullable(),
  role: z.enum(["OWNER", "ADMIN"]),
});
const envelopeSchema = z.strictObject({ data: z.strictObject({ accounts: z.array(accountSchema).max(MAX_ACCOUNTS) }) });

export type SiteAccount = z.infer<typeof accountSchema>;
export type AccountsAnswer =
  | { readonly kind: "ok"; readonly accounts: readonly SiteAccount[] }
  | { readonly kind: "refused"; readonly status: 401 | 403 }
  | { readonly kind: "unavailable" };

export interface AccountsLookup {
  /** The website's accounts as the caller's own session may see them. `cookie` is the browser's Cookie header, forwarded verbatim. */
  list(cookie: string | undefined): Promise<AccountsAnswer>;
}

export interface AccountsOptions {
  readonly siteOrigin: string;
  readonly fetch?: FetchLike;
}

const UNAVAILABLE: AccountsAnswer = { kind: "unavailable" };

/** The body as text, or null when it is larger than the bound. The rest of an oversized body is cancelled, not read. */
async function readBounded(response: Response): Promise<string | null> {
  // The runtime's fetch types describe the body more loosely than a byte stream, so it is typed here as the byte stream it is.
  const body = response.body as ReadableStream<Uint8Array> | null;
  const reader = body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createAccountsLookup(options: AccountsOptions): AccountsLookup {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const target = new URL("/api/panel/accounts", options.siteOrigin);
  const slots = new Limiter(MAX_CONCURRENT);
  return {
    async list(cookie) {
      // Without the person's own cookie the website would refuse, so no request is made.
      if (cookie === undefined) return UNAVAILABLE;
      const release = slots.tryAcquire();
      if (release === null) return UNAVAILABLE;
      try {
        const response = await fetchImpl(target, {
          method: "GET",
          headers: { accept: "application/json", cookie },
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // An answer that is not used is cancelled, so its connection is released rather than held until the server closes it.
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => undefined);
          return { kind: "refused", status: response.status === 401 ? 401 : 403 };
        }
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return UNAVAILABLE;
        }
        const text = await readBounded(response);
        if (text === null) return UNAVAILABLE;
        const parsed = envelopeSchema.safeParse(JSON.parse(text) as unknown);
        return parsed.success ? { kind: "ok", accounts: parsed.data.data.accounts } : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      } finally {
        release();
      }
    },
  };
}
