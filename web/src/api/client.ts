// Validate API envelopes before feature code sees them, and keep authentication redirects on this origin.
import { apiErrorSchema, type ApiErrorCode } from "@shared/api.js";
import { z } from "zod";
import { normalizePanelBasePath } from "../lib/base-path.js";

export type PanelApiErrorCode = ApiErrorCode | "invalid_response" | "network_error";

export class PanelApiError extends Error {
  readonly code: PanelApiErrorCode;
  readonly status: number | null;
  readonly details: unknown;

  constructor(code: PanelApiErrorCode, message: string, status: number | null = null, details?: unknown) {
    super(message);
    this.name = "PanelApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type BrowserLocation = { readonly pathname: string; readonly search: string };
export type ApiClientOptions = {
  readonly basePath: string;
  readonly fetcher?: typeof fetch;
  readonly getLocation?: () => BrowserLocation;
  readonly onUnauthenticated?: (loginUrl: string) => void;
};

type RequestOptions = {
  readonly method?: "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  /** Raw bytes sent as application/octet-stream, used for uploads. Takes the place of a JSON body. */
  readonly rawBody?: Blob;
  readonly signal?: AbortSignal;
};

const reauthDetailsSchema = z.object({ reauth: z.boolean() }).passthrough();
const envelopeSchema = <T>(dataSchema: z.ZodType<T>) => z.object({ data: dataSchema }).strict();

function getReauthFlag(details: unknown): boolean {
  const result = reauthDetailsSchema.safeParse(details);
  return result.success && result.data.reauth;
}

export function safeLoginUrl(basePath: string, location: BrowserLocation, reauth: boolean): string {
  const base = normalizePanelBasePath(basePath);
  const isPanelPath = location.pathname === base || location.pathname.startsWith(`${base}/`);
  const next = isPanelPath ? `${location.pathname}${location.search}` : `${base}/`;
  const query = new URLSearchParams({ next });
  if (reauth) query.set("reauth", "1");
  return `/login?${query.toString()}`;
}

export function createApiClient(options: ApiClientOptions) {
  const basePath = normalizePanelBasePath(options.basePath);
  const fetcher = options.fetcher ?? fetch;
  const getLocation = options.getLocation ?? (() => ({ pathname: window.location.pathname, search: window.location.search }));

  async function request<T>(apiPath: string, schema: z.ZodType<T>, requestOptions: RequestOptions = {}): Promise<T> {
    // The check covers the resource path only: a query value (a file name, say) is encoded and checked by the daemon.
    const resource = apiPath.split("?")[0] ?? apiPath;
    if (!resource.startsWith("/api/v1/") || resource.includes("..") || resource.includes("\\")) {
      throw new PanelApiError("invalid_request", "The requested panel resource is invalid.");
    }

    const method = requestOptions.method ?? "GET";
    const headers = new Headers({ Accept: "application/json", "X-Panel-Request": "1" });
    if (requestOptions.rawBody !== undefined) {
      headers.set("Content-Type", "application/octet-stream");
    } else if (requestOptions.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    let response: Response;
    try {
      response = await fetcher(`${basePath}${apiPath}`, {
        method,
        cache: "no-store",
        headers,
        credentials: "same-origin",
        ...(requestOptions.rawBody !== undefined
          ? { body: requestOptions.rawBody }
          : requestOptions.body === undefined
            ? {}
            : { body: JSON.stringify(requestOptions.body) }),
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
    } catch (error) {
      if (requestOptions.signal?.aborted) throw error;
      throw new PanelApiError("network_error", "The panel could not be reached.");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PanelApiError("invalid_response", "The panel returned an unreadable response.", response.status);
    }

    if (!response.ok) {
      const parsedError = apiErrorSchema.safeParse(payload);
      if (!parsedError.success) {
        throw new PanelApiError("invalid_response", "The panel returned an invalid error response.", response.status);
      }

      const apiError = parsedError.data.error;
      if (apiError.code === "unauthenticated") {
        const loginUrl = safeLoginUrl(basePath, getLocation(), getReauthFlag(apiError.details));
        options.onUnauthenticated?.(loginUrl);
      }
      throw new PanelApiError(apiError.code, apiError.message, response.status, apiError.details);
    }

    const parsed = envelopeSchema(schema).safeParse(payload);
    if (!parsed.success) {
      throw new PanelApiError("invalid_response", "The panel returned data in an unexpected format.", response.status);
    }
    return parsed.data.data;
  }

  return {
    get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
      return request(path, schema, signal === undefined ? {} : { signal });
    },
    put<T>(path: string, schema: z.ZodType<T>, body: unknown, signal?: AbortSignal): Promise<T> {
      return request(path, schema, { method: "PUT", body, ...(signal === undefined ? {} : { signal }) });
    },
    post<T>(path: string, schema: z.ZodType<T>, body: unknown, signal?: AbortSignal): Promise<T> {
      return request(path, schema, { method: "POST", body, ...(signal === undefined ? {} : { signal }) });
    },
    upload<T>(path: string, schema: z.ZodType<T>, file: Blob, signal?: AbortSignal): Promise<T> {
      return request(path, schema, { method: "PUT", rawBody: file, ...(signal === undefined ? {} : { signal }) });
    },
    patch<T>(path: string, schema: z.ZodType<T>, body: unknown, signal?: AbortSignal): Promise<T> {
      return request(path, schema, { method: "PATCH", body, ...(signal === undefined ? {} : { signal }) });
    },
    delete<T>(path: string, schema: z.ZodType<T>, body: unknown, signal?: AbortSignal): Promise<T> {
      return request(path, schema, { method: "DELETE", body, ...(signal === undefined ? {} : { signal }) });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
