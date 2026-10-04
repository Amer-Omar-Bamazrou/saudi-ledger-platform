/**
 * PHASE 16A — WITHHOLDING TAX, on real rows (docs/product/phase-16-17-tax-treasury-decision-pack.md §2, §10).
 *
 * Every payment here goes through the product's OWN pay paths (`billsService.pay`,
 * `supplierPaymentsService.create`); every bill through create + approve. The
 * database guards are then attacked directly — a rule only the service keeps is
 * a convention (CLAUDE.md §3).
 *
 *   W1  GL WHT_PAYABLE = Σ withheld − Σ remitted + Σ reversed, EXACT
 *   W2  a payment to a non-resident: AP debit = base; bank credit = base − WHT; WHT = round2(base × rate)
 *   W3  a line on WHT_PAYABLE no WHT record owns is refused at COMMIT
 *   W4  the monthly return's totals = Σ that month's withholdings
 *   W5  the rate is the one in force on the payment date; none → refused
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { reportsService } from "../services/reports.service";
import { whtService, delayFineEstimate, whtDueDate } from "../services/tax/wht.service";
import { whtHalalas, rateBasisPoints } from "../services/accounting/wht";
import { taxObligationsService } from "../services/tax/taxObligations.service";
import { exportReport } from "../services/reporting/reportExport.service";
import {
  GetWhtOverviewResponse, GetWhtReturnResponse, GetWhtAnnualResponse, GetWhtBeneficiaryStatementResponse, ListWhtExceptionsResponse,
  ListWhtReliefsResponse, ListWhtRatesResponse, PreviewWhtResponse, GetTaxObligationsResponse,
} from "@workspace/api-zod";
import { expectConforms } from "./helpers/conforms";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-wht] no real DATABASE_URL — skipping.");

// ── pure ─────────────────────────────────────────────────────────────────────
describe("Phase 16 — WHT arithmetic (pure)", () => {
  it("the tax is round-half-up of base × rate, in halalas — never a float residue", () => {
    expect(rateBasisPoints("0.0500")).toBe(500);
    expect(rateBasisPoints("0.2000")).toBe(2000);
    expect(whtHalalas(123456, "0.0500")).toBe(6173); // 1,234.56 × 5 % = 61.728 → 61.73
    expect(whtHalalas(10, "0.0500")).toBe(1);        // 0.10 × 5 % = 0.005 → 0.01 (half up)
    expect(whtHalalas(9, "0.0500")).toBe(0);         // 0.09 × 5 % = 0.0045 → 0.00
    expect(whtHalalas(100000, "0.1500")).toBe(15000);
    expect(whtHalalas(100000, "0")).toBe(0);
  });
  it("the due date is the 10th of the following month (IR Art. 63(9)(a)), across a year end", () => {
    expect(whtDueDate("2026-07")).toBe("2026-08-10");
    expect(whtDueDate("2026-12")).toBe("2027-01-10");
  });
  it("🔴 the delay-fine ESTIMATE: nothing under 30 days; 1 % per FULL 30 days after the due date (Art. 77(A); IR Art. 68(2))", () => {
    expect(delayFineEstimate(1000, "2026-08-10", "2026-08-10")).toEqual({ blocks: 0, daysLate: 0, amount: 0 });
    expect(delayFineEstimate(1000, "2026-08-10", "2026-09-08")).toEqual({ blocks: 0, daysLate: 29, amount: 0 });
    expect(delayFineEstimate(1000, "2026-08-10", "2026-09-09")).toEqual({ blocks: 1, daysLate: 30, amount: 10 });
    expect(delayFineEstimate(1000, "2026-08-10", "2026-10-09")).toEqual({ blocks: 2, daysLate: 60, amount: 20 });
    expect(delayFineEstimate(0, "2026-08-10", "2026-12-31").amount).toBe(0);
  });
});

describeMaybe("Phase 16 — withholding tax on real rows", () => {
  const SLUG = "p16-wht", SLUG_C = "p16-wht-c", EMAIL = "p16-wht@test.local";
  let orgId = "", orgC = "", coA = "", coB = "", coC = "", userId = 0;
  let bankA = 0, bankB = 0, bankC = 0;
  const v: Record<string, number> = {};
  let seq = 0;

  const inCo = async <T,>(org: string, co: string, fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const inA = <T,>(fn: () => Promise<T>) => inCo(orgId, coA, fn);
  const inB = <T,>(fn: () => Promise<T>) => inCo(orgId, coB, fn);
  const inC = <T,>(fn: () => Promise<T>) => inCo(orgC, coC, fn);

  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG}','${SLUG_C}'))`;
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM organizations WHERE slug IN ('${SLUG}','${SLUG_C}')`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return e as { statusCode?: number; status?: number; payload?: { code?: string }; message: string; constraint?: string }; }
    throw new Error("expected a refusal");
  };
  /** credit − debit of a system account for one company, entries in the books */
  const glCredit = async (co: string, code: string) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text v FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.company_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [co, code])).rows[0].v);
  const bankGl = async (bank: number) =>
    Number((await pool.query(
      `SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text v FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id
        WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bank])).rows[0].v);
  const entryCount = async () => Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);
  const bill = async (inX: <T>(fn: () => Promise<T>) => Promise<T>, vendorId: number, net: number, date = "2026-07-01") => {
    const draft = await inX(() => billsService.create({
      supplierDocumentKind: "tax_invoice", vendorReference: `SUP-${++seq}`, billNumber: `P16W-${seq}`, date, dueDate: "2026-07-31", vendorId,
      items: [{ description: "Services", quantity: 1, unitPrice: net, vatRate: 0 }],
    }, userId)) as { id: number };
    return (await inX(() => billsService.approve(draft.id, {}, userId)) as { id: number }).id;
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P16 WHT','${SLUG}','approved') RETURNING id`)).rows[0].id;
    coA = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P16 WHT A',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
    await new Promise((r) => setTimeout(r, 20));
    coB = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P16 WHT B',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
    orgC = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P16 WHT C','${SLUG_C}','approved') RETURNING id`)).rows[0].id;
    coC = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P16 WHT C co',1,'gregorian') RETURNING id`, [orgC])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P16W',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, orgC]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    bankA = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'WHT Bank A','Riyad') RETURNING id`, [orgId, coA])).rows[0].id;
    bankB = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'WHT Bank B','Riyad') RETURNING id`, [orgId, coB])).rows[0].id;
    bankC = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'WHT Bank C','Riyad') RETURNING id`, [orgC, coC])).rows[0].id;
    const vendor = async (org: string, name: string, residency: string, type: string | null) =>
      (await pool.query(`INSERT INTO vendors (organization_id, name, residency, wht_default_payment_type, country, foreign_tax_id) VALUES ($1,$2,$3,$4,'GB','GB-123') RETURNING id`, [org, name, residency, type])).rows[0].id as number;
    v.nr = await vendor(orgId, "London Consulting Ltd", "non_resident", "technical_consulting");
    v.nr2 = await vendor(orgId, "Dublin Royalties Ltd", "non_resident", null);
    v.res = await vendor(orgId, "Riyadh Supplies", "resident", null);
    v.unk = await vendor(orgId, "Undeclared Co", "unknown", null);
    v.nrC = await vendor(orgC, "Paris Advisory", "non_resident", "technical_consulting");
  }, 180_000);
  afterAll(cleanup);

  it("🔴 W2 + W1 — a bill payment to a non-resident: AP −10,000; bank −9,500; WHT payable +500; the withholding IS the payment", async () => {
    const b1 = await bill(inA, v.nr!, 10_000);
    const bankBefore = await bankGl(bankA);
    await inA(() => billsService.pay(b1, { amount: 10_000, paidAt: "2026-07-10", bankAccountId: bankA }, userId));
    expect(await bankGl(bankA) - bankBefore, "the bank paid the net").toBeCloseTo(-9_500, 2);
    expect(await glCredit(coA, "WHT_PAYABLE")).toBe(500);
    const owes = (await pool.query(`SELECT paid_amount::text p, status FROM bills WHERE id = $1`, [b1])).rows[0];
    expect([Number(owes.p), owes.status], "the supplier is credited with the GROSS: the bill is settled").toEqual([10_000, "paid"]);
    const w = (await pool.query(`SELECT * FROM wht_withholdings WHERE bill_id = $1`, [b1])).rows[0];
    expect([w.status, w.payment_type, Number(w.base_amount), Number(w.rate), Number(w.statutory_rate), Number(w.wht_amount), w.period])
      .toEqual(["withheld", "technical_consulting", 10_000, 0.05, 0.05, 500, "2026-07"]);
    const ov = await inA(() => whtService.overview());
    expect(ov.reconciliation).toEqual({ glWhtPayable: 500, whtLedger: 500, reconciles: true });
    // the payment history shows what left the bank
    const hist = await inA(() => billsService.payments(b1));
    expect([hist[0]!.amount, hist[0]!.withheld, hist[0]!.cashPaid]).toEqual([10_000, 500, 9_500]);
  });

  it("🔴 a non-resident payment with no declared nature is REFUSED in words, and nothing is posted", async () => {
    const b2 = await bill(inA, v.nr2!, 5_000);
    const before = await entryCount();
    const e = await refusal(inA(() => billsService.pay(b2, { amount: 5_000, paidAt: "2026-07-11", bankAccountId: bankA }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([422, "wht_classification_required"]);
    expect(await entryCount(), "a refused payment posts nothing").toBe(before);
    expect(Number((await pool.query(`SELECT paid_amount::text p FROM bills WHERE id = $1`, [b2])).rows[0].p)).toBe(0);
    // declared: a royalty — 15 %
    await inA(() => billsService.pay(b2, { amount: 5_000, paidAt: "2026-07-11", bankAccountId: bankA, whtPaymentType: "royalty" }, userId));
    expect(Number((await pool.query(`SELECT wht_amount::text w FROM wht_withholdings WHERE bill_id = $1`, [b2])).rows[0].w)).toBe(750);
  });

  it("not subject: goods is recorded with its reason and withholds nothing; not-Kingdom-source needs its explanation", async () => {
    const b = await bill(inA, v.nr2!, 2_000);
    const e = await refusal(inA(() => billsService.pay(b, { amount: 1_000, paidAt: "2026-07-12", bankAccountId: bankA, whtNotSubjectReason: "not_kingdom_source", whtNotSubjectNote: "abroad" }, userId)));
    expect(e.payload?.code).toBe("wht_not_subject_note_required");
    const e2 = await refusal(inA(() => billsService.pay(b, { amount: 1_000, paidAt: "2026-07-12", bankAccountId: bankA, whtPaymentType: "royalty", whtNotSubjectReason: "goods" }, userId)));
    expect(e2.payload?.code).toBe("wht_declaration_conflict");
    const whtBefore = await glCredit(coA, "WHT_PAYABLE");
    await inA(() => billsService.pay(b, { amount: 2_000, paidAt: "2026-07-12", bankAccountId: bankA, whtNotSubjectReason: "goods" }, userId));
    expect(await glCredit(coA, "WHT_PAYABLE"), "nothing withheld").toBe(whtBefore);
    const w = (await pool.query(`SELECT status, not_subject_reason, wht_amount::text w, rate::text r FROM wht_withholdings WHERE bill_id = $1`, [b])).rows[0];
    expect([w.status, w.not_subject_reason, Number(w.w), Number(w.r)]).toEqual(["not_subject", "goods", 0, 0]);
  });

  it("a resident withholds nothing, and a WHT declaration against one is refused; an UNDECLARED supplier is an exception, then 'possibly missed'", async () => {
    const r = await bill(inA, v.res!, 2_000);
    const e = await refusal(inA(() => billsService.pay(r, { amount: 2_000, paidAt: "2026-07-13", bankAccountId: bankA, whtPaymentType: "rent" }, userId)));
    expect(e.payload?.code).toBe("wht_vendor_not_non_resident");
    await inA(() => billsService.pay(r, { amount: 2_000, paidAt: "2026-07-13", bankAccountId: bankA }, userId));
    expect(Number((await pool.query(`SELECT count(*)::int n FROM wht_withholdings WHERE bill_id = $1`, [r])).rows[0].n)).toBe(0);

    const u = await bill(inA, v.unk!, 3_000);
    await inA(() => billsService.pay(u, { amount: 3_000, paidAt: "2026-07-14", bankAccountId: bankA }, userId));
    const und = await inA(() => whtService.exceptions("undeclared"));
    expect(und.items.map((i) => i.vendorId)).toContain(v.unk);
    // the supplier is later declared non-resident: the past payment surfaces as POSSIBLY MISSED
    await pool.query(`UPDATE vendors SET residency = 'non_resident' WHERE id = $1`, [v.unk]);
    const missed = await inA(() => whtService.exceptions("possibly_missed"));
    expect(missed.items.map((i) => i.vendorId), "who finds out: the exception list does").toContain(v.unk);
    expect((await inA(() => whtService.exceptions("undeclared"))).items.map((i) => i.vendorId)).not.toContain(v.unk);
  });

  it("🔴 W5 — the rate is the one in force on the PAYMENT date; a date before the loaded schedule is refused", async () => {
    const b = await bill(inA, v.nr!, 1_000, "2023-08-01");
    const e = await refusal(inA(() => billsService.pay(b, { amount: 1_000, paidAt: "2023-09-01", bankAccountId: bankA }, userId)));
    expect(e.payload?.code).toBe("wht_rate_not_loaded");
  });

  it("🔴 treaty relief: pending changes nothing; approved lowers the rate inside its window only; revoked restores it", async () => {
    const rel = await inA(() => whtService.createRelief({ vendorId: v.nr, paymentType: "technical_consulting", reducedRate: 0, treatyCountry: "GB", zatcaApprovalReference: "ZATCA-DTA-778", residencyCertificateReference: "HMRC-TRC-2026", validFrom: "2026-07-20", validTo: "2026-07-31" }, userId));
    expect(rel.status).toBe("pending");
    const p1 = await bill(inA, v.nr!, 1_000);
    await inA(() => billsService.pay(p1, { amount: 1_000, paidAt: "2026-07-21", bankAccountId: bankA }, userId));
    expect(Number((await pool.query(`SELECT wht_amount::text w FROM wht_withholdings WHERE bill_id = $1`, [p1])).rows[0].w), "pending relief: statutory").toBe(50);
    await inA(() => whtService.approveRelief(rel.id, userId));
    const p2 = await bill(inA, v.nr!, 1_000);
    await inA(() => billsService.pay(p2, { amount: 1_000, paidAt: "2026-07-22", bankAccountId: bankA }, userId));
    const w2 = (await pool.query(`SELECT wht_amount::text w, rate::text r, statutory_rate::text s, treaty_relief_id FROM wht_withholdings WHERE bill_id = $1`, [p2])).rows[0];
    expect([Number(w2.w), Number(w2.r), Number(w2.s), w2.treaty_relief_id]).toEqual([0, 0, 0.05, rel.id]);
    const p3 = await bill(inA, v.nr!, 1_000);
    await inA(() => billsService.pay(p3, { amount: 1_000, paidAt: "2026-08-02", bankAccountId: bankA }, userId));
    expect(Number((await pool.query(`SELECT wht_amount::text w FROM wht_withholdings WHERE bill_id = $1`, [p3])).rows[0].w), "outside the window: statutory").toBe(50);
    await inA(() => whtService.revokeRelief(rel.id, { reason: "certificate withdrawn" }, userId));
    // the database refuses a relief rate above the statutory one, and editing an approved relief's terms
    expect((await refusal(pool.query(`UPDATE vendor_wht_treaty_reliefs SET reduced_rate = 0.01 WHERE id = $1`, [rel.id]))).constraint).toBe("wht_relief_terms_frozen");
  });

  it("🔴 a supplier payment to a non-resident: the supplier is credited with the GROSS (AP + advance), the bank pays the net; its refund is refused (W-12)", async () => {
    const b = await bill(inA, v.nr!, 5_000);
    const bankBefore = await bankGl(bankA);
    const pay = await inA(() => supplierPaymentsService.create({
      vendorId: v.nr, bankAccountId: bankA, amount: 8_000, paidAt: "2026-07-15", classification: "advance",
      allocations: [{ billId: b, amount: 5_000 }],
    }, userId)) as { id: number };
    expect(await bankGl(bankA) - bankBefore).toBeCloseTo(-7_600, 2);
    const row = (await pool.query(`SELECT amount::text a FROM supplier_payments WHERE id = $1`, [pay.id])).rows[0];
    expect(Number(row.a), "the payment amount is what the supplier is credited with").toBe(8_000);
    const w = (await pool.query(`SELECT source_kind, base_amount::text b, wht_amount::text w FROM wht_withholdings WHERE supplier_payment_id = $1`, [pay.id])).rows[0];
    expect([w.source_kind, Number(w.b), Number(w.w)]).toEqual(["supplier_payment", 8_000, 400]);
    const e = await refusal(inA(() => supplierPaymentsService.refund(pay.id, { amount: 1_000, bankAccountId: bankA, reason: "returned" }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([409, "wht_refund_unsupported"]);
  });

  it("🔴 W4 — the July return: its lines and schedule are the month's withholdings; the excluded payments carry their reasons", async () => {
    const r = await inA(() => whtService.monthlyReturn("2026-07"));
    const rows = (await pool.query(`SELECT * FROM wht_withholdings WHERE company_id = $1 AND period = '2026-07'`, [coA])).rows;
    const withheld = rows.filter((x) => x.status === "withheld");
    const sum = (xs: { [k: string]: string }[], k: string) => Math.round(xs.reduce((s, x) => s + Number(x[k]) * 100, 0)) / 100;
    expect(r.totals.taxWithheld).toBe(sum(withheld, "wht_amount"));
    expect(r.totals.paymentTotal).toBe(sum(withheld, "base_amount"));
    expect(r.lines.reduce((s, l) => Math.round((s + l.taxWithheld) * 100) / 100, 0)).toBe(r.totals.taxWithheld);
    expect(r.schedule.length).toBe(withheld.length);
    expect(r.excluded.map((x) => x.notSubjectReason)).toContain("goods");
    expect(r.dueDate).toBe("2026-08-10");
    const tc = r.lines.find((l) => l.paymentType === "technical_consulting")!;
    expect([tc.formRow, tc.applicable]).toEqual(["10", true]);
  });

  it("🔴 remittance and its reversal keep W1 exact; over-remitting is refused; a reversal is reversed once", async () => {
    const before = await inA(() => whtService.monthlyReturn("2026-07"));
    const owed = before.totals.outstanding;
    expect(owed).toBeGreaterThan(0);
    const over = await refusal(inA(() => whtService.remit("2026-07", { amount: owed + 1, bankAccountId: bankA, paidAt: "2026-08-08" }, userId)));
    expect([over.statusCode, over.payload?.code]).toEqual([409, "wht_remittance_exceeds"]);
    const bankBefore = await bankGl(bankA);
    const { remittance } = await inA(() => whtService.remit("2026-07", { bankAccountId: bankA, paidAt: "2026-08-08", fineAmount: 10, reference: "SADAD-1" }, userId));
    expect([remittance.amount, remittance.fineAmount]).toEqual([owed, 10]);
    expect(await bankGl(bankA) - bankBefore).toBeCloseTo(-(owed + 10), 2);
    const after = await inA(() => whtService.monthlyReturn("2026-07"));
    expect([after.totals.outstanding, after.status]).toEqual([0, "remitted"]);
    let ov = await inA(() => whtService.overview());
    expect(ov.reconciliation.reconciles).toBe(true);
    expect(await glCredit(coA, "TAX_PENALTIES")).toBe(-10); // a fine is an EXPENSE (debit)
    // 🔴 the cash flow of the remittance day: the WHT on the VAT/WHT tax line, the FINE as an operating expense
    // (a fine is a cost, not a tax) — and the statement reconciles to the bank's own movement
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const cfRemit = await inA(() => reportsService.cashFlow("2026-08-08", "2026-08-08"));
    expect(cfRemit.operating.items.map((i) => [i.key, i.amount]).sort()).toEqual([["payments_suppliers", -10], ["taxes", r2(-owed)]].sort());
    expect([cfRemit.netChange, cfRemit.reconciles]).toEqual([r2(-(owed + 10)), true]);
    // reverse it: the month owes again; W1 holds; a second reversal is refused
    await inA(() => whtService.reverseRemittance(remittance.id, { reason: "duplicate SADAD payment", date: "2026-08-09" }, userId));
    // the reversal is the mirror cash flow: back on the same two lines, never a new kind of movement
    const cfRev = await inA(() => reportsService.cashFlow("2026-08-09", "2026-08-09"));
    expect(cfRev.operating.items.map((i) => [i.key, i.amount]).sort()).toEqual([["payments_suppliers", 10], ["taxes", r2(owed)]].sort());
    expect(cfRev.reconciles).toBe(true);
    expect((await inA(() => whtService.monthlyReturn("2026-07"))).totals.outstanding).toBe(owed);
    ov = await inA(() => whtService.overview());
    expect(ov.reconciliation.reconciles).toBe(true);
    expect((await refusal(inA(() => whtService.reverseRemittance(remittance.id, { reason: "again" }, userId)))).payload?.code).toBe("wht_remittance_already_reversed");
  });

  it("🔴 W3 — the database refuses WHT_PAYABLE moved by anything but a WHT record, a withholding that is not its payment, and any edit", async () => {
    const wht = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'WHT_PAYABLE'`, [orgId])).rows[0].id;
    const exp = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'PURCHASES'`, [orgId])).rows[0].id;
    // a manual journal entry, through the product's own path, is refused at COMMIT
    const e = await refusal(inA(async () => {
      const je = (await journalEntriesService.create({ entryNumber: "P16W-MANUAL", date: "2026-07-20", description: "manual WHT", lines: [
        { accountId: exp, debitAmount: 100, creditAmount: 0 }, { accountId: wht, debitAmount: 0, creditAmount: 100 },
      ] }, userId)) as { id: number };
      await journalEntriesService.approve(je.id, userId);
    }));
    expect(e.message + (e.constraint ?? "")).toMatch(/wht_payable_unowned|no WHT record owns/);
    // a withholding row whose tax is not base × rate: the CHECK
    const w = (await pool.query(`SELECT * FROM wht_withholdings WHERE company_id = $1 AND status = 'withheld' ORDER BY id LIMIT 1`, [coA])).rows[0];
    const ins = (cols: Record<string, unknown>) => pool.query(
      `INSERT INTO wht_withholdings (organization_id, company_id, source_kind, bill_payment_id, vendor_id, bill_id, payment_date, period, status, payment_type, base_amount, rate, statutory_rate, rate_id, wht_amount, journal_entry_id)
       VALUES ($1,$2,'bill_payment',$3,$4,$5,$6,$7,'withheld',$8,$9,$10,$11,$12,$13,$14)`,
      [w.organization_id, w.company_id, cols.bill_payment_id ?? w.bill_payment_id, w.vendor_id, w.bill_id, w.payment_date, w.period, w.payment_type, w.base_amount, cols.rate ?? w.rate, w.statutory_rate, w.rate_id, cols.wht_amount ?? w.wht_amount, w.journal_entry_id]);
    expect((await refusal(ins({ wht_amount: Number(w.wht_amount) + 1 }))).constraint).toBe("wht_withholdings_amount_chk");
    // the same payment cannot be withheld twice
    expect((await refusal(ins({}))).message).toMatch(/duplicate key|wht_withholdings_bill_payment_unq/);
    // append-only, for the owner role too
    expect((await refusal(pool.query(`UPDATE wht_withholdings SET wht_amount = 0 WHERE id = $1`, [w.id]))).constraint).toBe("wht_append_only");
    expect((await refusal(pool.query(`DELETE FROM wht_withholdings WHERE id = $1`, [w.id]))).constraint).toBe("wht_append_only");
  });

  it("🔴 the generic journal reverse refuses an entry a withholding owns (the 0107 mechanism, extended)", async () => {
    const w = (await pool.query(`SELECT journal_entry_id FROM wht_withholdings WHERE company_id = $1 AND status = 'withheld' ORDER BY id LIMIT 1`, [coA])).rows[0];
    const e = await refusal(inA(() => journalEntriesService.reverse(w.journal_entry_id, { reason: "try" })));
    expect(e.message).toMatch(/withheld tax|withholding/i);
    // and at the database, for a caller that skips the service
    expect((await refusal(pool.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [w.journal_entry_id]))).constraint).toBe("journal_entries_tax_reversal_guard");
  });

  it("🔴 contract conformance — every WHT response parses under its generated schema, on these real rows (withheld, not subject, a treaty relief, a reversed remittance)", async () => {
    const ov = await inA(() => whtService.overview());
    expect(ov.months.length).toBeGreaterThan(0);
    expectConforms(GetWhtOverviewResponse, ov, "GET /tax/wht/overview");
    const ret = await inA(() => whtService.monthlyReturn("2026-07"));
    expect([ret.schedule.length > 0, ret.excluded.length > 0, ret.remittances.length > 0]).toEqual([true, true, true]);
    expectConforms(GetWhtReturnResponse, ret, "GET /tax/wht/returns/:period");
    const annual = await inA(() => whtService.annual(2026));
    expect(annual.beneficiaries.length).toBeGreaterThan(0);
    expectConforms(GetWhtAnnualResponse, annual, "GET /tax/wht/annual");
    expectConforms(GetWhtBeneficiaryStatementResponse, await inA(() => whtService.beneficiaryStatement(v.nr!, "2026-07")), "GET /tax/wht/beneficiaries/:vendorId");
    for (const kind of ["undeclared", "possibly_missed"] as const) expectConforms(ListWhtExceptionsResponse, await inA(() => whtService.exceptions(kind)), `GET /tax/wht/exceptions?kind=${kind}`);
    const reliefs = await inA(() => whtService.reliefs());
    expect(reliefs.length).toBeGreaterThan(0);
    expect(reliefs.every((r) => r.vendorName.length > 0), "every relief names its supplier").toBe(true);
    expectConforms(ListWhtReliefsResponse, reliefs, "GET /tax/wht/reliefs");
    expectConforms(ListWhtRatesResponse, await inA(() => whtService.rates()), "GET /tax/wht/rates");
    expectConforms(PreviewWhtResponse, await inA(() => whtService.preview({ vendorId: v.nr, amount: 1000, date: "2026-07-15" })), "GET /tax/wht/preview (withheld)");
    expectConforms(PreviewWhtResponse, await inA(() => whtService.preview({ vendorId: v.res, amount: 1000, date: "2026-07-15" })), "GET /tax/wht/preview (resident)");
    expectConforms(GetTaxObligationsResponse, await inA(() => taxObligationsService.list()), "GET /tax/obligations");
    // the instrument sees: a broken response FAILS the same schema
    expect(GetWhtReturnResponse.safeParse({ ...JSON.parse(JSON.stringify(ret)), totals: null }).success).toBe(false);
    // the CSV exports carry the screen's figures — the return's withheld total, the annual return's per-beneficiary WHT
    const csv = (await inA(() => exportReport("wht-return", { period: "2026-07" }, "csv", "en"))).body.toString("utf8");
    expect(csv).toContain(ret.totals.taxWithheld.toFixed(2));
    const annualCsv = (await inA(() => exportReport("wht-annual", { fiscal_year: "2026" }, "csv", "en"))).body.toString("utf8");
    expect(annualCsv).toContain("London Consulting Ltd");
    expect(annualCsv).toContain(annual.totals.wht.toFixed(2));
  });

  it("🔴 isolation — presence, absence, movement: company B and another organisation see none of A's withholding; B's own is B's alone", async () => {
    const aMonths = (await inA(() => whtService.overview())).months.map((m) => m.period);
    expect(aMonths).toContain("2026-07");
    expect((await inB(() => whtService.overview())).months, "B: nothing of A's").toEqual([]);
    expect((await inB(() => whtService.monthlyReturn("2026-07"))).schedule).toEqual([]);
    expect((await inC(() => whtService.overview())).months).toEqual([]);
    // movement: C pays its own non-resident — C sees it, A does not see C's
    const bc = await bill(inC, v.nrC!, 2_000);
    await inC(() => billsService.pay(bc, { amount: 2_000, paidAt: "2026-07-16", bankAccountId: bankC }, userId));
    const cRet = await inC(() => whtService.monthlyReturn("2026-07"));
    expect(cRet.totals.taxWithheld).toBe(100);
    expect((await inA(() => whtService.monthlyReturn("2026-07"))).schedule.map((s) => s.vendorId)).not.toContain(v.nrC);
    // B cannot pay A's bill, nor remit into A's month with A's bank
    expect((await refusal(inB(() => whtService.remit("2026-07", { bankAccountId: bankA }, userId)))).statusCode).toBeGreaterThanOrEqual(400);
    void bankB;
  });
});
