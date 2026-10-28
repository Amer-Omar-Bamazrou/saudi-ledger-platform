/**
 * 🔴 Phase 18 G4a — WHT: owner decision 16, and decision 17's "never reverse
 * WHT in a later month" (register §11.30; final-run memo §2 G; scoped D-4
 * statement register §11.42). DECIDED 2026-10-27: an owner decision based on
 * research, not a professional opinion; reversible; to be reviewed before
 * go-live. It answers DR-40's open question (T6/V-8) and supersedes its
 * "no change" recommendation.
 *
 *  - A filed WHT month is ALWAYS corrected in that month's own statement (an
 *    amendment): never carried in a later month's return, never offset against
 *    a later month. The `subsequent_period` route is refused on every path —
 *    the pay paths, the correction, and the database itself for a new row.
 *  - A correction pack lists, for the filed month, what was filed, what the
 *    ledger now holds, the difference, and every change since the filing.
 *  - #237's wording stays: no claim of a ZATCA self-service amendment.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3249";
process.env.SESSION_SECRET ??= "phase18-wht-g4a-original-month-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";
import { addDays } from "../services/tax/taxComputations.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18WhtG4aPw1!";

describeMaybe("Phase 18 G4a — a filed WHT month is corrected in that month (decisions 16, 17)", () => {
  const h = g04Harness("p18whtg4a");
  const today = businessToday();
  const lastMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  let orgId = "", bankId = 0, vendorId = 0, firstWithholding = 0, seq = 0;

  const payBill = async (amount: number, paidAt: string, extra: Record<string, unknown> = {}) => {
    seq += 1;
    const bill = await h.api("admin", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: `G4A-R-${seq}`, billNumber: `G4A-${seq}`, date: paidAt, dueDate: paidAt, vendorId,
      items: [{ description: "Consulting", quantity: 1, unitPrice: amount, vatRate: 0 }] });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    expect((await h.api("admin", "POST", `/bills/${bill.body.id}/approve`, {})).status).toBe(200);
    const paid = await h.api("admin", "POST", `/bills/${bill.body.id}/pay`, { amount, paidAt, bankAccountId: bankId, ...extra });
    return { paid, billId: bill.body.id as number };
  };
  const counts = async () => (await pool.query(
    `SELECT (SELECT count(*)::int FROM wht_withholdings WHERE organization_id = $1) AS w, (SELECT count(*)::int FROM wht_corrections WHERE organization_id = $1) AS c`, [orgId])).rows[0];

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,'G4a Co',1,'gregorian','399999999999993','1010303031','SAUDI_GCC')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    bankId = (await h.api("admin", "POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR" })).body.id;
    const v = await h.api("admin", "POST", "/vendors", { name: "G4a London Advisory", residency: "non_resident", whtDefaultPaymentType: "technical_consulting", country: "GB" });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    vendorId = v.body.id;
    const first = await payBill(2_000, `${lastMonth}-05`);
    expect(first.paid.status, JSON.stringify(first.paid.body)).toBe(200);
    firstWithholding = (await pool.query(`SELECT id FROM wht_withholdings WHERE bill_id = $1`, [first.billId])).rows[0].id;
    const filed = await h.api("admin", "POST", `/tax/wht/returns/${lastMonth}/file`, { zatcaReference: "G4A-WHT-001", filedOn: today });
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("control: a payment into the filed month stated as an AMENDMENT is reported in that month", async () => {
    const r = await payBill(1_000, `${lastMonth}-10`, { whtFiledMonthTreatment: "amendment" });
    expect(r.paid.status, JSON.stringify(r.paid.body)).toBe(200);
    const row = (await pool.query(`SELECT return_period, filed_month_treatment FROM wht_withholdings WHERE bill_id = $1`, [r.billId])).rows[0];
    expect(row).toEqual({ return_period: lastMonth, filed_month_treatment: "amendment" });
  });

  it("control: with no treatment stated, the filed month is still a 409 that names the amendment", async () => {
    const r = await payBill(500, `${lastMonth}-11`);
    expect([r.paid.status, r.paid.body.code]).toEqual([409, "wht_month_filed"]);
    expect(r.paid.body.error).toMatch(/amend/i);
  });

  it("🔴 16: a payment into the filed month is NEVER carried in a later month's return — 'subsequent period' is refused by name, and nothing is written", async () => {
    const before = await counts();
    const r = await payBill(800, `${lastMonth}-12`, { whtFiledMonthTreatment: "subsequent_period" });
    expect([r.paid.status, r.paid.body.code, (await counts()).w - before.w], JSON.stringify(r.paid.body)).toEqual([409, "wht_correct_original_month", 0]);
  });

  it("🔴 16/17: a correction of the filed month is NEVER reversed in a later month — 'subsequent period' is refused by name, and nothing is written", async () => {
    const before = await counts();
    const r = await h.api("admin", "POST", `/tax/wht/withholdings/${firstWithholding}/reverse`, { reason: "the rate on the filed month was wrong", date: today, filedMonthTreatment: "subsequent_period" });
    expect([r.status, r.body.code, (await counts()).c - before.c], JSON.stringify(r.body)).toEqual([409, "wht_correct_original_month", 0]);
  });

  it("🔴 16: the database refuses a NEW withholding carried in a later month, whatever path writes it", async () => {
    let message = "";
    try {
      await pool.query(`INSERT INTO wht_withholdings (organization_id, company_id, source_kind, vendor_id, payment_date, period, status, base_amount, rate, wht_amount, journal_entry_id, return_period, filed_month_treatment)
        SELECT organization_id, company_id, source_kind, vendor_id, payment_date, period, status, base_amount, rate, wht_amount, journal_entry_id, $2, 'subsequent_period' FROM wht_withholdings WHERE id = $1`, [firstWithholding, today.slice(0, 7)]);
    } catch (e) { message = String((e as Error).message); }
    expect(message).toMatch(/original month/i);
  });

  it("🔴 16: the CORRECTION PACK for the filed month — what was filed, what the ledger holds now, the difference, and each change since the filing; no self-service amendment is claimed", async () => {
    const r = await h.api("admin", "GET", `/tax/wht/returns/${lastMonth}/correction-pack`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ period: lastMonth, status: "amendment_due", filed: { zatcaReference: "G4A-WHT-001", taxWithheld: 100 }, current: { taxWithheld: 150 }, difference: { taxWithheld: 50 } });
    expect(r.body.changes.map((c: { kind: string; whtAmount: number }) => [c.kind, c.whtAmount])).toEqual([["late_payment", 50]]);
    expect(String(r.body.note)).not.toMatch(/self-service/i);
  });
});
