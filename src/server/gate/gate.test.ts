import { describe, expect, it } from "vitest";
import { createIdentityLookup } from "./identity.js";
import { Limiter } from "./limiter.js";
import { createSessionGate, type FetchLike } from "./session.js";

const SITE = "http://127.0.0.1:3000";
const OWNER_BODY = { data: { user: { id: "owner-1", email: "o@example.net", name: "Owner", role: "OWNER" } } };

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call = { url: input.toString(), init };
    calls.push(call);
    return respond(call);
  };
  return { fetch: fetchImpl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => void (at += ms) };
}

describe("Limiter", () => {
  it("hands out at most its limit and frees a slot once released", () => {
    const limiter = new Limiter(2);
    const first = limiter.tryAcquire();
    const second = limiter.tryAcquire();
    expect(limiter.tryAcquire()).toBeNull();
    first?.();
    first?.();
    expect(limiter.active).toBe(1);
    expect(limiter.tryAcquire()).not.toBeNull();
    second?.();
  });

  it("rejects a limit that is not a positive integer", () => {
    expect(() => new Limiter(0)).toThrow(RangeError);
    expect(() => new Limiter(1.5)).toThrow(RangeError);
  });
});

describe("createSessionGate", () => {
  it("makes no call at all without a cookie", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, OWNER_BODY));
    const gate = createSessionGate({ siteOrigin: SITE, fetch });
    expect(await gate.lookup(undefined)).toEqual({ kind: "signed_out" });
    expect(await gate.lookup("   ")).toEqual({ kind: "signed_out" });
    expect(calls).toHaveLength(0);
  });

  it("forwards the cookie verbatim to the session route and treats a direct 200 as identity", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, OWNER_BODY));
    const gate = createSessionGate({ siteOrigin: SITE, fetch });
    const cookie = "__Secure-authjs.session-token=abc.def; other=1";
    const answer = await gate.lookup(cookie);
    expect(answer).toEqual({ kind: "user", user: OWNER_BODY.data.user });
    expect(calls[0]?.url).toBe("http://127.0.0.1:3000/api/panel/session");
    expect((calls[0]?.init.headers as Record<string, string>).cookie).toBe(cookie);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it("does not keep an answer alive when the clock steps back past its time to live", async () => {
    const time = clock();
    const { fetch, calls } = fakeFetch(() => json(200, OWNER_BODY));
    const gate = createSessionGate({ siteOrigin: SITE, fetch, now: time.now, positiveTtlMs: 5000 });
    await gate.lookup("session=abc");
    time.advance(-60_000);
    await gate.lookup("session=abc");
    expect(calls).toHaveLength(2);
  });

  it("maps 401 to signed out, 403 to no access, and everything else to unavailable", async () => {
    const cases: [Response | Error, string][] = [
      [new Response(null, { status: 401 }), "signed_out"],
      [new Response(null, { status: 403 }), "no_access"],
      [new Response(null, { status: 500 }), "unavailable"],
      [new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }), "unavailable"],
      [new Response("<html>", { status: 200 }), "unavailable"],
      [json(200, { data: { user: { id: "x", email: "x", name: null, role: "VIEWER" } } }), "unavailable"],
      [json(200, { data: { user: { ...OWNER_BODY.data.user, extra: 1 } } }), "unavailable"],
      [new Error("socket hang up"), "unavailable"],
    ];
    for (const [response, kind] of cases) {
      const { fetch } = fakeFetch(() => {
        if (response instanceof Error) throw response;
        return response;
      });
      const gate = createSessionGate({ siteOrigin: SITE, fetch });
      expect((await gate.lookup("c=1"))?.kind, kind).toBe(kind);
    }
  });

  it("reuses a positive answer for five seconds, then asks again", async () => {
    const time = clock();
    const { fetch, calls } = fakeFetch(() => json(200, OWNER_BODY));
    const gate = createSessionGate({ siteOrigin: SITE, fetch, now: time.now });
    await gate.lookup("c=1");
    time.advance(4_999);
    await gate.lookup("c=1");
    expect(calls).toHaveLength(1);
    time.advance(2);
    await gate.lookup("c=1");
    expect(calls).toHaveLength(2);
  });

  it("reuses a definite refusal for only two seconds", async () => {
    const time = clock();
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 401 }));
    const gate = createSessionGate({ siteOrigin: SITE, fetch, now: time.now });
    await gate.lookup("c=1");
    await gate.lookup("c=1");
    expect(calls).toHaveLength(1);
    time.advance(2_000);
    await gate.lookup("c=1");
    expect(calls).toHaveLength(2);
  });

  it("never remembers unavailable", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 503 }));
    const gate = createSessionGate({ siteOrigin: SITE, fetch });
    await gate.lookup("c=1");
    await gate.lookup("c=1");
    expect(calls).toHaveLength(2);
  });

  it("checks fresh for a mutating request even when a positive answer is cached", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, OWNER_BODY));
    const gate = createSessionGate({ siteOrigin: SITE, fetch });
    await gate.lookup("c=1");
    await gate.lookup("c=1", { fresh: true });
    expect(calls).toHaveLength(2);
  });

  it("allows at most eight website calls in flight, answering the rest unavailable without calling", async () => {
    const releases: (() => void)[] = [];
    const { fetch, calls } = fakeFetch(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(json(200, OWNER_BODY)));
        }),
    );
    const gate = createSessionGate({ siteOrigin: SITE, fetch });
    const held = Array.from({ length: 8 }, (_, index) => gate.lookup(`c=${index}`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(8);
    expect(await gate.lookup("c=extra")).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(8);
    for (const release of releases) release();
    await Promise.all(held);
    const again = gate.lookup("c=after");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases.at(-1)?.();
    expect((await again).kind).toBe("user");
  });

  it("gives streams their own allowance, so saturated requests cannot close signed-in streams", async () => {
    const pending: (() => void)[] = [];
    const { fetch } = fakeFetch(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(() => resolve(json(200, OWNER_BODY)));
        }),
    );
    const gate = createSessionGate({ siteOrigin: SITE, fetch });
    const requests = Array.from({ length: 8 }, (_, index) => gate.lookup(`request-${index}`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stream = gate.lookup("stream-cookie", { channel: "stream" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending).toHaveLength(9);
    for (const release of pending) release();
    expect((await stream).kind).toBe("user");
    await Promise.all(requests);
  });

  it("times out a slow website as unavailable", async () => {
    const { fetch } = fakeFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const gate = createSessionGate({ siteOrigin: SITE, fetch, timeoutMs: 20 });
    expect(await gate.lookup("c=slow")).toEqual({ kind: "unavailable" });
  });
});

describe("createIdentityLookup", () => {
  const body = (user: unknown) => json(200, { data: { user } });

  it("posts exactly the user id to the loopback identity route", async () => {
    const { fetch, calls } = fakeFetch(() => body({ id: "admin-1", role: "ADMIN" }));
    const lookup = createIdentityLookup({ siteOrigin: SITE, fetch });
    expect(await lookup.lookup("admin-1")).toEqual({ kind: "eligible", user: { id: "admin-1", role: "ADMIN" } });
    expect(calls[0]?.url).toBe("http://127.0.0.1:3000/api/panel/identity");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe('{"userId":"admin-1"}');
  });

  it("reads a null user as not eligible, and never caches it", async () => {
    const { fetch, calls } = fakeFetch(() => body(null));
    const lookup = createIdentityLookup({ siteOrigin: SITE, fetch });
    expect(await lookup.lookup("gone")).toEqual({ kind: "not_eligible" });
    expect(await lookup.lookup("gone")).toEqual({ kind: "not_eligible" });
    expect(calls).toHaveLength(2);
  });

  it("treats errors, malformed bodies and an answer about someone else as unavailable", async () => {
    const outcomes: (() => Response | Error)[] = [
      () => new Response(null, { status: 500 }),
      () => new Response("not json", { status: 200 }),
      () => body({ id: "owner-9", role: "OWNER" }),
      () => body({ id: "admin-1", role: "VIEWER" }),
      () => new Error("refused"),
    ];
    for (const outcome of outcomes) {
      const { fetch } = fakeFetch(() => {
        const value = outcome();
        if (value instanceof Error) throw value;
        return value;
      });
      const lookup = createIdentityLookup({ siteOrigin: SITE, fetch });
      expect(await lookup.lookup("admin-1")).toEqual({ kind: "unavailable" });
    }
  });
});
