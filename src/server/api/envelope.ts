// The response envelope: success is `{ data }`, failure is `{ error: { code, message, details? } }`. The status for each error code
// is fixed here, so a route cannot answer the same condition with two different statuses.
import type { FastifyReply } from "fastify";
import type { ApiErrorCode } from "../../shared/api.js";

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  no_access: 403,
  forbidden: 403,
  unavailable: 503,
  invalid_request: 400,
  confirmation_required: 409,
  not_found: 404,
  rate_limited: 429,
  conflict: 409,
  csrf_refused: 403,
  wrong_host: 403,
  too_many_streams: 429,
  payload_too_large: 413,
  request_timeout: 408,
  unsupported_media_type: 415,
  internal_error: 500,
};

export function sendData(reply: FastifyReply, data: unknown, status = 200): FastifyReply {
  return reply.code(status).header("cache-control", "no-store").send({ data });
}

export function sendError(reply: FastifyReply, code: ApiErrorCode, message: string, details?: unknown): FastifyReply {
  const body = details === undefined ? { error: { code, message } } : { error: { code, message, details } };
  return reply.code(STATUS[code]).header("cache-control", "no-store").send(body);
}
