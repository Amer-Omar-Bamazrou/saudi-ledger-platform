/**
 * PHASE 18 · S1-b · DR-45 PROOF — a WHT correction's re-entry rewrites the
 * cash a past payment recorded, and turns an unclassified payment or a deposit
 * into a withheld advance. PROOF ONLY, NOT A FIX, AND NO TREATMENT CHOSEN.
 *
 * Authorised by the owner on 2026-10-16 (Batch 4B: "create the DR-45 proof
 * described in the plan"). Definition: register DR-45 (research NR-1), its
 * safeguards (I) and (II) and minimum tests 1 and 3 in their S2 form, and the
 * plan of 2026-10-16 §9. The 2026-10-09 SCRATCH reproduction (outside the
 * repository; it asserts the defective figures) is preserved separately; this
 * file asserts the INTENDED invariants instead.
 *
 * The mechanism (read at f480a569, services/tax/whtCorrection.service.ts
 * `correct`): the original payment's entry is mirrored, and the payment is
 * RE-ENTERED with the request's amount and nature through the ordinary pay
 * path, whose cash is derived (amount − tax). The W-16 refusal
 * (`wht_late_withholding_open`) sits in `classify` and in a database rule that
 * fires on SUPERSEDING rows — a correction's re-entry is a new row.
 *
 * FIX-NEUTRAL invariants (they hold for safeguard (I)/(II) refusing, and for
 * any later treatment that keeps the true cash; they choose NO account for the
 * extra tax — that is W-16 / W-2, open questions, SC-5):
 *  - after a correction that does not state the recorded cash was wrong, the
 *    payment's bank figure is still the cash that actually left;
 *  - a payment whose original withholding was `pending` (unidentified) or
 *    `not_subject` (a refundable deposit) never becomes `withheld` through a
 *    correction.
 * PREMISE / CONTROLS: the original payment records the true cash and tax; a
 * correction that changes nothing about the tax leaves the cash unchanged
 * (non-zero, measured); `classify` refuses the same conversion by name and
 * writes nothing.
 *
 * Correction DATING (scenario C, cross-month) is NOT asserted: it is DR-32 /
 * V-6, an open legal question (S6-d).
 *
 * 🔴 Expected to FAIL while DR-45 exists. Untracked S1-b file — never merged
 * red, never weakened. Does NOT call the rate-limit reset hook. DB-backed.
 */

process.env.PORT ??= "3157";
process.env.SESSION_SECRET ??= "phase18-s1b-dr45-proof-session-secret-001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "S1bDR45ProofPw123!";

describeMaybe("Phase 18 S1-b · DR-45 proof — a WHT correction keeps the cash that left, and never converts an unclassified payment or a deposit", () => {
  const h = g04Harness("s1bdr45");
  let orgId = "";
  let vendorId = 0;
  let seq = 0;

  /** A dedicated bank per scenario, so its GL figure is THAT payment's cash alone. */
  async function bank(name: string): Promise<number> {
    const b = await h.api("admin", "POST", "/bank-accounts", { name, bankName: "Riyad", currency: "SAR" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    return b.body.id as number;
  }
  /** The bank's GL movement (debit − credit), in the books. */
  const bankGl = async (bankId: number) => Number((await pool.query(
    `SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text AS v
       FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id
      WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bankId],
  )).rows[0].v);
  const counts = async () => (await pool.query(
    `SELECT (SELECT count(*)::int FROM journal_entries WHERE organization_id = $1) AS je,
            (SELECT count(*)::int FROM wht_corrections WHERE organization_id = $1) AS corr,
            (SELECT count(*)::int FROM wht_withholdings WHERE organization_id = $1) AS w`, [orgId],
  )).rows[0];

  /** A bill of `net` (no VAT: non-resident supplier), approved, paid in full on 2026-06-10 at the supplier's default nature (5 %). */
  async function paidBill(net: number, bankId: number) {
    seq += 1;
    const no = `S1BDR45-B${seq}`;
    const created = await h.api("bookkeeper", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: `${no}-SUP`, billNumber: no, date: "2026-06-01", dueDate: "2026-06-30", vendorId,
      items: [{ description: "Technical services", quantity: 1, unitPrice: net, vatRate: 0 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await h.api("admin", "POST", `/bills/${created.body.id}/approve`, {})).status).toBe(200);
    const paid = await h.api("admin", "POST", `/bills/${created.body.id}/pay`, { amount: net, paidAt: "2026-06-10", bankAccountId: bankId });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const w = (await pool.query(`SELECT id, status, payment_type, wht_amount::text FROM wht_withholdings WHERE bill_id = $1 AND correction_id IS NULL`, [created.body.id])).rows[0];
    return { billId: created.body.id as number, withholdingId: w.id as number, original: w };
  }

  const correct = (withholdingId: number, body: Record<string, unknown>) =>
    h.api("admin", "POST", `/tax/wht/withholdings/${withholdingId}/reverse`, body);
  const reentryOf = async (withholdingId: number) => (await pool.query(
    `SELECT w.status, w.payment_type, w.wht_amount::text FROM wht_corrections c JOIN wht_withholdings w ON w.correction_id = c.id
      WHERE c.withholding_id = $1`, [withholdingId],
  )).rows[0] ?? null;

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S1b DR45 Co", "318181818181823");
    vendorId = (await pool.query(
      `INSERT INTO vendors (organization_id, name, residency, wht_default_payment_type, country, foreign_tax_id)
       VALUES ($1,'S1b DR45 London Tech','non_resident','technical_consulting','GB','GB-S1B-1') RETURNING id`, [orgId],
    )).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("PREMISE + CONTROL: the original payment records the cash that left (9,500) and the tax (500); a correction that changes nothing about the tax leaves that cash at 9,500", async () => {
    const b = await bank("S1b DR45 Control");
    const p = await paidBill(10_000, b);
    const cashAfterPayment = await bankGl(b);
    const r = await correct(p.withholdingId, {
      reason: "the payment reference was recorded wrongly; nothing about the tax changes", date: "2026-06-20",
      reentry: { amount: 10_000, paidAt: "2026-06-10", whtPaymentType: "technical_consulting" },
    });
    const cashAfterCorrection = await bankGl(b);
    // eslint-disable-next-line no-console
    console.warn("[S1B DR45] CONTROL same-rate", JSON.stringify({ original: p.original, cashAfterPayment, correction: [r.status, r.body?.code ?? null], cashAfterCorrection, reentry: await reentryOf(p.withholdingId) }));
    expect(p.original.status).toBe("withheld");
    expect(Number(p.original.wht_amount)).toBe(500);
    expect(cashAfterPayment).toBe(-9_500);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(cashAfterCorrection, "the probe measures the payment's cash, non-zero, unchanged").toBe(-9_500);
  });

  it("🔴 PROOF A (safeguard I): a RATE correction on a correctly recorded payment — the bank still shows the 9,500 that left (or the correction is refused, writing nothing)", async () => {
    const b = await bank("S1b DR45 A");
    const p = await paidBill(10_000, b);
    const before = await counts();
    const r = await correct(p.withholdingId, {
      reason: "the nature was a royalty; we withheld 5 % instead of 15 %", date: "2026-06-20",
      reentry: { amount: 10_000, paidAt: "2026-06-10", whtPaymentType: "royalty" },
    });
    const cash = await bankGl(b);
    const after = await counts();
    // eslint-disable-next-line no-console
    console.warn("[S1B DR45] A rate correction", JSON.stringify({ correction: [r.status, r.body?.code ?? null], bankCashAfter: cash, cashThatLeft: -9_500, reentry: await reentryOf(p.withholdingId), countsBefore: before, countsAfter: after }));
    if (r.status >= 400) expect.soft(after, "a refused correction writes nothing").toEqual(before);
    expect.soft(cash, "the payment's bank figure is still the cash that actually left").toBe(-9_500);
  }, 60_000);

  for (const cls of ["unknown", "security_deposit"] as const) {
    it(`🔴 PROOF D (safeguard II): a ${cls === "unknown" ? "PENDING (unidentified)" : "refundable DEPOSIT"} payment — a correction never makes it a withheld advance, and the bank still shows the 10,000 that left (control: classify refuses by name)`, async () => {
      const b = await bank(`S1b DR45 D ${cls}`);
      const sp = await h.api("admin", "POST", "/supplier-payments", { vendorId, bankAccountId: b, amount: 10_000, paidAt: "2026-10-02", classification: cls });
      expect(sp.status, JSON.stringify(sp.body)).toBe(201);
      const orig = (await pool.query(`SELECT id, status FROM wht_withholdings WHERE supplier_payment_id = $1 AND correction_id IS NULL`, [sp.body.id])).rows[0];
      expect(orig.status).toBe(cls === "unknown" ? "pending" : "not_subject");
      expect(await bankGl(b)).toBe(-10_000);
      // CONTROL: the reclassification path refuses the same conversion by name, and writes nothing.
      const before = await counts();
      const ref = await h.api("admin", "POST", `/supplier-payments/${sp.body.id}/classify`, { classification: "advance", whtPaymentType: "royalty" });
      expect([ref.status, ref.body?.code], JSON.stringify(ref.body)).toEqual([409, "wht_late_withholding_open"]);
      expect(await counts()).toEqual(before);
      // The correction path.
      const r = await correct(orig.id, {
        reason: "it was an advance for a licence (royalty) after all", date: "2026-10-05",
        reentry: { amount: 10_000, paidAt: "2026-10-02", classification: "advance", whtPaymentType: "royalty" },
      });
      const re = await reentryOf(orig.id);
      const cash = await bankGl(b);
      // eslint-disable-next-line no-console
      console.warn(`[S1B DR45] D ${cls}`, JSON.stringify({ original: orig, classifyControl: [ref.status, ref.body?.code], correction: [r.status, r.body?.code ?? null], reentry: re, bankCashAfter: cash, cashThatLeft: -10_000 }));
      expect.soft(re?.status ?? null, "a pending / not-subject original never becomes 'withheld' through a correction").not.toBe("withheld");
      expect.soft(cash, "the payment's bank figure is still the cash that actually left").toBe(-10_000);
    }, 60_000);
  }
});
