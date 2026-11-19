/**
 * Centralized error-handling middleware (M6).
 *
 * Registered last in the Express chain. Controllers/services throw (Express 5
 * forwards rejected async handlers here automatically); this translates the
 * error to an HTTP response. The translation is intentionally identical to the
 * pre-M6 `handleRouteError` helper so API responses do not change:
 *   - an error carrying a numeric `statusCode` in [400, 600) → that status +
 *     the error's message (covers AppError and the legacy `{ statusCode }` tag);
 *   - anything else → logged and returned as a generic 500.
 */
import type { Request, Response, NextFunction } from "express";
import { TenantTransactionEndedError } from "@workspace/db";
import { translateDbRefusal } from "../lib/dbRefusals";
import { recordApprovalRefusal, recordReferenceRefusal } from "./referenceRefusals";
import { normaliseErrorBody, requestIdOf } from "./errorBodies";
import { SAFE_MESSAGES, codeForStatus, isStableCode } from "../lib/userMessages";

/** The ended tenant handle's refusal, as thrown or as drizzle wraps it (a "Failed query" whose cause it is). */
export function isEndedTransactionRefusal(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    if (e instanceof TenantTransactionEndedError || (e as { name?: unknown }).name === "TenantTransactionEndedError") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // If a response was already partially sent, defer to Express' default handler.
  if (res.headersSent) {
    next(err);
    return;
  }

  // 🔴 Phase 18 audit A29: the client went away, `resolveTenant` rolled the transaction back, and the handler's next
  // statement was refused by the ended handle — by design, and nobody is waiting for an answer. Logged as that, at
  // info, and nothing is sent. It used to be an ERROR with a stack and a 500 to a closed socket, 52–63 times in every
  // browser run, hiding real failures among them. The same refusal on a request NOT rolled back on close falls
  // through to the ERROR below: a handler using an ended handle on a live request is a bug.
  if (res.locals?.tenantRolledBackOnClose === true && isEndedTransactionRefusal(err)) {
    req.log.info({ method: req.method, path: req.path }, "client went away: the request's transaction was rolled back and its remaining statements refused");
    return;
  }

  // 🔴 The error-handling work package (2026-11-17): every body below goes through `send`, the ONE shape
  // (`normaliseErrorBody`): a stable code, English and Arabic, the request id; a 5xx never carries its exception's text.
  const send = (status: number, body: Record<string, unknown>) => {
    res.status(status).json(normaliseErrorBody(status, body, requestIdOf(req)));
  };

  const code = (err as { statusCode?: unknown })?.statusCode;
  if (typeof code === "number" && code >= 400 && code < 600) {
    // A 5xx is OUR failure: its message (an installation hint, a signing fault, SQL) goes to the log only, with the
    // request id the response carries; the body says what the user may know (its stable code's safe sentence).
    if (code >= 500) {
      req.log.error({ err, requestId: requestIdOf(req) }, "server error (5xx) — the message stays in this log");
      // Its code is kept — on the error itself, or in an AppError's payload (`rate_limit_unavailable`): clients key on it.
      const ownCode = (err as { code?: unknown }).code ?? ((err as { payload?: { code?: unknown } }).payload?.code);
      send(code, isStableCode(ownCode) ? { code: ownCode } : {});
      return;
    }
    // A LIBRARY's 4xx (body-parser: malformed JSON, a body too large) carries the library's text ("Unexpected token
    // … at position 12") — not a sentence written for users. Named by its own `type`, answered by status.
    const libraryType = (err as { type?: unknown }).type;
    if (typeof libraryType === "string" && /^(entity|request|encoding|charset|parameters|stream)\./.test(libraryType)) {
      req.log.warn({ err, requestId: requestIdOf(req) }, "request refused by the body parser");
      send(code, { code: libraryType === "entity.parse.failed" ? "invalid_json" : codeForStatus(code) });
      return;
    }
    // Preserve rich, structured error bodies (e.g. { error, code, detail }).
    const payload = (err as { payload?: unknown }).payload;
    if (payload && typeof payload === "object") {
      // R-9 (DR-22): a cross-tenant reference refusal is recorded in the security trail (best-effort).
      recordReferenceRefusal(req, code, payload);
      send(code, payload as Record<string, unknown>);
      return;
    }
    // The platform's own 4xx (an AppError, or one of our classes tagged with a status): its sentence was written for
    // users. Its own code, where it has one, is kept.
    const ownCode = (err as { code?: unknown }).code;
    send(code, { error: (err as Error).message, ...(isStableCode(ownCode) ? { code: ownCode } : {}) });
    return;
  }

  // ── Class-level Postgres mappings (audit 2026-08-20, LOW / M-4 family) ────
  // 22001 (value too long for varchar) is PREDICTABLE user input hitting a
  // column bound — a 400, not a 500. Mapped HERE, at the one boundary every
  // path shares, rather than per-field guards in seven services: present and
  // future varchar columns inherit it (the write-boundary rule applied to an
  // error translation). The driver does not reliably name the column, so the
  // message stays generic; the log line carries the full error.
  if ((err as { code?: string })?.code === "22001") {
    req.log.warn({ err, requestId: requestIdOf(req) }, "varchar overflow mapped to 400");
    send(400, { code: "field_too_long", error: SAFE_MESSAGES.field_too_long.en, errorAr: SAFE_MESSAGES.field_too_long.ar });
    return;
  }

  // The database's own refusals — the banking (12C/12D), budget (0112) and
  // tax/treasury (0113–0115) triggers refuse from EVERY path, so they are
  // translated once, in `lib/dbRefusals.ts`, which the COMMIT path shares (a
  // deferred trigger refuses there). An exact allow-list: anything else is a
  // bug and stays a logged 500.
  const refusal = translateDbRefusal(err);
  if (refusal) {
    req.log.warn({ code: refusal.body.code }, "refusal from the database");
    recordReferenceRefusal(req, refusal.status, refusal.body);
    recordApprovalRefusal(req, refusal.status, refusal.body);
    send(refusal.status, refusal.body as Record<string, unknown>);
    return;
  }

  req.log.error({ err, requestId: requestIdOf(req) }, "unexpected error — the message stays in this log");
  send(500, { code: "internal_error" });
}
