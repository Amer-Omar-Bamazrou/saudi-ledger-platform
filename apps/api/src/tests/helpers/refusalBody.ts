/**
 * The error-handling work package (2026-11-17): every error body carries `requestId` — the request's own reference, a
 * fresh UUID per request, independent of what was asked for (held by `wp-error-bodies.test.ts`: two requests never
 * share one). Two refusals that must be INDISTINGUISHABLE (no existence oracle: missing ≡ foreign) are therefore
 * compared without it; the reference is checked to be exactly that — present and a UUID — and then removed.
 */
import { expect } from "vitest";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The body as an oracle would compare it: everything but the per-request reference. */
export function withoutReference<T>(body: T): T {
  if (!body || typeof body !== "object") return body;
  const { requestId, ...rest } = body as Record<string, unknown>;
  expect(requestId, "an error body carries its request's reference").toMatch(UUID);
  return rest as T;
}
