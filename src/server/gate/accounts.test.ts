import { describe, expect, it } from "vitest";
import { createAccountsLookup } from "./accounts.js";
import type { FetchLike } from "./session.js";

const SITE = "http://127.0.0.1:3000";
const OWNER = { id: "owner-1", email: "owner@example.net", name: "Owner", role: "OWNER" };
const ADMIN = { id: "admin-1", email: "admin@example.net", name: null, role: "ADMIN" };

function fakeSite(answer: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url: url.toString(), init });
    return answer();
  };
  return { fetch, calls };
}

function json(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("the website's account list", () => {
  it("returns the accounts the website answers, asked on loopback with the caller's own cookie, never following a redirect", async () => {
    const site = fakeSite(() => json(200, { data: { accounts: [OWNER, ADMIN] } }));
    const lookup = createAccountsLookup({ siteOrigin: SITE, fetch: site.fetch });

    expect(await lookup.list("session=abc")).toEqual({ kind: "ok", accounts: [OWNER, ADMIN] });
    expect(site.calls).toHaveLength(1);
    expect(site.calls[0]?.url).toBe(`${SITE}/api/panel/accounts`);
    const init = site.calls[0]?.init;
    expect((init?.headers as Record<string, string>).cookie).toBe("session=abc");
    expect(init?.redirect).toBe("manual");
  });

  it("makes no request without the caller's cookie", async () => {
    const site = fakeSite(() => json(200, { data: { accounts: [OWNER] } }));
    const lookup = createAccountsLookup({ siteOrigin: SITE, fetch: site.fetch });

    expect(await lookup.list(undefined)).toEqual({ kind: "unavailable" });
    expect(site.calls).toHaveLength(0);
  });

  it("passes on the website's refusal of this session, as a 401 or a 403", async () => {
    for (const status of [401, 403] as const) {
      const site = fakeSite(() => json(status, { error: { code: "unauthorized", message: "no session" } }));
      const lookup = createAccountsLookup({ siteOrigin: SITE, fetch: site.fetch });
      expect(await lookup.list("session=abc"), String(status)).toEqual({ kind: "refused", status });
    }
  });

  it("is unavailable for any other answer that is not a 200", async () => {
    for (const status of [302, 500]) {
      const site = fakeSite(() => json(status, { data: { accounts: [OWNER] } }));
      const lookup = createAccountsLookup({ siteOrigin: SITE, fetch: site.fetch });
      expect(await lookup.list("session=abc"), String(status)).toEqual({ kind: "unavailable" });
    }
  });

  it("is unavailable for a body that is not exactly the expected shape", async () => {
    const bodies = [
      { data: { users: [OWNER] } },
      { data: { accounts: [OWNER], extra: true } },
      { data: { accounts: [{ ...OWNER, id: "has a space" }] } },
      { data: { accounts: [{ ...OWNER, role: "EDITOR" }] } },
      { data: { accounts: [{ ...OWNER, passwordHash: "secret" }] } },
    ];
    for (const body of bodies) {
      const site = fakeSite(() => json(200, body));
      const lookup = createAccountsLookup({ siteOrigin: SITE, fetch: site.fetch });
      expect(await lookup.list("session=abc"), JSON.stringify(body)).toEqual({ kind: "unavailable" });
    }
  });

  it("is unavailable for a body larger than the bound", async () => {
    const site = fakeSite(() => Promise.resolve(new Response("x".repeat(2 * 1024 * 1024), { status: 200 })));
    const lookup = createAccountsLookup({ siteOrigin: SITE, fetch: site.fetch });
    expect(await lookup.list("session=abc")).toEqual({ kind: "unavailable" });
  });

  it("is unavailable when the website cannot be reached", async () => {
    const site = fakeSite(() => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:3000")));
    const lookup = createAccountsLookup({ siteOrigin: SITE, fetch: site.fetch });
    expect(await lookup.list("session=abc")).toEqual({ kind: "unavailable" });
  });

  it("does not ask the website more than four times at once", async () => {
    const completions: (() => void)[] = [];
    const fetch: FetchLike = () => new Promise<Response>((resolve) => completions.push(() => resolve(new Response(JSON.stringify({ data: { accounts: [] } }), { status: 200 }))));
    const lookup = createAccountsLookup({ siteOrigin: SITE, fetch });

    const waiting = Array.from({ length: 4 }, () => lookup.list("session=abc"));
    expect(await lookup.list("session=abc")).toEqual({ kind: "unavailable" });
    for (const complete of completions) complete();
    expect(await Promise.all(waiting)).toEqual(Array.from({ length: 4 }, () => ({ kind: "ok", accounts: [] })));
  });
});
