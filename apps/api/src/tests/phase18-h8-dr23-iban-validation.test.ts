/**
 * 🔴 Phase 18 H-8 — DR-23 (D-6), its first part: "Now: IBAN validation, a
 * recorded change, and a deterministic 'payment soon after a bank-detail
 * change' finding." DECIDED 2026-10-27 — owner accepted the stated
 * recommendation (register §11.55, the scoped D-4 statement, appended before
 * this file). This change: the validation, and the proof that a change is
 * recorded.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3258";
process.env.SESSION_SECRET ??= "phase18-h8-dr23-iban-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H8Dr23Pw1!";
const VALID = "SA0380000000608010167519";
const VALID_B = "SA4420000001234567891234";

describeMaybe("Phase 18 H-8 — DR-23: an IBAN is validated, and a change of it is recorded", () => {
  const h = g04Harness("p18h8dr23");
  let orgId = "";

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,'H8 Co',1,'gregorian','399999999999993','1010303031','SAUDI_GCC')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a company bank account with a wrong IBAN is refused by name — a wrong check digit, and a Saudi IBAN of the wrong length", async () => {
    const bad = await h.api("admin", "POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR", iban: "SA0480000000608010167519" });
    expect([bad.status, bad.body.code, bad.body.field], JSON.stringify(bad.body)).toEqual([422, "iban_invalid", "iban"]);
    const short = await h.api("admin", "POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR", iban: "SA038000000060801016751" });
    expect([short.status, short.body.code]).toEqual([422, "iban_invalid"]);
    // 23 characters whose mod-97 check PASSES — only the Saudi length rule can refuse it
    const lengthOnly = await h.api("admin", "POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR", iban: "SA538000000060801016751" });
    expect([lengthOnly.status, lengthOnly.body.code], JSON.stringify(lengthOnly.body)).toEqual([422, "iban_invalid"]);
    expect(lengthOnly.body.error).toMatch(/24 characters/);
  });

  it("🔴 a valid IBAN is stored normalised — upper case, no spaces — and an empty one stays allowed", async () => {
    const r = await h.api("admin", "POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR", iban: "sa03 8000 0000 6080 1016 7519" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await pool.query(`SELECT iban FROM bank_accounts WHERE id = $1`, [r.body.id])).rows[0].iban).toBe(VALID);
    const none = await h.api("admin", "POST", "/bank-accounts", { name: "Petty", bankName: "SNB", currency: "SAR" });
    expect(none.status, JSON.stringify(none.body)).toBe(201);
  });

  it("🔴 a supplier's IBAN is validated too — on create and on update", async () => {
    const bad = await h.api("admin", "POST", "/vendors", { name: "H8 Supplier", residency: "resident", iban: "SA0380000000608010167518" });
    expect([bad.status, bad.body.code], JSON.stringify(bad.body)).toEqual([422, "iban_invalid"]);
    const v = await h.api("admin", "POST", "/vendors", { name: "H8 Supplier", residency: "resident", iban: VALID });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const badUpdate = await h.api("admin", "PATCH", `/vendors/${v.body.id}`, { iban: "GB00XXXX" });
    expect([badUpdate.status, badUpdate.body.code]).toEqual([422, "iban_invalid"]);
    expect((await pool.query(`SELECT iban FROM vendors WHERE id = $1`, [v.body.id])).rows[0].iban, "unchanged").toBe(VALID);
  });

  it("🔴 a change of a supplier's IBAN is RECORDED — the old and new IBAN, who and when", async () => {
    const v = await h.api("admin", "POST", "/vendors", { name: "H8 Supplier 2", residency: "resident", iban: VALID });
    expect(v.status).toBe(201);
    const u = await h.api("admin", "PATCH", `/vendors/${v.body.id}`, { iban: VALID_B });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const rec = (await pool.query(
      `SELECT user_id, created_at, before_state->>'iban' AS before, after_state->>'iban' AS after FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'vendor' AND entity_id = $2 AND action = 'update' ORDER BY id DESC LIMIT 1`, [orgId, String(v.body.id)])).rows[0];
    expect(rec).toMatchObject({ before: VALID, after: VALID_B });
    expect(rec.user_id).not.toBeNull();
  });
});
