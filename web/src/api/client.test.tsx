import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApiClient, PanelApiError, safeLoginUrl } from "./client.js";

const dataSchema = z.strictObject({ ready: z.boolean() });

describe("panel API client", () => {
  it("sends the request marker and validates the success envelope", async () => {
    let requestedUrl: RequestInfo | URL | undefined;
    let requestInit: RequestInit | undefined;
    const fetcher: typeof fetch = (input, init) => {
      requestedUrl = input;
      requestInit = init;
      return Promise.resolve(new Response(JSON.stringify({ data: { ready: true } }), { status: 200, headers: { "content-type": "application/json" } }));
    };

    const client = createApiClient({ basePath: "/panel", fetcher, getLocation: () => ({ pathname: "/panel/", search: "" }) });
    await expect(client.get("/api/v1/health", dataSchema)).resolves.toEqual({ ready: true });
    expect(requestedUrl).toBe("/panel/api/v1/health");
    expect(new Headers(requestInit?.headers).get("X-Panel-Request")).toBe("1");
    expect(requestInit?.credentials).toBe("same-origin");
  });

  it("sends an upload as the raw bytes, marked as an octet stream, with the request marker", async () => {
    let requestInit: RequestInit | undefined;
    const fetcher: typeof fetch = (_input, init) => {
      requestInit = init;
      return Promise.resolve(new Response(JSON.stringify({ data: { saved: true } }), { status: 200, headers: { "content-type": "application/json" } }));
    };
    const client = createApiClient({ basePath: "/panel", fetcher, getLocation: () => ({ pathname: "/panel/", search: "" }) });
    const file = new Blob([new Uint8Array([0, 255])], { type: "application/octet-stream" });

    await expect(client.upload("/api/v1/servers/alpha/upload?path=x.bin", z.strictObject({ saved: z.literal(true) }), file)).resolves.toEqual({ saved: true });
    expect(requestInit?.method).toBe("PUT");
    expect(requestInit?.body).toBe(file);
    expect(new Headers(requestInit?.headers).get("Content-Type")).toBe("application/octet-stream");
    expect(new Headers(requestInit?.headers).get("X-Panel-Request")).toBe("1");
  });

  it("does not refuse a file name with two dots, which is encoded in the query and checked by the daemon", async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ data: { saved: true } }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createApiClient({ basePath: "/panel", fetcher, getLocation: () => ({ pathname: "/panel/", search: "" }) });
    const file = new Blob(["x"]);
    await expect(client.upload(`/api/v1/servers/alpha/upload?path=${encodeURIComponent("mods/a..b.jar")}`, z.strictObject({ saved: z.literal(true) }), file)).resolves.toEqual({ saved: true });
  });

  it("rejects malformed response data", async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ data: { ready: "yes" } }), { status: 200 }));
    const client = createApiClient({ basePath: "/panel", fetcher, getLocation: () => ({ pathname: "/panel/", search: "" }) });

    await expect(client.get("/api/v1/health", dataSchema)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("preserves structured error details for feature-specific validation", async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
      error: { code: "conflict", message: "The file changed.", details: { content: "safe", revision: "opaque" } },
    }), { status: 409, headers: { "content-type": "application/json" } }));
    const client = createApiClient({ basePath: "/panel", fetcher });

    await expect(client.get("/api/v1/health", dataSchema)).rejects.toMatchObject({
      code: "conflict",
      details: { content: "safe", revision: "opaque" },
    });
  });

  it("uses only the server reauthentication boolean when preparing a same-origin login URL", async () => {
    let loginUrl: string | null = null;
    const fetcher: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
      error: { code: "unauthenticated", message: "Sign in required", details: { reauth: true } },
    }), { status: 401, headers: { "content-type": "application/json" } }));
    const client = createApiClient({
      basePath: "/panel",
      fetcher,
      getLocation: () => ({ pathname: "/panel/servers/test/console", search: "?filter=recent" }),
      onUnauthenticated: (url) => { loginUrl = url; },
    });

    await expect(client.get("/api/v1/me", dataSchema)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(loginUrl).toBe("/login?next=%2Fpanel%2Fservers%2Ftest%2Fconsole%3Ffilter%3Drecent&reauth=1");
  });

  it("does not add the reauthentication marker when the server says there was no recognized cookie", async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
      error: { code: "unauthenticated", message: "Sign in required", details: { reauth: false } },
    }), { status: 401, headers: { "content-type": "application/json" } }));
    const client = createApiClient({
      basePath: "/panel",
      fetcher,
      getLocation: () => ({ pathname: "/outside", search: "?x=1" }),
    });

    await expect(client.get("/api/v1/me", dataSchema)).rejects.toBeInstanceOf(PanelApiError);
    expect(safeLoginUrl("/panel", { pathname: "/outside", search: "?x=1" }, false)).toBe("/login?next=%2Fpanel%2F");
  });
});
