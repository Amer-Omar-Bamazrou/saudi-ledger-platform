/**
 * Phase 16 — every read and write of the tax tables
 * (docs/product/phase-16-17-tax-treasury-decision-pack.md). Tenant-scoped by
 * RLS AND, on every company-owned table, by `companyScoped` — the N1 seam, so
 * an org-wide connection reads NOTHING here rather than two companies' tax.
 *
 * WHT figures come from the WHT ledger (`wht_withholdings`, `wht_remittances`)
 * and the GL — never re-keyed. The opening (migrated) WHT payable and what is
 * still unremitted are read through `wht_unremitted()`, the ONE definition the
 * remittance trigger also uses.
 *
 * 🔴 POLICY C (openingReversal.ts): a reversed opening bill is history. The
 * exception lists and counts below read bill payments through
 * `billNotReversedSql` — the one predicate — so a payment can never surface on
 * a bill the migration reversed. (None can exist today: a batch reversal is
 * refused while any opening bill is paid, and no bill-payment reversal path
 * exists; the predicate makes that a property of the read, not of the
 * neighbourhood.) A withholding's own figures are the WHT ledger's; the bill is
 * joined there only for its number.
 */
import { and, asc, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import {
  db, vendorsTable, whtRatesTable, whtWithholdingsTable, vendorWhtTreatyReliefsTable, whtRemittancesTable, whtRemittanceReversalsTable,
  whtCorrectionsTable, whtReturnFilingsTable,
  zakatAccountClassificationsTable, taxComputationsTable, taxComputationVersionsTable, taxAdjustmentsTable,
  type TaxComputationVersion,
} from "@workspace/db";
import { companyScoped } from "./companyScope";
import { billNotReversedSql } from "./openingReversal";

/** The company GUC as a uuid — the same typed form as `companyScoped` (index-usable). */
const CO = sql.raw(`nullif(current_setting('app.current_company_id', true), '')::uuid`);

export type WithholdingRow = {
  id: number; source_kind: string; bill_payment_id: number | null; supplier_payment_id: number | null;
  vendor_id: number; vendor_name: string; vendor_name_ar: string | null; vendor_country: string | null; vendor_address: string | null; vendor_city: string | null;
  vendor_foreign_tax_id: string | null; bill_id: number | null; bill_number: string | null; supplier_payment_reference: string | null;
  payment_date: string; period: string; status: string; payment_type: string | null; not_subject_reason: string | null; not_subject_note: string | null;
  base_amount: string; rate: string; statutory_rate: string | null; treaty_relief_id: number | null; treaty_approval_reference: string | null;
  wht_amount: string; journal_entry_id: number; form_row: string | null; created_at: string;
  payment_class: string | null; nature_basis: string | null; supersedes_withholding_id: number | null;
  // Q1 (0117): the return month, the filed-month treatment, the correction this row re-enters, and its own correction
  return_period: string; filed_month_treatment: string | null; correction_id: number | null;
  corr_id: number | null; corr_corrected_on: string | null; corr_reason: string | null; corr_reversal_return_period: string | null;
  corr_filed_month_treatment: string | null; corr_reversal_entry_id: number | null; corr_corrected_withholding_id: number | null;
  corr_corrected_bill_payment_id: number | null; corr_corrected_supplier_payment_id: number | null;
};

/** A correction carried by a month's return whose original sits in ANOTHER month's return (subsequent-period, Q1). */
export type AdjustmentRow = {
  correction_id: number; withholding_id: number; corrected_on: string; reason: string; filed_month_treatment: string | null;
  original_return_period: string; payment_date: string; vendor_id: number; vendor_name: string; vendor_name_ar: string | null;
  payment_type: string | null; status: string; base_amount: string; wht_amount: string; reversal_journal_entry_id: number;
  corrected_withholding_id: number | null;
};

/**
 * Q2 (0116): a reclassification SUPERSEDES a payment's pending or not-subject
 * record; the replaced row stays (lineage) but is no longer the payment's
 * determination. Every list reads the live ones — one predicate, here.
 */
const LIVE_W = (alias: string) => sql.raw(`NOT EXISTS (SELECT 1 FROM wht_withholdings sup WHERE sup.supersedes_withholding_id = ${alias}.id)`);

export const taxRepository = {
  // ── rates ────────────────────────────────────────────────────────────────
  rates() {
    return db.select().from(whtRatesTable).orderBy(asc(whtRatesTable.formRow), asc(whtRatesTable.effectiveFrom));
  },

  // ── withholdings ─────────────────────────────────────────────────────────
  /**
   * Withholdings of this company, filtered by RETURN month (Q1: the month whose return carries them), payment month,
   * date window and/or supplier — one query shape for every report. Each row carries its own correction, if any.
   * `excludeCorrected`: the live facts only (the annual information, a beneficiary's statement) — a corrected row's
   * truth is its re-entry.
   */
  async withholdings(f: { returnPeriod?: string; period?: string; from?: string; to?: string; vendorId?: number; excludeCorrected?: boolean; id?: number }): Promise<WithholdingRow[]> {
    const { rows } = await db.execute<WithholdingRow>(sql`
      SELECT w.id, w.source_kind, w.bill_payment_id, w.supplier_payment_id,
             w.vendor_id, v.name AS vendor_name, v.name_ar AS vendor_name_ar, v.country AS vendor_country, v.address AS vendor_address, v.city AS vendor_city,
             v.foreign_tax_id AS vendor_foreign_tax_id, w.bill_id, b.bill_number, sp.reference AS supplier_payment_reference,
             w.payment_date::text AS payment_date, w.period, w.status, w.payment_type, w.not_subject_reason, w.not_subject_note,
             w.base_amount::text, w.rate::text, w.statutory_rate::text, w.treaty_relief_id, rel.zatca_approval_reference AS treaty_approval_reference,
             w.wht_amount::text, w.journal_entry_id, rt.form_row, w.created_at::text AS created_at,
             w.payment_class, w.nature_basis, w.supersedes_withholding_id,
             w.return_period, w.filed_month_treatment, w.correction_id,
             xc.id AS corr_id, xc.corrected_on::text AS corr_corrected_on, xc.reason AS corr_reason, xc.reversal_return_period AS corr_reversal_return_period,
             xc.filed_month_treatment AS corr_filed_month_treatment, xc.reversal_journal_entry_id AS corr_reversal_entry_id,
             (SELECT r.id FROM wht_withholdings r WHERE r.correction_id = xc.id) AS corr_corrected_withholding_id,
             xc.corrected_bill_payment_id AS corr_corrected_bill_payment_id, xc.corrected_supplier_payment_id AS corr_corrected_supplier_payment_id
        FROM wht_withholdings w
        JOIN vendors v ON v.id = w.vendor_id
        LEFT JOIN bills b ON b.id = w.bill_id
        LEFT JOIN supplier_payments sp ON sp.id = w.supplier_payment_id
        LEFT JOIN wht_rates rt ON rt.id = w.rate_id
        LEFT JOIN vendor_wht_treaty_reliefs rel ON rel.id = w.treaty_relief_id
        LEFT JOIN wht_corrections xc ON xc.withholding_id = w.id
       WHERE w.company_id = ${CO} AND ${LIVE_W("w")}
         ${f.id != null ? sql`AND w.id = ${f.id}` : sql``}
         ${f.returnPeriod ? sql`AND w.return_period = ${f.returnPeriod}` : sql``}
         ${f.excludeCorrected ? sql`AND xc.id IS NULL` : sql``}
         ${f.period ? sql`AND w.period = ${f.period}` : sql``}
         ${f.from ? sql`AND w.payment_date >= ${f.from}::date` : sql``}
         ${f.to ? sql`AND w.payment_date <= ${f.to}::date` : sql``}
         ${f.vendorId != null ? sql`AND w.vendor_id = ${f.vendorId}` : sql``}
       ORDER BY w.payment_date, w.id`);
    return rows;
  },

  /**
   * Per RETURN month (Q1): what its return carries — Σ withholdings reported in it − Σ the corrections whose reversal
   * it carries, the same arithmetic as `wht_return_tax()` (pinned by a test) — with the counts, the live remittances
   * and the latest filing. One row per month that has any of them (a filed nil month included).
   */
  async periods() {
    const { rows } = await db.execute<{
      period: string; withheld: string; base: string; payments: number; not_subject: number; pending: number; corrections: number;
      remitted: string; fines_paid: string; last_paid_at: string | null;
      filing_id: number | null; filing_kind: string | null; filed_on: string | null; filed_tax: string | null; filed_base: string | null; filings: number;
    }>(sql`
      WITH w AS (
        SELECT return_period AS period, sum(wht_amount) FILTER (WHERE status = 'withheld') AS withheld,
               sum(base_amount) FILTER (WHERE status = 'withheld') AS base,
               count(*) FILTER (WHERE status = 'withheld'
                 AND NOT EXISTS (SELECT 1 FROM wht_corrections c WHERE c.withholding_id = w.id AND c.reversal_return_period = w.return_period)) AS payments,
               count(*) FILTER (WHERE status = 'not_subject') AS not_subject,
               count(*) FILTER (WHERE status = 'pending') AS pending
          FROM wht_withholdings w WHERE company_id = ${CO} AND ${LIVE_W("w")} GROUP BY return_period),
      c AS (
        SELECT c.reversal_return_period AS period,
               sum(w.wht_amount) FILTER (WHERE w.status = 'withheld') AS withheld,
               sum(w.base_amount) FILTER (WHERE w.status = 'withheld') AS base,
               count(*) AS corrections
          FROM wht_corrections c JOIN wht_withholdings w ON w.id = c.withholding_id
         WHERE c.company_id = ${CO} GROUP BY c.reversal_return_period),
      r AS (
        SELECT r.period, sum(r.amount) AS remitted, sum(r.fine_amount) AS fines_paid, max(r.paid_at)::text AS last_paid_at
          FROM wht_remittances r
         WHERE r.company_id = ${CO} AND r.period IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM wht_remittance_reversals x WHERE x.remittance_id = r.id)
         GROUP BY r.period),
      f AS (
        SELECT DISTINCT ON (period) period, id, kind, filed_on::text AS filed_on, tax_withheld, payment_total,
               count(*) OVER (PARTITION BY period) AS filings
          FROM wht_return_filings WHERE company_id = ${CO} ORDER BY period, id DESC),
      months AS (SELECT period FROM w UNION SELECT period FROM c UNION SELECT period FROM r UNION SELECT period FROM f)
      SELECT m.period,
             (coalesce(w.withheld, 0) - coalesce(c.withheld, 0))::text AS withheld, (coalesce(w.base, 0) - coalesce(c.base, 0))::text AS base,
             coalesce(w.payments, 0)::int AS payments, coalesce(w.not_subject, 0)::int AS not_subject, coalesce(w.pending, 0)::int AS pending,
             coalesce(c.corrections, 0)::int AS corrections,
             coalesce(r.remitted, 0)::text AS remitted, coalesce(r.fines_paid, 0)::text AS fines_paid, r.last_paid_at,
             f.id AS filing_id, f.kind AS filing_kind, f.filed_on, f.tax_withheld::text AS filed_tax, f.payment_total::text AS filed_base, coalesce(f.filings, 0)::int AS filings
        FROM months m
        LEFT JOIN w ON w.period = m.period LEFT JOIN c ON c.period = m.period
        LEFT JOIN r ON r.period = m.period LEFT JOIN f ON f.period = m.period
       ORDER BY 1 DESC`);
    return rows;
  },

  /** The ledger's own figure of a month's return — `wht_return_tax/base()`, the remittance cap's and the filing snapshot's definition. */
  async returnFigures(period: string): Promise<{ tax: number; base: number }> {
    const { rows } = await db.execute<{ t: string; b: string }>(sql`SELECT wht_return_tax(${CO}, ${period})::text AS t, wht_return_base(${CO}, ${period})::text AS b`);
    return { tax: Number(rows[0]?.t ?? 0), base: Number(rows[0]?.b ?? 0) };
  },

  /** Corrections a month's return carries whose original is reported in ANOTHER month (the subsequent-period kind, Q1). */
  async adjustments(period: string): Promise<AdjustmentRow[]> {
    const { rows } = await db.execute<AdjustmentRow>(sql`
      SELECT c.id AS correction_id, w.id AS withholding_id, c.corrected_on::text AS corrected_on, c.reason, c.filed_month_treatment,
             w.return_period AS original_return_period, w.payment_date::text AS payment_date, w.vendor_id, v.name AS vendor_name, v.name_ar AS vendor_name_ar,
             w.payment_type, w.status, w.base_amount::text, w.wht_amount::text, c.reversal_journal_entry_id,
             (SELECT r.id FROM wht_withholdings r WHERE r.correction_id = c.id) AS corrected_withholding_id
        FROM wht_corrections c JOIN wht_withholdings w ON w.id = c.withholding_id JOIN vendors v ON v.id = w.vendor_id
       WHERE c.company_id = ${CO} AND c.reversal_return_period = ${period} AND w.return_period <> ${period}
       ORDER BY c.corrected_on, c.id`);
    return rows;
  },

  // ── Q1: corrections and filings ──────────────────────────────────────────
  async withholdingById(id: number) {
    const [row] = await db.select().from(whtWithholdingsTable).where(and(eq(whtWithholdingsTable.id, id), companyScoped(whtWithholdingsTable.companyId))).limit(1);
    return row ?? null;
  },
  /** The live record that supersedes this one, if a reclassification replaced it (Q2). */
  async supersedingOf(id: number) {
    const [row] = await db.select().from(whtWithholdingsTable).where(and(eq(whtWithholdingsTable.supersedesWithholdingId, id), companyScoped(whtWithholdingsTable.companyId))).limit(1);
    return row ?? null;
  },
  async correctionOf(withholdingId: number) {
    const [row] = await db.select().from(whtCorrectionsTable).where(and(eq(whtCorrectionsTable.withholdingId, withholdingId), companyScoped(whtCorrectionsTable.companyId))).limit(1);
    return row ?? null;
  },
  async correctionById(id: number) {
    const [row] = await db.select().from(whtCorrectionsTable).where(and(eq(whtCorrectionsTable.id, id), companyScoped(whtCorrectionsTable.companyId))).limit(1);
    return row ?? null;
  },
  async correctionByIdempotencyKey(key: string) {
    const [row] = await db.select().from(whtCorrectionsTable).where(and(eq(whtCorrectionsTable.idempotencyKey, key), companyScoped(whtCorrectionsTable.companyId))).limit(1);
    return row ?? null;
  },
  /** The re-entry withholding of a correction, if its payment withheld (or was recorded not subject / pending). */
  async reentryOf(correctionId: number) {
    const [row] = await db.select().from(whtWithholdingsTable).where(and(eq(whtWithholdingsTable.correctionId, correctionId), companyScoped(whtWithholdingsTable.companyId))).limit(1);
    return row ?? null;
  },
  insertCorrection(values: typeof whtCorrectionsTable.$inferInsert) {
    return db.insert(whtCorrectionsTable).values(values).returning();
  },
  /** The ONE write after insert: the link to the re-entry, once (the guard trigger admits nothing else). */
  linkCorrection(id: number, link: { correctedBillPaymentId: number } | { correctedSupplierPaymentId: number }) {
    return db.update(whtCorrectionsTable).set(link).where(and(eq(whtCorrectionsTable.id, id), companyScoped(whtCorrectionsTable.companyId))).returning();
  },
  /** Corrections of these bill payments (one read for a payment history). */
  correctionsForBillPayments(billPaymentIds: number[]) {
    if (billPaymentIds.length === 0) return Promise.resolve([] as (typeof whtCorrectionsTable.$inferSelect)[]);
    return db.select().from(whtCorrectionsTable)
      .where(and(inArray(whtCorrectionsTable.billPaymentId, billPaymentIds), companyScoped(whtCorrectionsTable.companyId)));
  },
  correctionsForSupplierPayments(supplierPaymentIds: number[]) {
    if (supplierPaymentIds.length === 0) return Promise.resolve([] as (typeof whtCorrectionsTable.$inferSelect)[]);
    return db.select().from(whtCorrectionsTable)
      .where(and(inArray(whtCorrectionsTable.supplierPaymentId, supplierPaymentIds), companyScoped(whtCorrectionsTable.companyId)));
  },
  /** A bill payment of THIS company with its bill's numbers — the correction's read. */
  async billPaymentById(id: number) {
    const { rows } = await db.execute<{ id: number; bill_id: number; amount: string; paid_at: string; bank_account_id: number | null; journal_entry_id: number | null; bill_number: string; vendor_id: number | null }>(sql`
      SELECT bp.id, bp.bill_id, bp.amount::text, bp.paid_at::text AS paid_at, bp.bank_account_id, bp.journal_entry_id, b.bill_number, b.vendor_id
        FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id
       WHERE bp.id = ${id} AND bp.company_id = ${CO}`);
    return rows[0] ?? null;
  },
  /**
   * What has touched a supplier payment since its own entry — each a reason the mirror of that entry would no longer
   * restore the payment's effect exactly (Q1: refused, never approximated): an allocation made later (live or since
   * reversed), one of its own allocations already reversed, a refund, a reclassification that moved its balance, a
   * supplier advance invoice against it.
   */
  async supplierPaymentTouches(paymentId: number, journalEntryId: number): Promise<string[]> {
    const { rows } = await db.execute<{ later_allocs: number; own_reversed: number; refunds: number; reclass_entries: number; advance_invoices: number }>(sql`
      SELECT (SELECT count(*)::int FROM supplier_payment_allocations a WHERE a.supplier_payment_id = ${paymentId} AND a.journal_entry_id IS DISTINCT FROM ${journalEntryId}) AS later_allocs,
             (SELECT count(*)::int FROM supplier_payment_allocations a JOIN supplier_payment_allocation_reversals r ON r.allocation_id = a.id
               WHERE a.supplier_payment_id = ${paymentId} AND a.journal_entry_id = ${journalEntryId}) AS own_reversed,
             (SELECT count(*)::int FROM supplier_refunds f WHERE f.supplier_payment_id = ${paymentId}) AS refunds,
             (SELECT count(*)::int FROM supplier_payment_classifications c WHERE c.supplier_payment_id = ${paymentId} AND c.journal_entry_id IS NOT NULL) AS reclass_entries,
             (SELECT count(*)::int FROM bills ai WHERE ai.advance_supplier_payment_id = ${paymentId}) AS advance_invoices`);
    const r = rows[0]!;
    const out: string[] = [];
    if (r.later_allocs > 0) out.push(`${r.later_allocs} later allocation(s) to bills (reverse them first)`);
    if (r.own_reversed > 0) out.push(`${r.own_reversed} of its own allocation(s) already reversed`);
    if (r.refunds > 0) out.push(`${r.refunds} refund(s) from the supplier`);
    if (r.reclass_entries > 0) out.push(`${r.reclass_entries} reclassification(s) that moved its balance between accounts (reclassify it back first)`);
    if (r.advance_invoices > 0) out.push(`${r.advance_invoices} supplier advance invoice(s) against it`);
    return out;
  },
  /** The allocations a supplier payment's OWN entry made (the correction supersedes them with its mirror). */
  async ownAllocations(paymentId: number, journalEntryId: number) {
    const { rows } = await db.execute<{ id: number; bill_id: number; amount: string }>(sql`
      SELECT a.id, a.bill_id, a.amount::text FROM supplier_payment_allocations a
       WHERE a.supplier_payment_id = ${paymentId} AND a.journal_entry_id = ${journalEntryId} AND a.company_id = ${CO} ORDER BY a.id`);
    return rows;
  },
  /** Payment plans this bill payment paid (Phase 17) — named on the correction so the plan's history is read with it. */
  async plansPaidBy(billPaymentId: number) {
    const { rows } = await db.execute<{ id: number }>(sql`SELECT id FROM scheduled_payments WHERE paid_bill_payment_id = ${billPaymentId} AND company_id = ${CO}`);
    return rows.map((r) => Number(r.id));
  },

  filings(period: string) {
    return db.select().from(whtReturnFilingsTable)
      .where(and(companyScoped(whtReturnFilingsTable.companyId), eq(whtReturnFilingsTable.period, period)))
      .orderBy(asc(whtReturnFilingsTable.id));
  },
  insertFiling(values: typeof whtReturnFilingsTable.$inferInsert) {
    return db.insert(whtReturnFilingsTable).values(values).returning();
  },

  /** What a month (or, with NULL, the migrated opening balance) still owes — the remittance trigger's own definition. */
  async unremitted(period: string | null): Promise<number> {
    const { rows } = await db.execute<{ v: string }>(sql`SELECT wht_unremitted(${CO}, ${period})::text AS v`);
    return Number(rows[0]?.v ?? 0);
  },

  /** The migrated opening WHT payable (credit-positive) — 0 for a company that brought none. */
  async openingBalance(): Promise<number> {
    const { rows } = await db.execute<{ v: string }>(sql`
      SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text AS v
        FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
       WHERE e.company_id = ${CO} AND c.system_code = 'WHT_PAYABLE' AND e.status IN ('posted', 'reversed')
         AND e.source IN ('opening', 'opening_reversal', 'opening_correction')`);
    return Number(rows[0]?.v ?? 0);
  },

  /** GL WHT_PAYABLE for this company, credit-positive, entries in the books, optionally as of a date — invariant W1's left side. */
  async glPayable(asOf?: string): Promise<number> {
    const { rows } = await db.execute<{ v: string }>(sql`
      SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text AS v
        FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
       WHERE e.company_id = ${CO} AND c.system_code = 'WHT_PAYABLE' AND e.status IN ('posted', 'reversed')
         ${asOf ? sql`AND e.date::date <= ${asOf}::date` : sql``}`);
    return Number(rows[0]?.v ?? 0);
  },

  /** The withholdings recorded on these bill payments (one read for a payment history). */
  withholdingsForBillPayments(billPaymentIds: number[]) {
    if (billPaymentIds.length === 0) return Promise.resolve([] as (typeof whtWithholdingsTable.$inferSelect)[]);
    return db.select().from(whtWithholdingsTable)
      .where(and(inArray(whtWithholdingsTable.billPaymentId, billPaymentIds), companyScoped(whtWithholdingsTable.companyId)));
  },

  // ── remittances ──────────────────────────────────────────────────────────
  async remittances(period?: string | null) {
    const { rows } = await db.execute<{
      id: number; period: string | null; amount: string; fine_amount: string; paid_at: string; bank_account_id: number; bank_name: string;
      reference: string | null; notes: string | null; journal_entry_id: number; created_at: string;
      reversal_id: number | null; reversal_reason: string | null; reversed_on: string | null; reversal_entry_id: number | null;
    }>(sql`
      SELECT r.id, r.period, r.amount::text, r.fine_amount::text, r.paid_at::text AS paid_at, r.bank_account_id, b.name AS bank_name,
             r.reference, r.notes, r.journal_entry_id, r.created_at::text AS created_at,
             x.id AS reversal_id, x.reason AS reversal_reason, x.reversed_on::text AS reversed_on, x.journal_entry_id AS reversal_entry_id
        FROM wht_remittances r
        JOIN bank_accounts b ON b.id = r.bank_account_id
        LEFT JOIN wht_remittance_reversals x ON x.remittance_id = r.id
       WHERE r.company_id = ${CO}
         ${period === undefined ? sql`` : period === null ? sql`AND r.period IS NULL` : sql`AND r.period = ${period}`}
       ORDER BY r.paid_at DESC, r.id DESC`);
    return rows;
  },
  async remittanceById(id: number, opts: { lock?: boolean } = {}) {
    const q = db.select().from(whtRemittancesTable).where(and(eq(whtRemittancesTable.id, id), companyScoped(whtRemittancesTable.companyId))).limit(1);
    const [row] = opts.lock ? await q.for("update") : await q;
    return row ?? null;
  },
  async remittanceByIdempotencyKey(key: string) {
    const [row] = await db.select().from(whtRemittancesTable)
      .where(and(eq(whtRemittancesTable.idempotencyKey, key), companyScoped(whtRemittancesTable.companyId))).limit(1);
    return row ?? null;
  },
  async reversalOf(remittanceId: number) {
    const [row] = await db.select().from(whtRemittanceReversalsTable).where(eq(whtRemittanceReversalsTable.remittanceId, remittanceId)).limit(1);
    return row ?? null;
  },
  insertRemittance(values: typeof whtRemittancesTable.$inferInsert) {
    return db.insert(whtRemittancesTable).values(values).returning();
  },
  insertRemittanceReversal(values: typeof whtRemittanceReversalsTable.$inferInsert) {
    return db.insert(whtRemittanceReversalsTable).values(values).returning();
  },

  // ── exceptions: who finds out (pack §2.3) ──────────────────────────────
  /**
   * Supplier payments the WHT rule could not judge or may have missed, each
   * list capped at 200 and carrying its TRUE total:
   *  · `undeclared` — paid to a supplier whose residency is `unknown`;
   *  · `possibly_missed` — paid to a supplier NOW declared non-resident with no
   *    withholding record (declared after the payment, or paid before Phase 16).
   */
  async exceptions(kind: "undeclared" | "possibly_missed") {
    const residency = kind === "undeclared" ? "unknown" : "non_resident";
    const { rows } = await db.execute<{
      source_kind: string; payment_id: number; vendor_id: number; vendor_name: string; document: string | null;
      paid_at: string; amount: string; journal_entry_id: number | null; total: number;
    }>(sql`
      WITH p AS (
        SELECT 'bill_payment'::text AS source_kind, bp.id AS payment_id, b.vendor_id, b.bill_number AS document,
               bp.paid_at::text AS paid_at, bp.amount::text AS amount, bp.journal_entry_id
          FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id JOIN vendors v ON v.id = b.vendor_id
         WHERE bp.company_id = ${CO} AND v.residency = ${residency} AND bp.backfilled = false
           AND ${billNotReversedSql("b")}
           AND NOT EXISTS (SELECT 1 FROM wht_withholdings w WHERE w.bill_payment_id = bp.id)
        UNION ALL
        SELECT 'supplier_payment', sp.id, sp.vendor_id, coalesce(sp.reference, 'SPAY-' || sp.id::text),
               sp.paid_at::text, sp.amount::text, sp.journal_entry_id
          FROM supplier_payments sp JOIN vendors v ON v.id = sp.vendor_id
         WHERE sp.company_id = ${CO} AND v.residency = ${residency} AND sp.source = 'manual'
           AND NOT EXISTS (SELECT 1 FROM wht_withholdings w WHERE w.supplier_payment_id = sp.id))
      SELECT p.*, v.name AS vendor_name, (count(*) OVER ())::int AS total
        FROM p JOIN vendors v ON v.id = p.vendor_id
       ORDER BY p.paid_at DESC, p.payment_id DESC
       LIMIT 200`);
    return rows;
  },
  /**
   * Q2: payments to a non-resident recorded PENDING — money whose purpose
   * nobody has identified, so nothing was withheld or claimed for it. Listed
   * (capped at 200, with the true total) until a classification supersedes it.
   */
  async pendingClassification() {
    const { rows } = await db.execute<{
      source_kind: string; payment_id: number; vendor_id: number; vendor_name: string; document: string | null;
      paid_at: string; amount: string; journal_entry_id: number | null; total: number;
    }>(sql`
      SELECT w.source_kind, w.supplier_payment_id AS payment_id, w.vendor_id, v.name AS vendor_name,
             coalesce(sp.reference, 'SPAY-' || sp.id::text) AS document, w.payment_date::text AS paid_at,
             w.base_amount::text AS amount, w.journal_entry_id, (count(*) OVER ())::int AS total
        FROM wht_withholdings w JOIN vendors v ON v.id = w.vendor_id JOIN supplier_payments sp ON sp.id = w.supplier_payment_id
       WHERE w.company_id = ${CO} AND w.status = 'pending' AND ${LIVE_W("w")}
       ORDER BY w.payment_date DESC, w.id DESC
       LIMIT 200`);
    return rows;
  },
  /** Bill payments to a bill with no supplier record — nobody's residency is known. Count only. */
  async paymentsWithoutVendor(): Promise<number> {
    const { rows } = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id
       WHERE bp.company_id = ${CO} AND b.vendor_id IS NULL AND bp.backfilled = false AND ${billNotReversedSql("b")}`);
    return Number(rows[0]?.n ?? 0);
  },

  // ── treaty reliefs ───────────────────────────────────────────────────────
  /** Reliefs of this company with their supplier's name (one read — a list naming suppliers by id would describe nothing). */
  reliefs(f: { vendorId?: number; id?: number } = {}) {
    return db.select({ ...getTableColumns(vendorWhtTreatyReliefsTable), vendorName: vendorsTable.name, vendorNameAr: vendorsTable.nameAr })
      .from(vendorWhtTreatyReliefsTable)
      .leftJoin(vendorsTable, eq(vendorsTable.id, vendorWhtTreatyReliefsTable.vendorId))
      .where(and(
        companyScoped(vendorWhtTreatyReliefsTable.companyId),
        f.vendorId != null ? eq(vendorWhtTreatyReliefsTable.vendorId, f.vendorId) : undefined,
        f.id != null ? eq(vendorWhtTreatyReliefsTable.id, f.id) : undefined,
      ))
      .orderBy(desc(vendorWhtTreatyReliefsTable.validFrom), desc(vendorWhtTreatyReliefsTable.id));
  },
  async reliefById(id: number, opts: { lock?: boolean } = {}) {
    const q = db.select().from(vendorWhtTreatyReliefsTable).where(and(eq(vendorWhtTreatyReliefsTable.id, id), companyScoped(vendorWhtTreatyReliefsTable.companyId))).limit(1);
    const [row] = opts.lock ? await q.for("update") : await q;
    return row ?? null;
  },
  insertRelief(values: typeof vendorWhtTreatyReliefsTable.$inferInsert) {
    return db.insert(vendorWhtTreatyReliefsTable).values(values).returning();
  },
  updateRelief(id: number, values: Partial<typeof vendorWhtTreatyReliefsTable.$inferInsert>) {
    return db.update(vendorWhtTreatyReliefsTable).set(values).where(and(eq(vendorWhtTreatyReliefsTable.id, id), companyScoped(vendorWhtTreatyReliefsTable.companyId))).returning();
  },
  deleteRelief(id: number) {
    return db.delete(vendorWhtTreatyReliefsTable).where(and(eq(vendorWhtTreatyReliefsTable.id, id), companyScoped(vendorWhtTreatyReliefsTable.companyId)));
  },

  // ── Zakat classification (org-level: the chart is) ─────────────────────
  /**
   * Of the given accounts, those carrying at least one line in this company's books. A NON-POSTING
   * account normally has none (its sub-accounts do) — but the `CASH` header still carries pre-D-3
   * history until the per-company cut-over runs (CLAUDE.md §5), and that balance must be classifiable.
   */
  async accountsCarryingLines(accountIds: number[]): Promise<Set<number>> {
    if (accountIds.length === 0) return new Set();
    const { rows } = await db.execute<{ id: number }>(sql`
      SELECT DISTINCT l.account_id AS id FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
       WHERE e.company_id = ${CO} AND e.status IN ('posted', 'reversed')
         AND l.account_id IN (${sql.join(accountIds.map((i) => sql`${i}`), sql`, `)})`);
    return new Set(rows.map((r) => Number(r.id)));
  },
  classifications() {
    return db.select().from(zakatAccountClassificationsTable);
  },
  async upsertClassification(accountId: number, classification: string, basisNote: string | null, userId: number | null) {
    const [existing] = await db.select().from(zakatAccountClassificationsTable).where(eq(zakatAccountClassificationsTable.accountId, accountId)).limit(1);
    if (existing) {
      const [row] = await db.update(zakatAccountClassificationsTable)
        .set({ classification, basisNote, confirmedBy: userId, confirmedAt: new Date() })
        .where(eq(zakatAccountClassificationsTable.id, existing.id)).returning();
      return { before: existing, after: row! };
    }
    const [row] = await db.insert(zakatAccountClassificationsTable).values({ accountId, classification, basisNote, confirmedBy: userId }).returning();
    return { before: null, after: row! };
  },
  async deleteClassification(accountId: number) {
    const [existing] = await db.select().from(zakatAccountClassificationsTable).where(eq(zakatAccountClassificationsTable.accountId, accountId)).limit(1);
    if (!existing) return null;
    await db.delete(zakatAccountClassificationsTable).where(eq(zakatAccountClassificationsTable.id, existing.id));
    return existing;
  },

  // ── computations ─────────────────────────────────────────────────────────
  computations(kind?: string) {
    return db.select().from(taxComputationsTable)
      .where(and(companyScoped(taxComputationsTable.companyId), kind ? eq(taxComputationsTable.kind, kind) : undefined))
      .orderBy(desc(taxComputationsTable.fiscalYearStart), desc(taxComputationsTable.id));
  },
  async computationById(id: number) {
    const [row] = await db.select().from(taxComputationsTable).where(and(eq(taxComputationsTable.id, id), companyScoped(taxComputationsTable.companyId))).limit(1);
    return row ?? null;
  },
  insertComputation(values: typeof taxComputationsTable.$inferInsert) {
    return db.insert(taxComputationsTable).values(values).returning();
  },
  updateComputation(id: number, values: Partial<typeof taxComputationsTable.$inferInsert>) {
    return db.update(taxComputationsTable).set(values).where(and(eq(taxComputationsTable.id, id), companyScoped(taxComputationsTable.companyId))).returning();
  },
  deleteComputation(id: number) {
    return db.delete(taxComputationsTable).where(and(eq(taxComputationsTable.id, id), companyScoped(taxComputationsTable.companyId)));
  },
  versionsOf(computationIds: number[]): Promise<TaxComputationVersion[]> {
    if (computationIds.length === 0) return Promise.resolve([]);
    return db.select().from(taxComputationVersionsTable)
      .where(and(inArray(taxComputationVersionsTable.computationId, computationIds), companyScoped(taxComputationVersionsTable.companyId)))
      .orderBy(asc(taxComputationVersionsTable.versionNo));
  },
  /** The version, locked for the transaction (every transition and adjustment write serialises on it). */
  async lockVersion(id: number) {
    const [row] = await db.select().from(taxComputationVersionsTable)
      .where(and(eq(taxComputationVersionsTable.id, id), companyScoped(taxComputationVersionsTable.companyId))).limit(1).for("update");
    return row ?? null;
  },
  insertVersion(values: typeof taxComputationVersionsTable.$inferInsert) {
    return db.insert(taxComputationVersionsTable).values(values).returning();
  },
  updateVersion(id: number, values: Partial<typeof taxComputationVersionsTable.$inferInsert>) {
    return db.update(taxComputationVersionsTable).set(values).where(and(eq(taxComputationVersionsTable.id, id), companyScoped(taxComputationVersionsTable.companyId))).returning();
  },
  deleteVersion(id: number) {
    return db.delete(taxComputationVersionsTable).where(and(eq(taxComputationVersionsTable.id, id), companyScoped(taxComputationVersionsTable.companyId)));
  },
  async nextVersionNo(computationId: number): Promise<number> {
    const { rows } = await db.execute<{ n: number }>(sql`SELECT coalesce(max(version_no), 0)::int + 1 AS n FROM tax_computation_versions WHERE computation_id = ${computationId} AND company_id = ${CO}`);
    return Number(rows[0]?.n ?? 1);
  },
  /** Σ what earlier APPROVED-at-the-time versions of a computation accrued (signed) — the base of the next difference. */
  async accruedSoFar(computationId: number): Promise<number> {
    const { rows } = await db.execute<{ v: string }>(sql`
      SELECT coalesce(sum(accrued_amount), 0)::text AS v FROM tax_computation_versions
       WHERE computation_id = ${computationId} AND company_id = ${CO} AND status IN ('approved', 'superseded')`);
    return Number(rows[0]?.v ?? 0);
  },
  /** The entries a computation's approvals posted — excluded from that computation's own inputs (pack §3.4, Z-3). */
  async accrualEntryIds(computationId: number): Promise<number[]> {
    const { rows } = await db.execute<{ id: number }>(sql`
      SELECT accrual_journal_entry_id AS id FROM tax_computation_versions
       WHERE computation_id = ${computationId} AND company_id = ${CO} AND accrual_journal_entry_id IS NOT NULL`);
    return rows.map((r) => Number(r.id));
  },

  // ── adjustments ──────────────────────────────────────────────────────────
  adjustmentsOf(versionId: number) {
    return db.select().from(taxAdjustmentsTable)
      .where(and(eq(taxAdjustmentsTable.versionId, versionId), companyScoped(taxAdjustmentsTable.companyId)))
      .orderBy(asc(taxAdjustmentsTable.id));
  },
  async adjustmentById(id: number) {
    const [row] = await db.select().from(taxAdjustmentsTable).where(and(eq(taxAdjustmentsTable.id, id), companyScoped(taxAdjustmentsTable.companyId))).limit(1);
    return row ?? null;
  },
  insertAdjustment(values: typeof taxAdjustmentsTable.$inferInsert) {
    return db.insert(taxAdjustmentsTable).values(values).returning();
  },
  updateAdjustment(id: number, values: Partial<typeof taxAdjustmentsTable.$inferInsert>) {
    return db.update(taxAdjustmentsTable).set(values).where(and(eq(taxAdjustmentsTable.id, id), companyScoped(taxAdjustmentsTable.companyId))).returning();
  },
  deleteAdjustment(id: number) {
    return db.delete(taxAdjustmentsTable).where(and(eq(taxAdjustmentsTable.id, id), companyScoped(taxAdjustmentsTable.companyId)));
  },
  /** Copy an approved version's adjustments into a revision draft (the database admits them only while it is a draft). */
  async copyAdjustments(fromVersionId: number, toVersionId: number) {
    await db.execute(sql`
      INSERT INTO tax_adjustments (organization_id, company_id, version_id, target, effect, amount, reason, legal_reference, source_reference, account_id, created_by)
      SELECT organization_id, company_id, ${toVersionId}, target, effect, amount, reason, legal_reference, source_reference, account_id, created_by
        FROM tax_adjustments WHERE version_id = ${fromVersionId} AND company_id = ${CO} ORDER BY id`);
  },

  /**
   * Movement of the given system-coded accounts over a window, in the books,
   * this company — debit-positive, EXCLUDING the listed entries (a
   * computation's own accruals). The book-to-tax bridge's GL reads.
   */
  async movementBySystemCode(codes: string[], from: string, to: string, excludeEntryIds: number[] = []) {
    if (codes.length === 0) return new Map<string, number>();
    const { rows } = await db.execute<{ code: string; v: string }>(sql`
      SELECT c.system_code AS code, coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v
        FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
       WHERE e.company_id = ${CO} AND e.status IN ('posted', 'reversed')
         AND e.date::date >= ${from}::date AND e.date::date <= ${to}::date
         AND c.system_code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})
         ${excludeEntryIds.length ? sql`AND e.id NOT IN (${sql.join(excludeEntryIds.map((i) => sql`${i}`), sql`, `)})` : sql``}
       GROUP BY c.system_code`);
    return new Map(rows.map((r) => [r.code, Number(r.v)]));
  },

  /** Per account, the net movement of the listed entries up to a date (debit-positive) — what to take OUT of the inputs (Z-3). */
  async entryEffects(entryIds: number[], upTo: string) {
    if (entryIds.length === 0) return [];
    const { rows } = await db.execute<{ account_id: number; v: string }>(sql`
      SELECT l.account_id, coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v
        FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
       WHERE e.company_id = ${CO} AND e.status IN ('posted', 'reversed') AND e.date::date <= ${upTo}::date
         AND e.id IN (${sql.join(entryIds.map((i) => sql`${i}`), sql`, `)})
       GROUP BY l.account_id`);
    return rows.map((r) => ({ accountId: Number(r.account_id), debitPositive: Number(r.v) }));
  },
};
