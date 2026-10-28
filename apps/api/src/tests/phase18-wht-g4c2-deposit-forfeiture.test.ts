/**
 * 🔴 Phase 18 G4c-2 — WHT: owner decision 14, deposits (register §11.30;
 * final-run memo §2 G; scoped D-4 statement register §11.46, appended before
 * this file). DECIDED 2026-10-27: an owner decision based on research, not a
 * professional opinion; reversible; to be reviewed before go-live.
 *
 *  - a genuine refundable security deposit triggers WHT when SET OFF, in the
 *    set-off month: a set-off (the deposit reclassified to an advance, on its
 *    own effective date) is judged at the SET-OFF date, on the amount set off,
 *    and stays refused by name while who funds the tax is open (W-16);
 *  - a FORFEITURE needs the user's classification: a record with its own date
 *    (the cash, set-off and forfeiture dates are separate fields), and — for a
 *    non-resident's forfeiture that is consideration — the WHT due in the
 *    forfeiture month, shown, never withheld or posted (W-16). Records only:
 *    the forfeiture's posting is open (W-20).
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3252";
process.env.SESSION_SECRET ??= "phase18-wht-g4c2-deposit-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18WhtG4c2Pw1!";
const PAID = "2026-09-10";
const LATER = "2026-10-15";

describeMaybe("Phase 18 G4c-2 — deposits: the set-off month, and the forfeiture record (decision 14)", () => {
  const h = g04Harness("p18whtg4c2");
  let orgId = "", bankId = 0, nonResident = 0, resident = 0;

  const deposit = async (vendorId: number, amount: number) => {
    const r = await h.api("admin", "POST", "/supplier-payments", { vendorId, bankAccountId: bankId, amount, paidAt: PAID, classification: "security_deposit" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const forfeit = (id: number, body: Record<string, unknown>) => h.api("admin", "POST", `/supplier-payments/${id}/forfeitures`, {
    forfeitedOn: LATER, amount: 4_000, classification: "not_consideration", reason: "The supplier keeps it under clause 9: the lease ended early", ...body,
  });
  const counts = async () => (await pool.query(
    `SELECT (SELECT count(*)::int FROM journal_entries WHERE organization_id = $1) AS je,
            (SELECT count(*)::int FROM wht_withholdings WHERE organization_id = $1) AS w`, [orgId])).rows[0];

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,'G4c2 Co',1,'gregorian','399999999999993','1010303031','SAUDI_GCC')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    bankId = (await h.api("admin", "POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR" })).body.id;
    const nr = await h.api("admin", "POST", "/vendors", { name: "G4c2 London Lessor", residency: "non_resident", whtDefaultPaymentType: "technical_consulting", country: "GB" });
    const rs = await h.api("admin", "POST", "/vendors", { name: "G4c2 Riyadh Lessor", residency: "resident" });
    expect([nr.status, rs.status]).toEqual([201, 201]);
    nonResident = nr.body.id; resident = rs.body.id;
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 14: a forfeiture is recorded only with the user's classification and a reason, on its OWN date — and nothing posts", async () => {
    const id = await deposit(nonResident, 10_000);
    const before = await counts();
    const none = await forfeit(id, { classification: undefined });
    expect([none.status, none.body.code]).toEqual([422, "deposit_forfeiture_classification_required"]);
    const early = await forfeit(id, { forfeitedOn: "2026-09-01" });
    expect([early.status, early.body.code]).toEqual([422, "date_before_payment"]);
    const tooMuch = await forfeit(id, { amount: 20_000 });
    expect([tooMuch.status, tooMuch.body.code]).toEqual([409, "forfeiture_exceeds_available"]);
    const ok = await forfeit(id, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ supplierPaymentId: id, forfeitedOn: LATER, amount: 4_000, classification: "not_consideration", whtDue: null });
    expect(await counts(), "a record only: no entry, no withholding").toEqual(before);
    const list = await h.api("admin", "GET", `/supplier-payments/${id}/forfeitures`);
    expect((list.body as { id: number }[]).map((f) => f.id)).toEqual([ok.body.id]);
  });

  it("🔴 14: a non-resident's forfeiture that is CONSIDERATION shows the WHT due in the forfeiture month — not withheld, not posted (W-16); a resident's shows none", async () => {
    const id = await deposit(nonResident, 5_000);
    const before = await counts();
    const r = await forfeit(id, { amount: 5_000, classification: "consideration", paymentType: "technical_consulting", reason: "Kept as the fee for the advisory work delivered" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.whtDue).toEqual({ month: "2026-10", rate: 0.05, amount: 250 });
    expect(await counts(), "nothing withheld, nothing posted").toEqual(before);
    const rid = await deposit(resident, 2_000);
    const rr = await forfeit(rid, { amount: 2_000, classification: "consideration", reason: "Kept as the fee for the work" });
    expect(rr.status, JSON.stringify(rr.body)).toBe(201);
    expect(rr.body.whtDue).toBeNull();
  });

  it("🔴 14: the record is not contradicted — a refund cannot return the forfeited part and the deposit is not reclassified once forfeited; the remainder refunds (control)", async () => {
    const id = await deposit(resident, 10_000);
    expect((await forfeit(id, {})).status).toBe(201); // 4,000 of 10,000
    const over = await h.api("admin", "POST", `/supplier-payments/${id}/refund`, { amount: 7_000, bankAccountId: bankId, refundedAt: LATER, reason: "deposit returned" });
    expect([over.status, over.body.code]).toEqual([409, "refund_exceeds_available"]);
    const re = await h.api("admin", "POST", `/supplier-payments/${id}/classify`, { classification: "advance", effectiveDate: LATER });
    expect([re.status, re.body.code]).toEqual([409, "deposit_forfeited_cannot_reclassify"]);
    const ok = await h.api("admin", "POST", `/supplier-payments/${id}/refund`, { amount: 6_000, bankAccountId: bankId, refundedAt: LATER, reason: "deposit returned" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("🔴 14: a non-resident's deposit SET OFF is judged at the SET-OFF date on the amount set off — the refusal names the set-off month (W-16 stays open)", async () => {
    const id = await deposit(nonResident, 8_000);
    expect((await h.api("admin", "POST", `/supplier-payments/${id}/refund`, { amount: 2_000, bankAccountId: bankId, refundedAt: PAID, reason: "part returned" })).status).toBe(200);
    const before = await counts();
    const r = await h.api("admin", "POST", `/supplier-payments/${id}/classify`, { classification: "advance", effectiveDate: LATER, whtPaymentType: "technical_consulting" });
    expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([409, "wht_late_withholding_open"]);
    // the 6,000 still held, set off in October: 5 % of it, due in 2026-10 — not the 8,000 paid in September
    expect(r.body.error).toMatch(/300\.00/);
    expect(r.body.error).toMatch(/2026-10/);
    expect(r.body.error).not.toMatch(/400\.00/);
    expect(await counts()).toEqual(before);
  });

  it("🔴 14: the set-off DATE decides the rate — a deposit paid before the current schedule (12-09-2023) and set off under it is judged by the rate in force at the set-off", async () => {
    const r0 = await h.api("admin", "POST", "/supplier-payments", { vendorId: nonResident, bankAccountId: bankId, amount: 1_000, paidAt: "2023-09-01", classification: "security_deposit" });
    expect(r0.status, JSON.stringify(r0.body)).toBe(201);
    // judged at the cash date this would be 422 wht_rate_not_loaded (no rate before 12-09-2023); at the set-off date, 5 %
    const r = await h.api("admin", "POST", `/supplier-payments/${r0.body.id}/classify`, { classification: "advance", effectiveDate: LATER, whtPaymentType: "technical_consulting" });
    expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([409, "wht_late_withholding_open"]);
    expect(r.body.error).toMatch(/50\.00 falls due in 2026-10/);
  });

  it("control: a resident's deposit set off on its own date posts the move on THAT date, not the cash date", async () => {
    const id = await deposit(resident, 3_000);
    const r = await h.api("admin", "POST", `/supplier-payments/${id}/classify`, { classification: "advance", effectiveDate: LATER });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const moved = (await pool.query(
      `SELECT e.date::text AS date FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = 'SECURITY_DEPOSITS_PAID' AND l.credit_amount = 3000`, [orgId])).rows;
    expect(moved.map((m) => m.date)).toEqual([LATER]);
  });
});
