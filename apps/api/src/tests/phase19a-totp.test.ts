/**
 * 🔴 Phase 19A (19.1/19.2) — the TOTP primitive against a source OUTSIDE this codebase: RFC 6238 Appendix B's SHA-1
 * test vectors (secret "12345678901234567890", 30-second step), truncated to the 6 digits the product uses, and RFC
 * 4648's base32 vectors. A test that only compared the product's generator with the product's verifier would prove
 * they agree, not that either is TOTP. No database.
 */
import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, matchTotp, otpauthUri, totpAt } from "../lib/totp";

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
// RFC 6238 Appendix B (SHA-1 rows): time (s) → 8-digit TOTP; the product's 6 digits are the last six.
const VECTORS: [number, string][] = [
  [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
];

describe("Phase 19A — TOTP (RFC 6238) and base32 (RFC 4648)", () => {
  it("🔴 the six digits at each RFC 6238 test time are the RFC's", () => {
    for (const [seconds, eight] of VECTORS) expect(totpAt(RFC_SECRET, Math.floor(seconds / 30)), `t=${seconds}`).toBe(eight.slice(2));
  });

  it("base32 encodes and decodes RFC 4648's vectors, and decoding ignores case, spaces and padding", () => {
    for (const [plain, encoded] of [["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]] as const) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded).toString()).toBe(plain);
    }
    expect(base32Decode("mzxw 6ytb oi==").toString()).toBe("foobar");
  });

  it("🔴 a code matches only at its own step or one step either side, and reports WHICH step (the replay guard's input)", () => {
    const step = 55_555_555;
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step), step)).toBe(step);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), step)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), step)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), step), "two steps old").toBeNull();
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 2), step), "two steps ahead").toBeNull();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 345", null, undefined, 123456]) expect(matchTotp(RFC_SECRET, bad as any, step), String(bad)).toBeNull();
  });

  it("the otpauth URI names the issuer and the account, and carries the secret in base32", () => {
    const uri = otpauthUri({ issuer: "KSA Ledger", account: "a.b+c@example.com", secret: RFC_SECRET });
    expect(uri).toBe(`otpauth://totp/KSA%20Ledger:a.b%2Bc%40example.com?secret=${base32Encode(RFC_SECRET)}&issuer=KSA%20Ledger&algorithm=SHA1&digits=6&period=30`);
  });
});
