/**
 * 🔴 Phase 19A (19.1/19.2) — TOTP, RFC 6238 over RFC 4226: HMAC-SHA1, a 30-second step, six digits — the parameters
 * every authenticator app assumes. ONE SEAM: nothing else in the codebase computes or compares a code. Held to the
 * RFC's own test vectors by tests/phase19a-totp.test.ts.
 *
 * A code is accepted at its own step or one step either side (clock drift), and `matchTotp` reports WHICH step
 * matched, so the caller can refuse a step it has already accepted (replay) — that guard lives with the factor's row,
 * not here.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of now that a code may come from. */
export const TOTP_DRIFT_STEPS = 1;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("base32Decode: not a base32 string");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret (RFC 4226 §4 R6's recommended length). */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function currentTotpStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** The six digits for one step. */
export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** The step a code belongs to (now, or one either side), or null. Constant-time per comparison. */
export function matchTotp(secret: Buffer, code: unknown, nowStep: number = currentTotpStep()): number | null {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let d = -TOTP_DRIFT_STEPS; d <= TOTP_DRIFT_STEPS; d++) {
    if (timingSafeEqual(given, Buffer.from(totpAt(secret, nowStep + d)))) matched = nowStep + d;
  }
  return matched;
}

/** What the QR encodes (the Key URI format authenticator apps read). */
export function otpauthUri(input: { issuer: string; account: string; secret: Buffer }): string {
  const issuer = encodeURIComponent(input.issuer);
  return `otpauth://totp/${issuer}:${encodeURIComponent(input.account)}?secret=${base32Encode(input.secret)}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
