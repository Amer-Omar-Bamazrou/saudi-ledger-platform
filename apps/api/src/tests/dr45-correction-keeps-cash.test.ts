/**
 * 🔴 DR-45 (I) — REGRESSION: a WHT correction never rewrites recorded cash implicitly.
 *
 * A correction's re-entry goes through the ordinary pay path, whose cash is
 * DERIVED (amount − tax). Before safeguard (I), a rate or category correction
 * re-entered at the same amount recorded different cash for a payment whose
 * cash was right (register DR-45; the Batch 4B proof
 * `phase18-s1b-dr45-wht-correction-cash.test.ts` lands unchanged beside this
 * file). Now the re-entry must move exactly the original's cash — the same
 * bank, amount and date — unless the person states that the recorded cash was
 * wrong and gives the cash that actually left, which the re-entry must then
 * move exactly. Anything else is refused and NOTHING is written.
 *
 * Covered here (the proof covers the rate correction and the pending/deposit
 * conversion): a stated cash the re-entry does not move; the two malformed
 * statements; a change of bank or of date without the statement; the
 * supplier-payment version (register DR-45 test 6); and a correction that
 * keeps the cash, whose re-entry then carries a single cash line equal to the
 * cash that left (the statement line still matches it — test 5's premise).
 *
 * Treatment III (the account for under-withheld tax, the gross-up base, the
 * correction's month) is NOT chosen here; it waits on the accountant.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3203";
process.env.SESSION_SECRET ??= "dr45-correction-keeps-cash-regression-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "DR45RegressionPw123!";

describeMaybe("DR-45 (I) — a WHT correction never rewrites recorded cash implicitly", () => {
  const h = g04Harness("dr45reg");
  let orgId = "";
  let vendorId = 0;
  let seq = 0;

  async function bank(name: string): Promise<number> {
    const b = await h.api("admin", "POST", "/bank-accounts", { name, bankName: "Riyad", currency: "SAR" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    return b.body.id as number;
  }
  const bankGl = async (bankId: number) => Number((await pool.query(
    `SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text AS v
       FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id
      WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bankId],
  )).rows[0].v);
  const whtPayable = async () => Number((await pool.query(
    `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text AS v FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND c.system_code = 'WHT_PAYABLE' AND e.status IN ('posted','reversed')`, [orgId],
  )).rows[0].v);
  const counts = async () => (await pool.query(
    `SELECT (SELECT count(*)::int FROM journal_entries WHERE organization_id = $1) AS je,
            (SELECT count(*)::int FROM wht_corrections WHERE organization_id = $1) AS corr,
            (SELECT count(*)::int FROM wht_withholdings WHERE organization_id = $1) AS w,
            (SELECT count(*)::int FROM bill_payments WHERE organization_id = $1) AS bp,
            (SELECT count(*)::int FROM supplier_payments WHERE organization_id = $1) AS sp`, [orgId],
  )).rows[0];

  /** A bill of `net` (no VAT), approved, paid in full on 2026-06-10 at the supplier's default nature (consulting, 5 %). */
  async function paidBill(net: number, bankId: number) {
    seq += 1;
    const no = `DR45REG-B${seq}`;
    const created = await h.api("bookkeeper", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: `${no}-SUP`, billNumber: no, date: "2026-06-01", dueDate: "2026-06-30", vendorId,
      items: [{ description: "Technical services", quantity: 1, unitPrice: net, vatRate: 0 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await h.api("admin", "POST", `/bills/${created.body.id}/approve`, {})).status).toBe(200);
    const paid = await h.api("admin", "POST", `/bills/${created.body.id}/pay`, { amount: net, paidAt: "2026-06-10", bankAccountId: bankId });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const w = (await pool.query(`SELECT id FROM wht_withholdings WHERE bill_id = $1 AND correction_id IS NULL`, [created.body.id])).rows[0];
    return { billId: created.body.id as number, withholdingId: w.id as number };
  }
  const correct = (withholdingId: number, body: Record<string, unknown>) => h.api("admin", "POST", `/tax/wht/withholdings/${withholdingId}/reverse`, body);

  /** A refusal that wrote nothing, and moved neither the bank nor WHT payable. */
  async function expectRefusedUnmoved(go: () => Promise<{ status: number; body: any }>, status: number, code: string, bankId: number, cash: number) {
    const before = await counts();
    const wht0 = await whtPayable();
    const r = await go();
    expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([status, code]);
    expect(await counts(), "refused: nothing written").toEqual(before);
    expect(await bankGl(bankId), "the bank still shows the cash that left").toBe(cash);
    expect(await whtPayable(), "WHT payable unmoved").toBe(wht0);
    return r;
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "DR45 Regression Co", "318181818181885");
    vendorId = (await pool.query(
      `INSERT INTO vendors (organization_id, name, residency, wht_default_payment_type, country, foreign_tax_id)
       VALUES ($1,'DR45 London Tech','non_resident','technical_consulting','GB','GB-DR45-1') RETURNING id`, [orgId],
    )).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("a STATED cash the re-entry does not move is refused (cash mismatch) — nothing written; the matching statement completes", async () => {
    const b = await bank("DR45 stated");
    const { withholdingId } = await paidBill(10_000, b);
    expect(await bankGl(b)).toBe(-9_500);
    const body = (actualCash: number) => ({ reason: "a royalty, and the recorded cash was wrong", date: "2026-06-20", reentry: { amount: 10_000, paidAt: "2026-06-10", whtPaymentType: "royalty", recordedCashWasWrong: true, actualCash } });
    await expectRefusedUnmoved(() => correct(withholdingId, body(9_000)), 409, "wht_correction_cash_mismatch", b, -9_500);
    const ok = await correct(withholdingId, body(8_500));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await bankGl(b), "the stated cash is what the bank now shows").toBe(-8_500);
  }, 60_000);

  it("a malformed statement is refused before anything is written: the statement without the cash, or the cash without the statement", async () => {
    const b = await bank("DR45 malformed");
    const { withholdingId } = await paidBill(4_000, b);
    const base = { reason: "a royalty, not a consulting fee", date: "2026-06-20" };
    await expectRefusedUnmoved(() => correct(withholdingId, { ...base, reentry: { amount: 4_000, paidAt: "2026-06-10", whtPaymentType: "royalty", recordedCashWasWrong: true } }), 422, "wht_actual_cash_required", b, -3_800);
    await expectRefusedUnmoved(() => correct(withholdingId, { ...base, reentry: { amount: 4_000, paidAt: "2026-06-10", whtPaymentType: "royalty", actualCash: 3_400 } }), 422, "wht_actual_cash_without_statement", b, -3_800);
  }, 60_000);

  it("a change of BANK or of DATE without the statement is refused: a cash movement is its bank, amount and date", async () => {
    const b = await bank("DR45 moved");
    const other = await bank("DR45 other bank");
    const { withholdingId } = await paidBill(2_000, b);
    const base = { reason: "re-entered with the same nature", date: "2026-06-20" };
    await expectRefusedUnmoved(() => correct(withholdingId, { ...base, reentry: { amount: 2_000, paidAt: "2026-06-10", bankAccountId: other } }), 409, "wht_correction_changes_cash", b, -1_900);
    expect(await bankGl(other)).toBe(0);
    await expectRefusedUnmoved(() => correct(withholdingId, { ...base, reentry: { amount: 2_000, paidAt: "2026-06-11" } }), 409, "wht_correction_changes_cash", b, -1_900);
  }, 60_000);

  it("CONTROL: a correction that keeps the cash completes — its re-entry carries ONE cash line equal to the cash that left", async () => {
    const b = await bank("DR45 kept");
    const { withholdingId } = await paidBill(3_000, b);
    // consulting → goods, re-entered at the 2,850 the supplier actually received: same bank, amount and date
    const r = await correct(withholdingId, { reason: "these were spare parts, which are goods", date: "2026-06-20", reentry: { amount: 2_850, paidAt: "2026-06-10", whtNotSubjectReason: "goods" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await bankGl(b), "non-zero, unchanged").toBe(-2_850);
    const cash = (await pool.query(
      `SELECT v.credit_amount::text AS c FROM journal_line_bank_identity v JOIN bill_payments p ON p.journal_entry_id = v.journal_entry_id
        WHERE p.id = (SELECT corrected_bill_payment_id FROM wht_corrections WHERE withholding_id = $1) AND v.bank_account_id = $2`, [withholdingId, b],
    )).rows.map((x) => Number(x.c));
    expect(cash, "the re-entry's cash line equals the statement line it reconciles to").toEqual([2_850]);
  }, 60_000);

  it("🔴 SUPPLIER PAYMENT (register DR-45 test 6): a rate correction of a withheld advance is refused without the statement — nothing written, the bank still shows the cash that left", async () => {
    const b = await bank("DR45 supplier payment");
    const sp = await h.api("admin", "POST", "/supplier-payments", { vendorId, bankAccountId: b, amount: 8_000, paidAt: "2026-06-12", classification: "advance" });
    expect(sp.status, JSON.stringify(sp.body)).toBe(201);
    expect(await bankGl(b)).toBe(-7_600); // consulting 5 %: 400 withheld
    const w = (await pool.query(`SELECT id FROM wht_withholdings WHERE supplier_payment_id = $1`, [sp.body.id])).rows[0];
    await expectRefusedUnmoved(
      () => correct(w.id, { reason: "the advance was for a licence (royalty)", date: "2026-06-20", reentry: { amount: 8_000, paidAt: "2026-06-12", classification: "advance", whtPaymentType: "royalty" } }),
      409, "wht_correction_changes_cash", b, -7_600,
    );
  }, 60_000);
});
