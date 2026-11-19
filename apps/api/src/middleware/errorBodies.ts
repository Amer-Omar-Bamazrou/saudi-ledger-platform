/**
 * 🔴 The error-handling work package (owner-approved 2026-11-17): EVERY error response has one shape —
 * `{ code, error, errorAr, requestId, …the refusal's own structured fields }` — whichever line of code sent it.
 *
 *  - `code`: the body's own stable code, or one for its status class (`codeForStatus`). Never reworded: clients key on it.
 *  - 4xx: the platform's own sentence is kept (`error`, and `errorAr` where written); missing Arabic falls back to the
 *    safe sentence for the code or status class (`lib/userMessages.ts`) FOLLOWED BY the English sentence, named as
 *    English, whenever that sentence is the refusal's own reason — an Arabic reader is never left with the generic
 *    sentence alone.
 *  - 5xx: the body's text is NEVER sent — only the safe sentences for its code (`pdf_renderer_unavailable`, …) or
 *    `internal_error`. Whatever the exception said (SQL, paths, an installation instruction) stays in the server log,
 *    which carries the same `requestId` so support can find it.
 *  - `requestId`: the request's id from pino-http (`req.id`).
 *
 * Applied twice by construction: `errorHandler` builds its bodies through `normaliseErrorBody`, and `errorBodies`
 * wraps `res.json` so a route that answers an error itself (`res.status(403).json({ error })`) gets the same shape.
 * Normalising an already-normal body changes nothing.
 */
import type { NextFunction, Request, Response } from "express";
import { SAFE_MESSAGES, codeForStatus, isStableCode } from "../lib/userMessages";

/** Structured fields a 5xx may keep (they carry no exception text). */
const SAFE_5XX_FIELDS = ["retryAfterSeconds"] as const;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export function normaliseErrorBody(status: number, body: unknown, requestId: string): Record<string, unknown> {
  const b: Record<string, unknown> = body && typeof body === "object" && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {};
  const statusCode = codeForStatus(status);
  const code = isStableCode(b.code) ? b.code : statusCode;
  if (status >= 500) {
    const m = SAFE_MESSAGES[code] ?? SAFE_MESSAGES[statusCode] ?? SAFE_MESSAGES.internal_error;
    const out: Record<string, unknown> = { code, error: m.en, errorAr: m.ar, requestId };
    for (const k of SAFE_5XX_FIELDS) if (typeof b[k] === "number") out[k] = b[k];
    return out;
  }
  const fallback = SAFE_MESSAGES[code] ?? SAFE_MESSAGES[statusCode] ?? SAFE_MESSAGES.bad_request;
  const error = nonEmpty(b.error) ? b.error : fallback.en;
  return {
    ...b,
    code,
    error,
    // 🔴 A refusal's own English sentence IS its reason (our words, never exception text). Where nobody has written
    // its Arabic yet, the Arabic reader gets the safe Arabic sentence AND that reason, named as English — never the
    // generic sentence alone, which would hide why (CI e2e, 13B-3's over-credit refusal, 2026-11-17).
    errorAr: nonEmpty(b.errorAr) ? b.errorAr : error === fallback.en ? fallback.ar : `${fallback.ar} التفاصيل (بالإنجليزية): ${error}`,
    requestId,
  };
}

export const requestIdOf = (req: Request): string => String((req as { id?: unknown }).id ?? "");

/** Wraps `res.json` so any error status is answered in the one shape. Mounted before every router. */
export function errorBodies(req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = ((body?: unknown) => (res.statusCode >= 400 ? json(normaliseErrorBody(res.statusCode, body, requestIdOf(req))) : json(body))) as Response["json"];
  next();
}
