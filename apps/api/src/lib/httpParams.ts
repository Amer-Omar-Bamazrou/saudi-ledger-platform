/**
 * Route-parameter validation shared by every controller.
 *
 * 🔴 The 2026-08-20 audit found `Number(req.params.id)` reaching queries on ~9
 * controllers, where a non-numeric id becomes NaN and surfaces as a raw 500
 * (Postgres 22P02) instead of a 400. `quotations.controller.ts` established
 * the fix for NEW controllers ("green fixes the case, not the class", applied
 * forwards); this helper is the backwards half — one implementation, every
 * controller, so the eleventh controller cannot re-introduce the class.
 *
 * A malformed id is a 400 (schema-shaped input error), not a 404: nothing was
 * looked up, so "not found" would claim a search that never ran.
 */
import type { Request } from "express";
import { BadRequestError } from "./errors";

export function requireIdParam(req: Request, name = "id"): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw new BadRequestError(`Invalid ${name}`);
  return id;
}

/**
 * The default page, stated ONCE so the API, the UI and the tests agree.
 * Exported because the web client's picker limit is derived from the same
 * ceiling rather than from a second guess.
 */
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

/**
 * `limit`/`offset` off the query string, bounded.
 *
 * 🔴 Extracted because it had already been copied into three controllers and
 * was about to be copied into twelve more. A page size is one decision; three
 * copies of it are three decisions that will drift, and the fourth copy is
 * where the drift starts. Same reasoning as one-writer-per-effect, applied to
 * a four-line helper.
 *
 * `limit` is CLAMPED rather than rejected: a caller asking for everything gets
 * a page and a `total` telling them there is more, which is the honest answer
 * to "give me all of it". NaN falls back to the default rather than reaching
 * the driver as `LIMIT NaN`.
 */
export function pageParams(
  query: Record<string, unknown>,
  defaultLimit = DEFAULT_PAGE,
): { limit: number; offset: number } {
  const n = Number(query.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(MAX_PAGE, Math.floor(n)) : defaultLimit;
  return { limit, offset: Math.max(0, Number(query.offset) || 0) };
}

/**
 * A JSON payload arriving as a multipart form field (the capture route's
 * `extraction` / `fieldSources`).
 *
 * 🔴 Malformed JSON REFUSES; it is never silently dropped (audit 2026-08-20,
 * MED). The old `catch → undefined` staged a capture with the user's OCR
 * extraction lost and no signal — "partial data is not lenient data": absent
 * is a valid state, but a present-and-unreadable field must not become
 * absent. The frontend is the only caller and retries cheaply, so a 400 costs
 * one round-trip and saves a silent data loss.
 */
export function parseJsonField(value: unknown, field: string): unknown | undefined {
  if (value == null || (typeof value === "string" && !value.trim())) return undefined;
  if (typeof value !== "string") throw new BadRequestError(`${field} must be a JSON string.`);
  try {
    return JSON.parse(value);
  } catch {
    throw new BadRequestError(`${field} is not valid JSON.`);
  }
}
