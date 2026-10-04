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
import { translateDbRefusal } from "../lib/dbRefusals";

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

  const code = (err as { statusCode?: unknown })?.statusCode;
  if (typeof code === "number" && code >= 400 && code < 600) {
    // Preserve rich, structured error bodies (e.g. { error, code, detail }).
    const payload = (err as { payload?: unknown }).payload;
    if (payload && typeof payload === "object") {
      res.status(code).json(payload);
      return;
    }
    res.status(code).json({ error: (err as Error).message });
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
    req.log.warn({ err }, "varchar overflow mapped to 400");
    res.status(400).json({ error: "A field exceeds its maximum allowed length." });
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
    res.status(refusal.status).json(refusal.body);
    return;
  }

  req.log.error({ err });
  res.status(500).json({ error: "Internal server error" });
}
