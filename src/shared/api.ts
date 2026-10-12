// The wire shapes the daemon and the UI agree on: the response envelope, the stable error codes, and the signed-in person.
//
// Success is `{ data }`, failure is `{ error: { code, message, details? } }`, the same envelope the website uses. `code` is a
// stable snake_case token the UI switches on; `message` is for people. `details` carries validation issue codes and paths,
// never an echo of what the caller sent.
import { z } from "zod";

export const API_ERROR_CODES = [
  "unauthenticated",
  "no_access",
  "forbidden",
  "unavailable",
  "invalid_request",
  "confirmation_required",
  "not_found",
  "rate_limited",
  "conflict",
  "csrf_refused",
  "wrong_host",
  "too_many_streams",
  "payload_too_large",
  "request_timeout",
  "unsupported_media_type",
  "internal_error",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

/** What the website's session endpoint says about the caller. Only OWNER and ADMIN ever reach the panel. */
export const panelUserSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  email: z.string().max(320),
  name: z.string().max(200).nullable(),
  role: z.enum(["OWNER", "ADMIN"]),
});
export type PanelUser = z.infer<typeof panelUserSchema>;

/** The body of GET /api/v1/me: the signed-in person and nothing else. */
export const meSchema = z.strictObject({ user: panelUserSchema, ownerOrOperator: z.boolean() });
export type Me = z.infer<typeof meSchema>;
