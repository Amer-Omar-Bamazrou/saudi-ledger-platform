/**
 * 🔴 ONE idempotency-key implementation (G36-KEY #217, extended by Phase 18 R-8 — G37/G40, memo §2e; register
 * §11.104). Every money act that takes a key uses it: the bill payment, and the customer and supplier allocate,
 * credit-note apply and refund.
 *
 *   - The key is the caller's (`idempotencyKey`, trimmed; empty = none), unique per COMPANY and OPERATION (the
 *     effect table's partial unique index, operation-qualified where two operations share a table).
 *   - The REQUEST FINGERPRINT is a SHA-256 of the fields that decide the act's effect, stored on the effect row
 *     beside the key. Values are taken as sent — a default the service fills in (today's date) is not, so a retry
 *     that omits it repeats the omission.
 *   - `replayOrRefuse` runs BEFORE any check and AGAIN under the operation's row lock (a concurrent duplicate waits
 *     on the lock, then finds the first one's row): the SAME request is a replay — answered as the first was, nothing
 *     written; a DIFFERENT one is refused 409 `idempotency_key_reused`, nothing written. A prior row carrying no
 *     fingerprint (recorded before the rule) cannot be compared, so it is refused, never replayed blind.
 */
import { createHash } from "node:crypto";
import { BusinessRuleError } from "./errors";

export type Idempotency = { key: string; fingerprint: string };

/** The longest key accepted (each effect table's CHECK says the same). */
export const IDEMPOTENCY_KEY_MAX = 120;

/** The SHA-256 of the effect-deciding fields, in a fixed order. */
export function requestFingerprint(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** A request's key and fingerprint, or null when it names no key. */
export function idempotencyOf(rawKey: unknown, parts: readonly unknown[]): Idempotency | null {
  const key = typeof rawKey === "string" && rawKey.trim() ? rawKey.trim() : null;
  return key ? { key, fingerprint: requestFingerprint(parts) } : null;
}

/** A field as sent: an absent or empty value is `null` (never a default the service fills in). */
export const asSent = (v: unknown): unknown => (v === undefined || v === "" ? null : v);

/**
 * The refusal of a key already used for a different request (or one that cannot be compared). `what` names the
 * act in the reader's words ("payment", "allocation", "credit-note application", "refund").
 */
export function keyReusedRefusal(key: string, what: string, detail?: string): BusinessRuleError {
  return new BusinessRuleError(409, {
    code: "idempotency_key_reused",
    error: `Idempotency key "${key}" was already used for a different ${what}${detail ? ` (${detail})` : ""}. Nothing was recorded; use a new key for a new ${what}.`,
  });
}

/**
 * A prior effect under the key: `true` = the same request, REPLAY it (answer as the first was, write nothing);
 * `false` = no prior, go ahead; a different request — or a prior that cannot be compared — is THROWN as 409.
 */
export function replayOrRefuse(
  prior: { requestFingerprint: string | null } | undefined,
  idem: Idempotency,
  what: string,
  detail?: string,
): boolean {
  if (!prior) return false;
  if (prior.requestFingerprint != null && prior.requestFingerprint === idem.fingerprint) return true;
  throw keyReusedRefusal(idem.key, what, detail);
}
