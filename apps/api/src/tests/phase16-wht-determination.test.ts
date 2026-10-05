/**
 * ACCOUNTANT Q2 (2026-10-05) — THE WHT DETERMINATION IS CATEGORY-AWARE, on real rows.
 * Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §14.2.
 *
 * The four dimensions, none deciding alone: the RECIPIENT (non-resident only),
 * the SOURCE (in the Kingdom unless declared otherwise), what the money WAS
 * (consideration is judged by its nature; a refundable deposit and an erroneous
 * payment are not subject; an unidentified one is pending), the RATE (the
 * regulation's on the payment date, or an approved treaty relief).
 *
 * 🔴 "Non-resident = WHT" must be inexpressible: every supplier here that
 * receives a deposit, an erroneous or an unidentified payment carries a
 * DEFAULT taxable nature (royalty, 15 %) — the very fact the old engine
 * withheld on (D-12). A regression to it fails these tests by a figure, and the
 * database refuses the same rows for a caller that skips the service.
 *
 * Every payment goes through the product's own pay paths; the database guards
 * are then attacked directly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { whtService } from "../services/tax/wht.service";
import { GetWhtReturnResponse, GetWhtOverviewResponse, PreviewWhtResponse, ListWhtExceptionsResponse } from "@workspace/api-zod";
import { expectConforms } from "./helpers/conforms";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-wht-determination] no real DATABASE_URL — skipping.");

describeMaybe("Q2 — the WHT determination: recipient + source + what the money was + the rate", () => {
  const SLUG = "q2-wht", SLUG_C = "q2-wht-c", EMAIL = "q2-wht@test.local";
  let orgId = "", orgC = "", coA = "", coB = "", coC = "", userId = 0;
  let bankA = 0, bankC = 0;
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
    try { await p; } catch (e) { return e as { statusCode?: number; payload?: { code?: string; error?: string }; message: string; constraint?: string }; }
    throw new Error("expected a refusal");
  };
  const glCredit = async (co: string, code: string) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text v FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.company_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [co, code])).rows[0].v);
  const bankGl = async (bank: number) =>
    Number((await pool.query(
      `SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text v FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id
        WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bank])).rows[0].v);
  const rowsOf = async (sql: string, args: unknown[]) => (await pool.query(sql, args)).rows;
  const whtRowOfPayment = async (paymentId: number) =>
    (await rowsOf(`SELECT * FROM wht_withholdings WHERE supplier_payment_id = $1 ORDER BY id`, [paymentId]));
  const entryCount = async () => Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);
  const bill = async (inX: <T>(fn: () => Promise<T>) => Promise<T>, vendorId: number, net: number, date = "2026-08-01") => {
    const draft = await inX(() => billsService.create({
      supplierDocumentKind: "tax_invoice", vendorReference: `Q2-${++seq}`, billNumber: `Q2-${seq}`, date, dueDate: "2026-08-31", vendorId,
      items: [{ description: "Services", quantity: 1, unitPrice: net, vatRate: 0 }],
    }, userId)) as { id: number };
    return (await inX(() => billsService.approve(draft.id, {}, userId)) as { id: number }).id;
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('Q2 WHT','${SLUG}','approved') RETURNING id`)).rows[0].id;
    coA = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'Q2 A',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
    await new Promise((r) => setTimeout(r, 20));
    coB = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'Q2 B',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
    orgC = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('Q2 WHT C','${SLUG_C}','approved') RETURNING id`)).rows[0].id;
    coC = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'Q2 C',1,'gregorian') RETURNING id`, [orgC])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','Q2',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, orgC]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    bankA = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Q2 Bank A','Riyad') RETURNING id`, [orgId, coA])).rows[0].id;
    await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Q2 Bank B','Riyad')`, [orgId, coB]);
    bankC = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Q2 Bank C','Riyad') RETURNING id`, [orgC, coC])).rows[0].id;
    const vendor = async (org: string, name: string, residency: string, type: string | null) =>
      (await pool.query(`INSERT INTO vendors (organization_id, name, residency, wht_default_payment_type, country, foreign_tax_id) VALUES ($1,$2,$3,$4,'GB','GB-9') RETURNING id`, [org, name, residency, type])).rows[0].id as number;
    v.consult = await vendor(orgId, "Q2 London Consulting", "non_resident", null);
    // 🔴 a non-resident whose DEFAULT nature is taxable — the trap the old engine fell into for deposits (D-12)
    v.royal = await vendor(orgId, "Q2 Dublin Royalties", "non_resident", "royalty");
    v.goods = await vendor(orgId, "Q2 Shenzhen Parts", "non_resident", null);
    v.res = await vendor(orgId, "Q2 Riyadh Supplies", "resident", null);
    v.royalC = await vendor(orgC, "Q2 C Royalties", "non_resident", "royalty");
  }, 180_000);
  afterAll(cleanup);

  it("🔴 non-resident + a TAXABLE SERVICE declared on the payment: 5 %, judged as consideration, nature declared — every dimension recorded", async () => {
    const b = await bill(inA, v.consult!, 10_000);
    await inA(() => billsService.pay(b, { amount: 10_000, paidAt: "2026-08-05", bankAccountId: bankA, whtPaymentType: "technical_consulting" }, userId));
    const [w] = await rowsOf(`SELECT * FROM wht_withholdings WHERE bill_id = $1`, [b]);
    expect([w.status, w.payment_type, Number(w.rate), Number(w.wht_amount), w.payment_class, w.nature_basis]).toEqual(["withheld", "technical_consulting", 0.05, 500, "bill_payment", "declared"]);
    const ret = await inA(() => whtService.monthlyReturn("2026-08"));
    const row = ret.schedule.find((s) => s.id === w.id)!;
    expect(row.determination).toEqual({
      outcome: "taxable_wht", reasonCode: "statutory_rate", recipient: "non_resident", kingdomSource: "presumed",
      paymentClass: "bill_payment", paymentType: "technical_consulting", natureBasis: "declared",
    });
  });

  it("🔴 non-resident + ROYALTY from the supplier's declared default: 15 %, the basis says it was the supplier's default", async () => {
    const b = await bill(inA, v.royal!, 4_000);
    await inA(() => billsService.pay(b, { amount: 4_000, paidAt: "2026-08-06", bankAccountId: bankA }, userId));
    const [w] = await rowsOf(`SELECT * FROM wht_withholdings WHERE bill_id = $1`, [b]);
    expect([w.status, w.payment_type, Number(w.wht_amount), w.nature_basis]).toEqual(["withheld", "royalty", 600, "supplier_default"]);
  });

  it("non-resident + a GOODS-only supply: not WHT under the existing rule (Art. 68 lists no goods), recorded with its reason, nothing withheld", async () => {
    const b = await bill(inA, v.goods!, 3_000);
    const whtBefore = await glCredit(coA, "WHT_PAYABLE");
    await inA(() => billsService.pay(b, { amount: 3_000, paidAt: "2026-08-07", bankAccountId: bankA, whtNotSubjectReason: "goods" }, userId));
    expect(await glCredit(coA, "WHT_PAYABLE")).toBe(whtBefore);
    const [w] = await rowsOf(`SELECT * FROM wht_withholdings WHERE bill_id = $1`, [b]);
    expect([w.status, w.not_subject_reason, Number(w.wht_amount), w.payment_class, w.nature_basis]).toEqual(["not_subject", "goods", 0, "bill_payment", "declared"]);
  });

  it("🔴 a REFUNDABLE DEPOSIT to a non-resident with a taxable default nature: NOT WHT, nothing withheld, the bank pays the whole deposit — and the deposit comes back (W-12 no longer traps it)", async () => {
    const bankBefore = await bankGl(bankA), whtBefore = await glCredit(coA, "WHT_PAYABLE");
    const pay = await inA(() => supplierPaymentsService.create({ vendorId: v.royal, bankAccountId: bankA, amount: 20_000, paidAt: "2026-08-08", classification: "security_deposit" }, userId)) as { id: number };
    expect(await bankGl(bankA) - bankBefore, "the whole deposit left the bank").toBeCloseTo(-20_000, 2);
    expect(await glCredit(coA, "WHT_PAYABLE"), "🔴 non-residency alone withheld nothing").toBe(whtBefore);
    const [w] = await whtRowOfPayment(pay.id);
    expect([w.status, w.not_subject_reason, w.payment_type, Number(w.wht_amount), w.payment_class, w.nature_basis])
      .toEqual(["not_subject", "refundable_deposit", null, 0, "security_deposit", "payment_class"]);
    // a nature declared on a deposit is a contradiction, refused in words, posting nothing
    const before = await entryCount();
    const e = await refusal(inA(() => supplierPaymentsService.create({ vendorId: v.royal, bankAccountId: bankA, amount: 1_000, paidAt: "2026-08-08", classification: "security_deposit", whtPaymentType: "royalty" }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([422, "wht_declaration_conflict"]);
    expect(await entryCount()).toBe(before);
    // the deposit is recovered in full
    await inA(() => supplierPaymentsService.refund(pay.id, { amount: 20_000, bankAccountId: bankA, reason: "deposit returned at contract end", refundedAt: "2026-08-20" }, userId));
    expect(await bankGl(bankA) - bankBefore, "returned: the bank is whole").toBeCloseTo(0, 2);
  });

  it("🔴 an ERRONEOUS payment to a non-resident: NOT WHT (erroneous_payment), and it is recoverable", async () => {
    const pay = await inA(() => supplierPaymentsService.create({ vendorId: v.royal, bankAccountId: bankA, amount: 7_500, paidAt: "2026-08-09", classification: "erroneous" }, userId)) as { id: number };
    const [w] = await whtRowOfPayment(pay.id);
    expect([w.status, w.not_subject_reason, Number(w.wht_amount), w.payment_class]).toEqual(["not_subject", "erroneous_payment", 0, "erroneous"]);
    const r = await inA(() => supplierPaymentsService.refund(pay.id, { amount: 7_500, bankAccountId: bankA, reason: "paid to the wrong supplier", refundedAt: "2026-08-21" }, userId)) as { amount: number };
    expect(r.amount).toBe(7_500);
  });

  it("🔴 an UNIDENTIFIED payment to a non-resident: PENDING — nothing withheld, nothing claimed, listed; a nature declared on it is refused", async () => {
    const whtBefore = await glCredit(coA, "WHT_PAYABLE");
    const pay = await inA(() => supplierPaymentsService.create({ vendorId: v.royal, bankAccountId: bankA, amount: 9_000, paidAt: "2026-08-10" }, userId)) as { id: number };
    expect(await glCredit(coA, "WHT_PAYABLE")).toBe(whtBefore);
    const [w] = await whtRowOfPayment(pay.id);
    expect([w.status, w.payment_type, w.not_subject_reason, Number(w.rate), Number(w.wht_amount), w.payment_class]).toEqual(["pending", null, null, 0, 0, "unknown"]);
    const ret = await inA(() => whtService.monthlyReturn("2026-08"));
    expect(ret.pending.map((p) => p.id)).toContain(w.id);
    expect(ret.schedule.map((s) => s.id), "a pending payment is not on the return's schedule").not.toContain(w.id);
    expect(ret.pending.find((p) => p.id === w.id)!.determination.outcome).toBe("pending_classification");
    const ex = await inA(() => whtService.exceptions("pending_classification"));
    expect(ex.items.map((i) => i.paymentId)).toContain(pay.id);
    expect((await inA(() => whtService.overview())).exceptions.pendingClassification).toBe(ex.total);
    // 🔴 the system never pretends it is classified: a nature on an unidentified payment is refused, nothing posted
    const before = await entryCount();
    const e = await refusal(inA(() => supplierPaymentsService.create({ vendorId: v.royal, bankAccountId: bankA, amount: 500, paidAt: "2026-08-10", whtPaymentType: "royalty" }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([422, "wht_unidentified_payment_declared"]);
    expect(await entryCount()).toBe(before);
  });

  it("🔴 PENDING cannot silently become a tax: identifying it as a TAXABLE advance is refused by name (W-16); as goods or a deposit it is SUPERSEDED, the pending record kept beside it", async () => {
    const p1 = await inA(() => supplierPaymentsService.create({ vendorId: v.royal, bankAccountId: bankA, amount: 6_000, paidAt: "2026-08-11" }, userId)) as { id: number };
    const whtBefore = await glCredit(coA, "WHT_PAYABLE"), before = await entryCount();
    // as an advance with the supplier's royalty default: the late withholding is open — nothing changes
    const e = await refusal(inA(() => supplierPaymentsService.classify(p1.id, { classification: "advance" }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([409, "wht_late_withholding_open"]);
    expect(e.payload?.error).toMatch(/900\.00/); // 6,000 × 15 % — the exposure is named, not booked
    expect([await glCredit(coA, "WHT_PAYABLE"), await entryCount()]).toEqual([whtBefore, before]);
    expect((await rowsOf(`SELECT classification FROM supplier_payments WHERE id = $1`, [p1.id]))[0].classification).toBe("unknown");
    expect((await whtRowOfPayment(p1.id)).map((r) => r.status)).toEqual(["pending"]);
    // as an advance for GOODS: superseded — not subject, and the pending record stays (the lineage)
    await inA(() => supplierPaymentsService.classify(p1.id, { classification: "advance", whtNotSubjectReason: "goods" }, userId));
    const chain = await whtRowOfPayment(p1.id);
    expect(chain.map((r) => [r.status, r.not_subject_reason, r.payment_class, r.supersedes_withholding_id])).toEqual([
      ["pending", null, "unknown", null],
      ["not_subject", "goods", "advance", chain[0].id],
    ]);
    const ret = await inA(() => whtService.monthlyReturn("2026-08"));
    expect(ret.pending.map((p) => p.id), "the superseded pending record is no longer the payment's determination").not.toContain(chain[0].id);
    expect(ret.excluded.map((x) => x.id)).toContain(chain[1].id);
    // a second unidentified payment, identified as a deposit: superseded by refundable_deposit
    const p2 = await inA(() => supplierPaymentsService.create({ vendorId: v.royal, bankAccountId: bankA, amount: 2_500, paidAt: "2026-08-11" }, userId)) as { id: number };
    await inA(() => supplierPaymentsService.classify(p2.id, { classification: "security_deposit" }, userId));
    expect((await whtRowOfPayment(p2.id)).map((r) => [r.status, r.not_subject_reason])).toEqual([["pending", null], ["not_subject", "refundable_deposit"]]);
    expect(await glCredit(coA, "WHT_PAYABLE"), "no reclassification withheld anything").toBe(whtBefore);
  });

  it("🔴 a WITHHELD advance is never reclassified away from consideration — it is corrected instead", async () => {
    const p = await inA(() => supplierPaymentsService.create({ vendorId: v.royal, bankAccountId: bankA, amount: 1_000, paidAt: "2026-08-12", classification: "advance" }, userId)) as { id: number };
    expect(Number((await whtRowOfPayment(p.id))[0].wht_amount)).toBe(150);
    const e = await refusal(inA(() => supplierPaymentsService.classify(p.id, { classification: "security_deposit" }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([409, "wht_reclassify_withheld"]);
  });

  it("one payment, one purpose: settling bills AND leaving a deposit on account is refused for a non-resident (never a base split by guess)", async () => {
    const b = await bill(inA, v.royal!, 1_000);
    const e = await refusal(inA(() => supplierPaymentsService.create({ vendorId: v.royal, bankAccountId: bankA, amount: 3_000, paidAt: "2026-08-13", classification: "security_deposit", allocations: [{ billId: b, amount: 1_000 }] }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([422, "wht_mixed_payment_unsupported"]);
    // wholly allocated with the default 'unknown' classification: consideration, judged by its nature
    const p = await inA(() => supplierPaymentsService.create({ vendorId: v.royal, bankAccountId: bankA, amount: 1_000, paidAt: "2026-08-13", allocations: [{ billId: b, amount: 1_000 }] }, userId)) as { id: number };
    const [w] = await whtRowOfPayment(p.id);
    expect([w.status, w.payment_class, Number(w.wht_amount)]).toEqual(["withheld", "allocated", 150]);
  });

  it("🔴 nature alone never bypasses the RECIPIENT or the SOURCE: a royalty to a resident is refused as a declaration; a royalty whose income has no Kingdom source is NOT WHT, its nature kept", async () => {
    const r = await bill(inA, v.res!, 1_000);
    expect((await refusal(inA(() => billsService.pay(r, { amount: 1_000, paidAt: "2026-08-14", bankAccountId: bankA, whtPaymentType: "royalty" }, userId)))).payload?.code).toBe("wht_vendor_not_non_resident");
    const b = await bill(inA, v.consult!, 2_000);
    await inA(() => billsService.pay(b, { amount: 2_000, paidAt: "2026-08-14", bankAccountId: bankA, whtPaymentType: "royalty", whtNotSubjectReason: "not_kingdom_source", whtNotSubjectNote: "licence exploited wholly outside the Kingdom by the licensor" }, userId));
    const [w] = await rowsOf(`SELECT * FROM wht_withholdings WHERE bill_id = $1`, [b]);
    expect([w.status, w.not_subject_reason, w.payment_type, Number(w.wht_amount)]).toEqual(["not_subject", "not_kingdom_source", "royalty", 0]);
    const ret = await inA(() => whtService.monthlyReturn("2026-08"));
    expect(ret.excluded.find((x) => x.id === w.id)!.determination).toMatchObject({ outcome: "not_wht", kingdomSource: "declared_not_kingdom_source", paymentType: "royalty" });
    // a deposit reason is not declarable on consideration: it is a classification of the money, not a declaration
    const b2 = await bill(inA, v.consult!, 500);
    expect((await refusal(inA(() => billsService.pay(b2, { amount: 500, paidAt: "2026-08-14", bankAccountId: bankA, whtNotSubjectReason: "refundable_deposit" }, userId)))).payload?.code).toBe("wht_not_subject_reason_unknown");
  });

  it("🔴 EXEMPTION / RELIEF: an approved treaty relief at 0 % and one at a reduced rate are recorded as exempt_relief with both rates kept", async () => {
    for (const [rate, date] of [[0, "2026-08-15"], [0.02, "2026-08-16"]] as const) {
      const rel = await inA(() => whtService.createRelief({ vendorId: v.consult, paymentType: "technical_consulting", reducedRate: rate, treatyCountry: "GB", zatcaApprovalReference: `ZATCA-Q2-${rate}`, residencyCertificateReference: "HMRC-Q2", validFrom: date, validTo: date }, userId));
      await inA(() => whtService.approveRelief(rel.id, userId));
      const b = await bill(inA, v.consult!, 5_000);
      await inA(() => billsService.pay(b, { amount: 5_000, paidAt: date, bankAccountId: bankA, whtPaymentType: "technical_consulting" }, userId));
      const [w] = await rowsOf(`SELECT * FROM wht_withholdings WHERE bill_id = $1`, [b]);
      expect([Number(w.rate), Number(w.statutory_rate), Number(w.wht_amount), w.treaty_relief_id]).toEqual([rate, 0.05, rate * 5_000, rel.id]);
      const row = (await inA(() => whtService.monthlyReturn("2026-08"))).schedule.find((s) => s.id === w.id)!;
      expect([row.determination.outcome, row.determination.reasonCode]).toEqual(["exempt_relief", "treaty_relief"]);
    }
  });

  it("🔴 history is frozen: changing the supplier's default nature, revoking a relief and re-declaring residency later rewrite NOTHING on a posted payment", async () => {
    const before = await inA(() => whtService.monthlyReturn("2026-08"));
    const pick = (r: typeof before) => r.schedule.map((s) => [s.id, s.paymentType, s.rate, s.whtAmount, s.natureBasis, s.determination.outcome]);
    await pool.query(`UPDATE vendors SET wht_default_payment_type = 'management_fee' WHERE id = $1`, [v.royal]);
    const relief = (await rowsOf(`SELECT id FROM vendor_wht_treaty_reliefs WHERE company_id = $1 AND status = 'approved' ORDER BY id LIMIT 1`, [coA]))[0];
    await inA(() => whtService.revokeRelief(relief.id, { reason: "certificate withdrawn after payment" }, userId));
    await pool.query(`UPDATE vendors SET residency = 'resident' WHERE id = $1`, [v.consult]);
    const after = await inA(() => whtService.monthlyReturn("2026-08"));
    expect(pick(after)).toEqual(pick(before));
    expect(after.totals).toEqual(before.totals);
    await pool.query(`UPDATE vendors SET residency = 'non_resident', wht_default_payment_type = 'royalty' WHERE id IN ($1, $2)`, [v.consult, v.royal]);
    await pool.query(`UPDATE vendors SET wht_default_payment_type = NULL WHERE id = $1`, [v.consult]);
  });

  it("🔴 GL ↔ WHT ledger ↔ return: W1 exact; the return's tax = Σ withheld rows only (pending and not-subject add nothing)", async () => {
    const ov = await inA(() => whtService.overview());
    expect(ov.reconciliation.reconciles).toBe(true);
    expect(ov.reconciliation.glWhtPayable).toBe(await glCredit(coA, "WHT_PAYABLE"));
    const ret = await inA(() => whtService.monthlyReturn("2026-08"));
    const sum = (await rowsOf(`SELECT coalesce(sum(wht_amount),0)::text t FROM wht_withholdings WHERE company_id = $1 AND period = '2026-08' AND status = 'withheld'`, [coA]))[0].t;
    expect(ret.totals.taxWithheld).toBe(Number(sum));
    expect(ret.lines.reduce((s, l) => Math.round((s + l.taxWithheld) * 100) / 100, 0)).toBe(ret.totals.taxWithheld);
    expect(ret.pending.every((p) => p.whtAmount === 0) && ret.excluded.every((x) => x.whtAmount === 0)).toBe(true);
    expectConforms(GetWhtReturnResponse, ret, "GET /tax/wht/returns/:period (withheld, relief, not subject, pending, superseded)");
    expectConforms(GetWhtOverviewResponse, ov, "GET /tax/wht/overview");
    expectConforms(ListWhtExceptionsResponse, await inA(() => whtService.exceptions("pending_classification")), "GET /tax/wht/exceptions?kind=pending_classification");
  });

  it("🔴 the PREVIEW judges what the pay path will: a deposit, an erroneous, an unidentified, a mixed and an allocated payment", async () => {
    const pv = (q: Record<string, unknown>) => inA(() => whtService.preview({ vendorId: v.royal, amount: 1_000, date: "2026-08-20", ...q }));
    const dep = await pv({ classification: "security_deposit" });
    expect([dep.kind, dep.withheld, dep.notSubjectReason, dep.determination.outcome]).toEqual(["not_subject", 0, "refundable_deposit", "not_wht"]);
    expect((await pv({ classification: "erroneous" })).notSubjectReason).toBe("erroneous_payment");
    const unk = await pv({ classification: "unknown" });
    expect([unk.kind, unk.withheld, unk.determination.outcome]).toEqual(["pending", 0, "pending_classification"]);
    const adv = await pv({ classification: "advance" });
    expect([adv.kind, adv.withheld, adv.determination.natureBasis]).toEqual(["withheld", 150, "supplier_default"]);
    expect((await pv({ classification: "unknown", allocatedAmount: 1_000 })).withheld, "wholly allocated = consideration").toBe(150);
    expect((await refusal(pv({ classification: "security_deposit", allocatedAmount: 400 }))).payload?.code).toBe("wht_mixed_payment_unsupported");
    expect((await pv({})).determination.paymentClass, "no classification: a bill payment").toBe("bill_payment");
    for (const p of [dep, unk, adv]) expectConforms(PreviewWhtResponse, p, "GET /tax/wht/preview");
  });

  it("🔴 the DATABASE refuses what the service refuses: a withholding on a deposit, a tax on an unidentified payment, a superseding withholding, a row with no provenance", async () => {
    const p = await inA(() => supplierPaymentsService.create({ vendorId: v.royal, bankAccountId: bankA, amount: 4_000, paidAt: "2026-08-22", classification: "security_deposit" }, userId)) as { id: number };
    const [w] = await whtRowOfPayment(p.id);
    const rate = (await rowsOf(`SELECT id, rate::text FROM wht_rates WHERE payment_type = 'royalty' ORDER BY effective_from DESC LIMIT 1`, []))[0];
    const ins = (cols: Record<string, unknown>, q: (text: string, args: unknown[]) => Promise<unknown> = (t, a) => pool.query(t, a)) => q(
      `INSERT INTO wht_withholdings (organization_id, company_id, source_kind, supplier_payment_id, vendor_id, payment_date, period, status, payment_type, base_amount, rate, statutory_rate, rate_id, wht_amount, journal_entry_id, payment_class, nature_basis, supersedes_withholding_id, not_subject_reason)
       VALUES ($1,$2,'supplier_payment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [w.organization_id, w.company_id, p.id, w.vendor_id, w.payment_date, w.period, cols.status ?? "withheld", cols.payment_type === undefined ? "royalty" : cols.payment_type, w.base_amount,
        cols.rate ?? rate.rate, cols.statutory_rate === undefined ? rate.rate : cols.statutory_rate, cols.rate_id === undefined ? rate.id : cols.rate_id, cols.wht_amount ?? (Number(w.base_amount) * Number(rate.rate)).toFixed(2), w.journal_entry_id,
        cols.payment_class === undefined ? "security_deposit" : cols.payment_class, cols.nature_basis === undefined ? "supplier_default" : cols.nature_basis, cols.supersedes ?? w.id,
        cols.not_subject_reason ?? null]);
    // 🔴 a withholding superseding a deposit's record: the database names it late withholding (W-16)
    expect((await refusal(ins({})))?.constraint).toBe("wht_withholding_class");
    // even claiming the money was an advance (it is not — its classification says deposit)
    expect((await refusal(ins({ payment_class: "advance" })))?.constraint).toBe("wht_withholding_class");
    // no provenance at all
    expect((await refusal(ins({ payment_class: null, nature_basis: null })))?.constraint).toBe("wht_withholding_provenance");
    // the payment reclassified to an advance by a raw UPDATE: a superseding WITHHOLDING is still refused — late withholding
    await pool.query(`UPDATE supplier_payments SET classification = 'advance' WHERE id = $1`, [p.id]);
    expect((await refusal(ins({ payment_class: "advance" })))?.constraint).toBe("wht_late_withholding");
    await pool.query(`UPDATE supplier_payments SET classification = 'security_deposit' WHERE id = $1`, [p.id]);
    // the planted positive: the same insert shape, for the class the money IS, is admitted (then rolled back) —
    // so the refusals above are the guard's, not a broken statement's
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await ins({ status: "not_subject", payment_type: null, rate: "0", statutory_rate: null, rate_id: null, wht_amount: "0.00", payment_class: "security_deposit", nature_basis: "payment_class", not_subject_reason: "refundable_deposit" },
        (t, a) => c.query(t, a));
    } finally { await c.query("ROLLBACK"); c.release(); }
  });

  it("🔴 isolation — presence, absence, movement: another company and another organisation see none of A's pending or not-subject payments; C's own is C's", async () => {
    const aPending = (await inA(() => whtService.exceptions("pending_classification"))).total;
    expect(aPending).toBeGreaterThan(0);
    expect((await inB(() => whtService.exceptions("pending_classification"))).total).toBe(0);
    expect((await inB(() => whtService.monthlyReturn("2026-08"))).excluded).toEqual([]);
    expect((await inC(() => whtService.exceptions("pending_classification"))).total).toBe(0);
    const pc = await inC(() => supplierPaymentsService.create({ vendorId: v.royalC, bankAccountId: bankC, amount: 1_200, paidAt: "2026-08-23" }, userId)) as { id: number };
    expect((await inC(() => whtService.exceptions("pending_classification"))).items.map((i) => i.paymentId)).toEqual([pc.id]);
    expect((await inA(() => whtService.exceptions("pending_classification"))).items.map((i) => i.paymentId)).not.toContain(pc.id);
    // A cannot classify C's payment
    expect((await refusal(inA(() => supplierPaymentsService.classify(pc.id, { classification: "security_deposit" }, userId)))).statusCode).toBe(404);
  });
});
