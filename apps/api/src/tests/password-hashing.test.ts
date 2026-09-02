/**
 * M-4 — PASSWORD HASHING OFF THE EVENT LOOP, AND BOUNDED BEFORE IT RUNS.
 *
 * ── 🔴 WHAT THE MEASUREMENT ACTUALLY SHOWED (2026-09-02) ───────────────────
 * The queue said "bcryptjs blocks the event loop on public endpoints". The
 * measurement corrected the mechanism, and the correction is the reason the
 * fix is what it is. Event-loop lag is what every OTHER request in the
 * process waits, measured with a 5ms interval:
 *
 *   bcryptjs async compare                753ms wall,     98ms lag
 *   🔴 TEN concurrent bcryptjs compares  10598ms wall,   2068ms lag
 *   crypto.scrypt (N=2^17)                549ms wall,     14ms lag
 *   🔴 TEN concurrent crypto.scrypt       2145ms wall,     23ms lag
 *
 * bcryptjs's async API does yield, so ONE login costs ~98ms of lag rather than
 * 750ms. The damage is CONCURRENCY — ten simultaneous logins (a busy morning,
 * not an attack) stall the loop for two seconds and every tenant's unrelated
 * request waits behind them.
 *
 * ── WHAT THESE TESTS ASSERT ───────────────────────────────────────────────
 * Behaviour, not timing: timing assertions are flaky on a shared runner, and
 * the measurement above is recorded rather than re-run here. What must hold
 * every time is the CONTRACT: legacy hashes still verify, new hashes are
 * scrypt, a correct password is upgraded, and no KDF runs on input that was
 * going to be rejected anyway.
 */
import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import {
  assertFitsColumn,
  assertPasswordAcceptable,
  decoyHash,
  hashPassword,
  isLegacyHash,
  MAX_PASSWORD,
  MAX_VARCHAR,
  MIN_PASSWORD,
  needsRehash,
  verifyPassword,
} from "../lib/password";

const PASSWORD = "correct horse battery staple";

describe("M-4 — password hashing", () => {
  it("hashes with scrypt, and the hash carries its own parameters", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith("scrypt$")).toBe(true);
    const [scheme, n, r, p, salt, key] = hash.split("$");
    expect(scheme).toBe("scrypt");
    expect(Number(n)).toBeGreaterThanOrEqual(1 << 17); // OWASP's floor
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(Buffer.from(salt, "base64")).toHaveLength(16);
    expect(Buffer.from(key, "base64")).toHaveLength(64);
    // Fits the column with room to spare (it is `text`, but this would fit varchar(255) too).
    expect(hash.length).toBeLessThan(MAX_VARCHAR);
  });

  it("a salt is per-hash: the same password twice gives different hashes, both valid", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
  });

  it("verifies the right password and refuses the wrong one", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(PASSWORD + "!", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("🔴 LEGACY bcrypt hashes still verify — nobody is locked out by the migration", async () => {
    const legacy = await bcrypt.hash(PASSWORD, 12);
    expect(isLegacyHash(legacy)).toBe(true);
    expect(await verifyPassword(PASSWORD, legacy)).toBe(true);
    expect(await verifyPassword("wrong", legacy)).toBe(false);
    // …and they are flagged for upgrade on the next successful login.
    expect(needsRehash(legacy)).toBe(true);
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false);
  });

  it("🔴 answers FALSE, never throws, on a malformed or unknown stored hash", async () => {
    // A login path that throws on bad stored data tells an attacker the row exists.
    //
    // 🔴 The fifth case FOUND A BYPASS in the first version of this seam:
    // `Buffer.from("@@@", "base64")` is EMPTY (base64 decoding drops invalid
    // characters rather than failing), so a zero-length expected key made
    // `timingSafeEqual(empty, empty)` answer TRUE for any password. The shapes
    // are now checked before the comparison. Keep every one of these.
    for (const bad of [
      "",
      "scrypt$",
      "scrypt$x$y$z$q$r",
      "not-a-hash",
      "scrypt$131072$8$1$@@@$@@@",
      "scrypt$131072$8$1$$",
      `scrypt$131072$8$1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(8).toString("base64")}`,
    ]) {
      await expect(verifyPassword(PASSWORD, bad)).resolves.toBe(false);
      await expect(verifyPassword("", bad)).resolves.toBe(false);
    }
  });

  it("🔴 bounds the password BEFORE any KDF runs — an over-long body is a 400, not work", async () => {
    expect(() => assertPasswordAcceptable("short")).toThrowError(/at least 8/);
    expect(() => assertPasswordAcceptable(undefined)).toThrowError(/at least 8/);
    expect(() => assertPasswordAcceptable("x".repeat(MAX_PASSWORD + 1))).toThrowError(/at most/);
    expect(assertPasswordAcceptable("x".repeat(MAX_PASSWORD))).toHaveLength(MAX_PASSWORD);
    // hashPassword refuses the same input rather than hashing it.
    await expect(hashPassword("x".repeat(MAX_PASSWORD + 1))).rejects.toThrowError(/at most/);
    await expect(hashPassword("short")).rejects.toThrowError(/at least/);
  });

  it("🔴 scrypt does NOT truncate — bcrypt's 72-byte cut is the reason to bound length", async () => {
    // The measured fact behind M-4's second half: bcrypt reads 72 bytes and
    // silently ignores the rest, so two different long passwords with the same
    // prefix are the same password.
    const legacy = await bcrypt.hash("y".repeat(72), 12);
    expect(await bcrypt.compare("y".repeat(200), legacy)).toBe(true);

    // scrypt reads all of it, so the same pair are different passwords.
    const modern = await hashPassword("y".repeat(72));
    expect(await verifyPassword("y".repeat(200), modern)).toBe(false);
    expect(await verifyPassword("y".repeat(72), modern)).toBe(true);
  });

  it("rejects a value that would overflow varchar(255) — a 400, not a database 500", () => {
    expect(assertFitsColumn("Acme Trading", "organizationName")).toBe("Acme Trading");
    expect(() => assertFitsColumn("x".repeat(MAX_VARCHAR + 1), "organizationName")).toThrowError(
      /organizationName must be at most 255/,
    );
  });

  it("the login decoy is a real verifiable hash, and stable across calls", async () => {
    const a = await decoyHash();
    const b = await decoyHash();
    expect(a).toBe(b); // built once, not per request
    expect(a.startsWith("scrypt$")).toBe(true);
    // It must not match anything a user could send.
    expect(await verifyPassword(PASSWORD, a)).toBe(false);
  });

  it("MIN_PASSWORD is unchanged by this migration — the policy moved, it did not loosen", () => {
    expect(MIN_PASSWORD).toBe(8);
  });
});
