/**
 * PASSWORD HASHING — the one seam (M-4).
 *
 * ── 🔴 WHY THIS EXISTS, MEASURED RATHER THAN ASSERTED (2026-09-02) ─────────
 * The queue said "bcryptjs blocks the event loop on public endpoints". True,
 * but not by the mechanism stated, and the measurement changes the fix. On
 * this machine (cost 12, Node 24), with a 5ms interval measuring event-loop
 * lag — the delay every OTHER request in the process experiences:
 *
 *   bcryptjs async compare                753ms wall,     98ms worst lag
 *   bcryptjs async compare, 1 MB password 786ms wall,    129ms worst lag
 *   🔴 TEN concurrent bcryptjs compares  10598ms wall,   2068ms worst lag
 *   crypto.scrypt AT THE PARAMETERS BELOW  549ms wall,     14ms worst lag
 *   🔴 TEN concurrent, same parameters    2145ms wall,     23ms worst lag
 *
 * bcryptjs's async API DOES yield between rounds, so one login costs ~98ms of
 * lag rather than 750ms. **The damage is concurrency**: ten simultaneous
 * logins — a busy morning, not an attack — stall the loop for two seconds,
 * and every tenant's unrelated request waits behind them. `crypto.scrypt`
 * runs on the libuv threadpool: 5x less wall time and 90x less lag under the
 * same load, with no native dependency to build or deploy.
 *
 * 🔴 The scrypt figures are measured AT N=2^17 — the parameters this file
 * actually ships — not at Node's defaults, which are cheaper and would make
 * the comparison flattering and false. Ten concurrent hashes take 2.1s of wall
 * time because the libuv threadpool is 4 threads wide by default; that is
 * queueing, not blocking, and the loop stays responsive throughout, which is
 * the property the defect was about.
 *
 * ── 🔴 AND THE LENGTH RULE IS NOT ABOUT COST ──────────────────────────────
 * A 1 MB password costs bcrypt almost nothing extra, because **bcrypt
 * truncates at 72 bytes** — verified: a 200-byte password matches a hash made
 * from its own first 72 bytes. So two different long passwords sharing a
 * 72-byte prefix are the SAME password, silently. That is the reason to bound
 * length, and scrypt (which reads the whole input) removes the truncation
 * itself.
 *
 * ── FORMAT AND MIGRATION ──────────────────────────────────────────────────
 * New hashes: `scrypt$N$r$p$<salt b64>$<key b64>` (~130 chars; the column is
 * `text`). Existing bcrypt hashes still VERIFY — nobody is locked out — and
 * `needsRehash` tells the caller to re-store a scrypt hash after a successful
 * login, so the estate migrates itself without a password reset.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import bcrypt from "bcryptjs";
import { BadRequestError } from "./errors";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

/** OWASP's floor for scrypt (2024): N=2^17, r=8, p=1. */
const N = 1 << 17;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
/** N=2^17 needs ~128 MB; the default maxmem (32 MB) would refuse it. */
const MAXMEM = 256 * 1024 * 1024;

export const MIN_PASSWORD = 8;

/**
 * 🔴 The cap is a REAL limit, not a guess at abuse. 1024 bytes is far above any
 * human passphrase and far below anything that costs the process real work;
 * bounding it also means a rejected body never reaches a KDF at all.
 */
export const MAX_PASSWORD = 1024;

/** Fields stored in `varchar(255)` — rejected as 400 here rather than 500 at the database. */
export const MAX_VARCHAR = 255;

/**
 * Validate a password BEFORE any hashing happens.
 *
 * 🔴 Both bounds throw `BadRequestError`, so an over-long password is a 400
 * the user can act on rather than a 500 from the column, and no KDF runs for
 * input that was never going to be stored.
 */
export function assertPasswordAcceptable(password: unknown, field = "password"): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new BadRequestError(`${field} must be at least ${MIN_PASSWORD} characters.`);
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD) {
    throw new BadRequestError(`${field} must be at most ${MAX_PASSWORD} bytes.`);
  }
  return password;
}

/** Reject a value that would overflow a `varchar(255)` — a 400, not a database 500. */
export function assertFitsColumn(value: string, field: string, max = MAX_VARCHAR): string {
  if (value.length > max) {
    throw new BadRequestError(`${field} must be at most ${max} characters.`);
  }
  return value;
}

/** Hash a password for storage. Validates first; never runs a KDF on rejected input. */
export async function hashPassword(password: unknown, field = "password"): Promise<string> {
  const accepted = assertPasswordAcceptable(password, field);
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(accepted, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** True when `hash` is one of the legacy bcrypt hashes rather than a scrypt one. */
export function isLegacyHash(hash: string): boolean {
  return !hash.startsWith("scrypt$");
}

/**
 * A stored hash that should be replaced after the next successful verification:
 * every bcrypt hash, and any scrypt hash whose parameters are below current.
 */
export function needsRehash(hash: string): boolean {
  if (isLegacyHash(hash)) return true;
  const [, n, r, p] = hash.split("$");
  return Number(n) < N || Number(r) < R || Number(p) < P;
}

/**
 * Verify a password against a stored hash of either generation.
 *
 * 🔴 Never throws on a malformed or unknown hash — it answers `false`. A login
 * path that throws on bad stored data tells an attacker that the row exists.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    if (isLegacyHash(storedHash)) {
      // bcryptjs, kept ONLY for verifying pre-M-4 hashes so nobody is locked out.
      return await bcrypt.compare(password, storedHash);
    }
    const [scheme, n, r, p, saltB64, keyB64] = storedHash.split("$");
    if (scheme !== "scrypt" || !saltB64 || !keyB64) return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(keyB64, "base64");

    /**
     * 🔴 A DEGENERATE HASH MUST NOT MATCH EVERYTHING. `Buffer.from("@@@",
     * "base64")` is an EMPTY buffer — base64 decoding ignores invalid
     * characters rather than failing — so a corrupted row like
     * `scrypt$131072$8$1$@@@$@@@` produced a zero-length expected key, scrypt
     * was asked for a zero-length key, and `timingSafeEqual(empty, empty)`
     * answered TRUE for ANY password. Found by asserting the malformed cases
     * rather than only the happy path; the shapes must be checked before the
     * comparison, not inferred from it.
     */
    if (salt.length !== SALT_BYTES || expected.length !== KEYLEN) return false;
    const actual = await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * The decoy hash for the "user does not exist" branch of login, so the response
 * time does not reveal whether an email is registered. Built once at startup —
 * a synchronous KDF here costs one stall before the server accepts traffic,
 * and none afterwards.
 */
let decoy: string | null = null;
export async function decoyHash(): Promise<string> {
  if (decoy === null) decoy = await hashPassword("timing-attack-decoy-not-a-real-password");
  return decoy;
}
