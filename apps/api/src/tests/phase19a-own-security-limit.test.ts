/**
 * 🔴 Phase 19A — a person's reads and acts on their OWN security state are counted per ACCOUNT, not per address.
 * Found by the 390 px walk (2026-11-20): GET /auth/mfa answered 429 because other accounts behind the same address had
 * spent the per-IP user-admin budget (60 in 15 minutes). People share addresses — an office, a mobile carrier — so a
 * colleague's activity must never refuse your own security page.
 *
 *   - another account spends the whole user-admin budget from this address: your own sessions and two-step status
 *     still answer (and the admin act on others' accounts IS refused — anti-vacuity: the budget really was spent);
 *   - your own limit exists: past it you are refused, and another account at the same address is not (movement).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3225";
process.env.SESSION_SECRET ??= "phase19a-own-security-limit-test-secret1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "P19aOwnLimitPw123!";

describeMaybe("Phase 19A — own security state is limited per account, never per address", () => {
  const h = g04Harness("p19o");
  const resetLimits = async () => { await (await import("../routes/auth")).__resetRateLimitsForTests(); };

  beforeAll(async () => {
    await h.cleanup();
    const org = await h.mkOrg("a");
    await h.mkCompany(org, "P19O A", "318181818181897");
    await h.mkUser("admin", PW, org, "admin");
    await h.mkUser("book", PW, org, "bookkeeper");
    await h.mkUser("other", PW, org, "bookkeeper");
    await h.start();
    await resetLimits();
    for (const who of ["admin", "book", "other"]) expect(await h.login(who, h.email(who), PW)).toBe(200);
  }, 120_000);
  afterAll(async () => { await resetLimits(); await h.stop(); await h.cleanup(); });

  it("🔴 another account spending the address's user-admin budget does not refuse your own security reads", async () => {
    let last = 0;
    for (let i = 0; i < 61 && last !== 429; i++) last = (await h.api("admin", "GET", "/auth/users")).status;
    expect(last, "anti-vacuity: the address's user-admin budget is spent").toBe(429);
    expect((await h.api("book", "GET", "/auth/mfa")).status, "your own two-step status").toBe(200);
    expect((await h.api("book", "GET", "/auth/sessions")).status, "your own sessions").toBe(200);
    expect((await h.api("admin", "GET", "/auth/mfa")).status, "even the account that spent it: its OWN state is not that budget").toBe(200);
  });

  it("🔴 your own limit exists, per account: past it you are refused, and another account at the same address is not", async () => {
    let last = 0;
    for (let i = 0; i < 121 && last !== 429; i++) last = (await h.api("book", "GET", "/auth/sessions")).status;
    expect(last).toBe(429);
    expect((await h.api("book", "GET", "/auth/mfa")).status, "the same account's other own reads share its budget").toBe(429);
    expect((await h.api("other", "GET", "/auth/sessions")).status, "movement: another account at the same address").toBe(200);
  });
});
