// The privileged-action route. The password arrives in the body and is used once: it is handed to sudo on standard input and then
// dropped. It is never passed to the audit writer, which removes secret-named keys anyway, and the audit row records only the
// action, the exit status and who asked.
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { recordAudit } from "../audit/audit.js";
import { catalogue, findAction } from "../privileged/catalogue.js";
import { type PasswordLockout, LOCK_MS } from "../privileged/lockout.js";
import { runPrivileged } from "../privileged/run.js";
import type { PanelDatabase } from "../db/open.js";
import type { Runner } from "../systemd/run.js";
import type { PanelUser } from "../../shared/api.js";
import { sendData, sendError } from "./envelope.js";
import type { AlertService } from "../alerts/alerts.js";

export interface PrivilegedContext {
  readonly db: PanelDatabase;
  readonly alerts: AlertService;
  readonly run: Runner;
  readonly sudo: string;
  readonly lockout: PasswordLockout;
  readonly account: string;
  readonly now: () => Date;
}

const privilegedBody = z.strictObject({
  password: z.string().min(1).max(1024),
  javaPackage: z.string().max(64).optional(),
});

export function privilegedRun(ctx: PrivilegedContext) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const user = request.panelUser as PanelUser;
    const actionId = (request.params as { actionId: string }).actionId;
    const parsed = privilegedBody.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, "invalid_request", "The request body is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), code: issue.code })),
      });
    }
    const remaining = ctx.lockout.remaining();
    if (remaining > 0) {
      const minutes = Math.ceil(remaining / 60_000);
      return sendError(reply, "rate_limited", `Privileged actions are paused for ${minutes} more minute(s) after failed passwords.`);
    }

    let actions;
    try {
      actions = catalogue({
        account: ctx.account,
        ...(parsed.data.javaPackage === undefined ? {} : { javaPackage: parsed.data.javaPackage }),
      });
    } catch (error) {
      if (error instanceof RangeError) return sendError(reply, "invalid_request", "That Java package is not available to install.");
      throw error;
    }
    const action = findAction(actionId, actions);
    if (action === undefined) return sendError(reply, "not_found", "That action is not in the panel's catalogue.");

    const actor = { userId: user.id, userLabel: user.email, serverId: null };
    const outcome = await runPrivileged(ctx.run, ctx.sudo, action, parsed.data.password);
    if (outcome.kind === "wrong_password") {
      const locked = ctx.lockout.record(false);
      recordAudit(ctx.db, { ...actor, action: `privileged.${action.id}`, outcome: "denied", details: { reason: "wrong password" } }, ctx.now());
      if (locked) {
        recordAudit(ctx.db, { ...actor, action: "privileged.lockout", outcome: "failed", details: { minutes: LOCK_MS / 60_000 } }, ctx.now());
        void ctx.alerts.raise("privileged-lockout", null, `Privileged actions were paused for ${LOCK_MS / 60_000} minutes after two wrong account passwords.`);
      }
      return sendError(reply, "forbidden", "The account password was not accepted.");
    }
    ctx.lockout.record(true);
    recordAudit(
      ctx.db,
      {
        ...actor,
        action: `privileged.${action.id}`,
        outcome: outcome.exitCode === 0 ? "ok" : "failed",
        details: { exitCode: outcome.exitCode },
      },
      ctx.now(),
    );
    return sendData(reply, { exitCode: outcome.exitCode, output: outcome.output });
  };
}
