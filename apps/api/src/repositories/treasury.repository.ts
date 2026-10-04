/**
 * Phase 17 — Treasury reads and writes (docs/product/phase-16-17-tax-treasury-decision-pack.md §8).
 *
 * 🔴 CASH IS READ, NEVER STORED. The position is the ledger through the view
 * `journal_line_bank_identity` (D-3: every cash-class line, with the bank it
 * names — a leaf, an attribution, or NULL for pre-D-3 history still on the
 * CASH header), entries in the books, dated on or before the date. The other
 * tables here hold only what a person decided about the future.
 *
 * Every company-owned read is scoped with the N1 typed predicate.
 *
 * 🔴 POLICY C (openingReversal.ts): a reversed opening bill is history — it
 * owes nothing and nothing acts on it. A plan whose bill the migration
 * reversed is read with `bill_reversed` (the one predicate, negated) and an
 * outstanding of 0, so no list or forecast shows it as money still owed.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db, treasurySettingsTable, scheduledPaymentsTable, treasuryForecastEntriesTable, recurringRulesTable } from "@workspace/db";
import { companyScoped } from "./companyScope";
import { billOutstandingSql } from "./billPosition";
import { billNotReversedSql, invoiceNotReversedSql } from "./openingReversal";

const CO = sql.raw(`nullif(current_setting('app.current_company_id', true), '')::uuid`);

export const treasuryRepository = {
  // ── cash: the ledger ────────────────────────────────────────────────────
  /**
   * Cash as of a date, per bank, ONE read: Σ (debit − credit) of every cash-
   * class line in the books dated ≤ the date, grouped by the bank the view
   * names — `bank_account_id` NULL is the history not attributed to a bank.
   */
  async cashByBank(asOf: string) {
    const { rows } = await db.execute<{ bank_account_id: number | null; balance: string; lines: number }>(sql`
      SELECT v.bank_account_id, sum(v.debit_amount - v.credit_amount)::text AS balance, count(*)::int AS lines
        FROM journal_line_bank_identity v
        JOIN journal_entries e ON e.id = v.journal_entry_id
       WHERE e.company_id = ${CO} AND e.status IN ('posted', 'reversed') AND e.date::date <= ${asOf}::date
       GROUP BY v.bank_account_id`);
    return rows;
  },
  /** This company's bank accounts, with the latest statement closing balance dated ≤ the date and the reconciled-through date. */
  async banks(asOf: string) {
    const { rows } = await db.execute<{
      id: number; name: string; bank_name: string | null; currency: string; is_active: boolean;
      statement_id: number | null; statement_to: string | null; statement_closing: string | null; reconciled_through: string | null;
    }>(sql`
      SELECT b.id, b.name, b.bank_name, b.currency, b.is_active,
             s.id AS statement_id, s.period_to::text AS statement_to, s.closing_balance::text AS statement_closing,
             (SELECT max(r.as_of)::text FROM bank_reconciliations r WHERE r.bank_account_id = b.id
                 AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_reopenings o WHERE o.reconciliation_id = r.id)) AS reconciled_through
        FROM bank_accounts b
        LEFT JOIN LATERAL (
          SELECT bs.id, bs.period_to, bs.closing_balance FROM bank_statements bs
           WHERE bs.bank_account_id = b.id AND bs.closing_balance IS NOT NULL AND bs.period_to <= ${asOf}::date
           ORDER BY bs.period_to DESC, bs.id DESC LIMIT 1) s ON true
       WHERE b.company_id = ${CO}
       ORDER BY b.is_active DESC, b.name`);
    return rows;
  },

  // ── settings ─────────────────────────────────────────────────────────────
  async settings() {
    const [row] = await db.select().from(treasurySettingsTable).where(companyScoped(treasurySettingsTable.companyId)).limit(1);
    return row ?? null;
  },
  async upsertSettings(values: { minimumCashBalance: string | null; forecastHorizonWeeks: number; updatedBy: number | null }) {
    const existing = await this.settings();
    if (existing) {
      const [row] = await db.update(treasurySettingsTable).set({ ...values, updatedAt: new Date() })
        .where(and(eq(treasurySettingsTable.id, existing.id), companyScoped(treasurySettingsTable.companyId))).returning();
      return { before: existing, after: row! };
    }
    const [row] = await db.insert(treasurySettingsTable).values(values).returning();
    return { before: null, after: row! };
  },

  // ── payment plans ────────────────────────────────────────────────────────
  /** Plans with their bill, supplier and what the bill still owes NOW (`billPosition`; 0 for a reversed opening bill). */
  async plans(f: { status?: string[]; billId?: number; id?: number } = {}) {
    const { rows } = await db.execute<{
      id: number; bill_id: number; bill_number: string | null; vendor_id: number | null; vendor_name: string | null; vendor_name_ar: string | null;
      vendor_residency: string | null; bill_due_date: string | null; bill_date: string; bill_outstanding: string; bill_reversed: boolean;
      planned_date: string; amount: string; bank_account_id: number | null; bank_name: string | null; priority: string; status: string;
      wht_payment_type: string | null; notes: string | null; created_by: number | null; created_at: string;
      approved_by: number | null; approved_at: string | null; paid_bill_payment_id: number | null; paid_by: number | null; paid_at: string | null;
      cancelled_by: number | null; cancelled_at: string | null; cancel_reason: string | null; paid_wht: string | null;
    }>(sql`
      SELECT p.id, p.bill_id, b.bill_number, b.vendor_id, v.name AS vendor_name, v.name_ar AS vendor_name_ar, v.residency AS vendor_residency,
             nullif(b.due_date::text, '') AS bill_due_date, b.date::date::text AS bill_date,
             (CASE WHEN ${billNotReversedSql("b")} THEN ${billOutstandingSql("b")} ELSE 0 END)::text AS bill_outstanding,
             NOT (${billNotReversedSql("b")}) AS bill_reversed,
             p.planned_date::text AS planned_date, p.amount::text, p.bank_account_id, ba.name AS bank_name, p.priority, p.status,
             p.wht_payment_type, p.notes, p.created_by, p.created_at::text AS created_at,
             p.approved_by, p.approved_at::text AS approved_at, p.paid_bill_payment_id, p.paid_by, p.paid_at::text AS paid_at,
             p.cancelled_by, p.cancelled_at::text AS cancelled_at, p.cancel_reason,
             w.wht_amount::text AS paid_wht
        FROM scheduled_payments p
        JOIN bills b ON b.id = p.bill_id
        LEFT JOIN vendors v ON v.id = b.vendor_id
        LEFT JOIN bank_accounts ba ON ba.id = p.bank_account_id
        -- a paid plan's withholding AS RECORDED by its payment (one row per bill payment — wht_withholdings_bill_payment_unq)
        LEFT JOIN wht_withholdings w ON w.bill_payment_id = p.paid_bill_payment_id
       WHERE p.company_id = ${CO}
         ${f.status?.length ? sql`AND p.status IN (${sql.join(f.status.map((s) => sql`${s}`), sql`, `)})` : sql``}
         ${f.billId != null ? sql`AND p.bill_id = ${f.billId}` : sql``}
         ${f.id != null ? sql`AND p.id = ${f.id}` : sql``}
       ORDER BY p.planned_date, CASE p.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, p.id`);
    return rows;
  },
  async planById(id: number, opts: { lock?: boolean } = {}) {
    const q = db.select().from(scheduledPaymentsTable).where(and(eq(scheduledPaymentsTable.id, id), companyScoped(scheduledPaymentsTable.companyId))).limit(1);
    const [row] = opts.lock ? await q.for("update") : await q;
    return row ?? null;
  },
  /** Σ the OPEN plans (planned + approved) of a bill, optionally excluding one — under the bill's row lock in the caller. */
  async openPlannedFor(billId: number, excludeId?: number): Promise<number> {
    const { rows } = await db.execute<{ v: string }>(sql`
      SELECT coalesce(sum(amount), 0)::text AS v FROM scheduled_payments
       WHERE bill_id = ${billId} AND company_id = ${CO} AND status IN ('planned', 'approved')
         ${excludeId != null ? sql`AND id <> ${excludeId}` : sql``}`);
    return Number(rows[0]?.v ?? 0);
  },
  insertPlan(values: typeof scheduledPaymentsTable.$inferInsert) {
    return db.insert(scheduledPaymentsTable).values(values).returning();
  },
  updatePlan(id: number, values: Partial<typeof scheduledPaymentsTable.$inferInsert>) {
    return db.update(scheduledPaymentsTable).set(values).where(and(eq(scheduledPaymentsTable.id, id), companyScoped(scheduledPaymentsTable.companyId))).returning();
  },
  deletePlan(id: number) {
    return db.delete(scheduledPaymentsTable).where(and(eq(scheduledPaymentsTable.id, id), companyScoped(scheduledPaymentsTable.companyId)));
  },

  // ── manual assumptions ───────────────────────────────────────────────────
  entries(f: { from?: string; to?: string } = {}) {
    return db.select().from(treasuryForecastEntriesTable)
      .where(and(
        companyScoped(treasuryForecastEntriesTable.companyId),
        f.from ? sql`${treasuryForecastEntriesTable.entryDate} >= ${f.from}` : undefined,
        f.to ? sql`${treasuryForecastEntriesTable.entryDate} <= ${f.to}` : undefined,
      ))
      .orderBy(asc(treasuryForecastEntriesTable.entryDate), asc(treasuryForecastEntriesTable.id));
  },
  async entryById(id: number) {
    const [row] = await db.select().from(treasuryForecastEntriesTable)
      .where(and(eq(treasuryForecastEntriesTable.id, id), companyScoped(treasuryForecastEntriesTable.companyId))).limit(1);
    return row ?? null;
  },
  insertEntry(values: typeof treasuryForecastEntriesTable.$inferInsert) {
    return db.insert(treasuryForecastEntriesTable).values(values).returning();
  },
  updateEntry(id: number, values: Partial<typeof treasuryForecastEntriesTable.$inferInsert>) {
    return db.update(treasuryForecastEntriesTable).set(values)
      .where(and(eq(treasuryForecastEntriesTable.id, id), companyScoped(treasuryForecastEntriesTable.companyId))).returning();
  },
  deleteEntry(id: number) {
    return db.delete(treasuryForecastEntriesTable).where(and(eq(treasuryForecastEntriesTable.id, id), companyScoped(treasuryForecastEntriesTable.companyId)));
  },

  // ── recurring rules: the FORECAST basis ──────────────────────────────────
  /**
   * Active invoice/bill rules of this company, each with the total of the LAST
   * document it generated (the forecast's amount basis — never re-derived from
   * the template, which would be a second definition of a document's total),
   * and its party's payment terms.
   */
  async recurringBases() {
    const { rows } = await db.execute<{
      id: string; entity: string; frequency: string; day_of_month: number; next_run_on: string; ends_on: string | null;
      last_document_id: number | null; last_total: string | null; last_number: string | null; party_name: string | null; payment_terms_days: string | null;
    }>(sql`
      SELECT r.id, r.entity, r.frequency, r.day_of_month, r.next_run_on::text AS next_run_on, r.ends_on::text AS ends_on,
             lr.document_id AS last_document_id,
             CASE r.entity WHEN 'invoice' THEN i.total::text WHEN 'bill' THEN b.total::text END AS last_total,
             CASE r.entity WHEN 'invoice' THEN i.invoice_number WHEN 'bill' THEN b.bill_number END AS last_number,
             CASE r.entity WHEN 'invoice' THEN cu.name WHEN 'bill' THEN ve.name END AS party_name,
             CASE r.entity WHEN 'invoice' THEN cu.payment_terms_days WHEN 'bill' THEN ve.payment_terms_days END AS payment_terms_days
        FROM recurring_rules r
        LEFT JOIN LATERAL (
          SELECT rr.document_id FROM recurring_runs rr
           WHERE rr.rule_id = r.id AND rr.outcome = 'generated' AND rr.document_id IS NOT NULL
           ORDER BY rr.scheduled_for DESC LIMIT 1) lr ON true
        LEFT JOIN invoices i ON r.entity = 'invoice' AND i.id = lr.document_id AND ${invoiceNotReversedSql("i")}
        LEFT JOIN bills b ON r.entity = 'bill' AND b.id = lr.document_id AND ${billNotReversedSql("b")}
        LEFT JOIN customers cu ON cu.id = i.customer_id
        LEFT JOIN vendors ve ON ve.id = b.vendor_id
       WHERE r.company_id = ${CO} AND r.status = 'active' AND r.entity IN ('invoice', 'bill')
       ORDER BY r.next_run_on`);
    return rows;
  },
  /** Journal-entry rules are counted, never projected (they carry no cash meaning). */
  async journalRuleCount(): Promise<number> {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(recurringRulesTable)
      .where(and(companyScoped(recurringRulesTable.companyId), eq(recurringRulesTable.status, "active"), eq(recurringRulesTable.entity, "journal_entry")));
    return Number(row?.n ?? 0);
  },
  /** Bills by id for the plan lifecycle (with the bill's own row lock, so a plan and a payment cannot race). */
  async lockBill(billId: number) {
    const { rows } = await db.execute<{ id: number; status: string; document_type: string; vendor_id: number | null; bill_number: string | null; currency: string | null; reversed_at: string | null }>(sql`
      SELECT id, status, document_type, vendor_id, bill_number, currency, reversed_at::text AS reversed_at FROM bills WHERE id = ${billId} AND company_id = ${CO} FOR UPDATE`);
    return rows[0] ?? null;
  },
};

export type PlanRow = Awaited<ReturnType<typeof treasuryRepository.plans>>[number];
