/**
 * 🔴 Phase 19A (19.1) — when the key that seals second-factor secrets is NOT AVAILABLE, setting a factor up is refused
 * by name, in both languages, and nothing is stored. Found by CI's browser job (2026-11-20): its environment had no
 * development master key, and enrolment answered a bare 500. A person is owed a sentence; and a secret that cannot be
 * sealed must never be stored some other way.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder. This file runs WITHOUT the development master key.
 */
process.env.PORT ??= "3224";
process.env.SESSION_SECRET ??= "phase19a-mfa-key-unavailable-test-secret";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";
delete process.env.ZATCA_DEV_MASTER_KEY;

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "P19aKeyGonePw123!";

describeMaybe("Phase 19A — a second factor cannot be set up while its key is unavailable", () => {
  const h = g04Harness("p19k");
  let userId = 0;

  beforeAll(async () => {
    await h.cleanup();
    const org = await h.mkOrg("a");
    await h.mkCompany(org, "P19K A", "318181818181887");
    userId = await h.mkUser("book", PW, org, "bookkeeper");
    await h.start();
    expect(await h.login("book", h.email("book"), PW)).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 enrolment is refused by name (503), in Arabic too, and no factor row is written", async () => {
    expect(process.env.ZATCA_DEV_MASTER_KEY, "anti-vacuity: this file runs without the key").toBeUndefined();
    const res = await h.api("book", "POST", "/auth/mfa/enrol");
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body).toMatchObject({ code: "mfa_key_unavailable", errorAr: expect.stringContaining("التحقق بخطوتين") });
    expect(JSON.stringify(res.body), "the reason names no configuration variable").not.toMatch(/ZATCA|MASTER_KEY|KMS/);
    expect((await pool.query(`SELECT count(*)::int n FROM user_mfa_factors WHERE user_id = $1`, [userId])).rows[0].n).toBe(0);
    // the rest of the account still works
    expect((await h.api("book", "GET", "/auth/mfa")).status).toBe(200);
  });
});
