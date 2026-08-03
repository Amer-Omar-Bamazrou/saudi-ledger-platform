/**
 * Single-use link tokens (M11.7) — invitations today, password-reset links later.
 *
 * The pattern: generate 32 cryptographically-random bytes, hand the RAW value to
 * the user (in a link), and persist ONLY its SHA-256. Verification hashes the
 * presented token and looks the row up by that hash, so:
 *   - a database leak yields no usable tokens (the raw value is not stored), and
 *   - the lookup is an indexed equality on a fixed-length digest, so there is no
 *     secret-dependent comparison to time (no need for a constant-time compare).
 *
 * 256 bits of entropy makes guessing infeasible; the accept endpoint is
 * additionally rate-limited as defense in depth.
 */
import { createHash, randomBytes } from "node:crypto";

/** A URL-safe random token (base64url, 32 bytes of entropy). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex digest — what gets persisted and what lookups key on. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}
