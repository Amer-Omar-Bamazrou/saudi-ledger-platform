/**
 * Batch 1C — the migration's reads and writes. Every query runs inside the
 * tenant transaction (RLS scopes the organisation); the company arm is stated
 * on every batch read as well (N1: the query layer says what RLS says).
 *
 * Immutability after commit is a DATABASE trigger (migration 0077); this
 * repository never tries to be the guard.
 */
import {
  db,
  migrationBatchesTable,
  migrationChartRowsTable,
  migrationPartiesTable,
  migrationOpenItemsTable,
  migrationAdvancesTable,
  categoriesTable,
  bankAccountsTable,
  customersTable,
  vendorsTable,
  invoicesTable,
  billsTable,
  companiesTable,
  journalEntriesTable,
  journalEntryLinesTable,
  paymentsTable,
  periodLocksTable,
} from "@workspace/db";
import { JE_IN_BOOKS } from "./reports.repository";
import { and, asc, desc, eq, sql, count, inArray } from "drizzle-orm";
import { companyScoped } from "./companyScope";

export const migrationRepository = {
  // ── batches ──
  insertBatch(values: typeof migrationBatchesTable.$inferInsert) {
    return db.insert(migrationBatchesTable).values(values).returning();
  },
  findBatch(id: number) {
    return db.select().from(migrationBatchesTable).where(and(eq(migrationBatchesTable.id, id), companyScoped(migrationBatchesTable.companyId))).limit(1);
  },
  listBatches() {
    return db.select().from(migrationBatchesTable).where(companyScoped(migrationBatchesTable.companyId)).orderBy(desc(migrationBatchesTable.id));
  },
  findBatchByIdempotencyKey(key: string) {
    return db.select().from(migrationBatchesTable).where(and(eq(migrationBatchesTable.idempotencyKey, key), companyScoped(migrationBatchesTable.companyId))).limit(1);
  },
  findLiveBatch() {
    return db.select().from(migrationBatchesTable).where(and(eq(migrationBatchesTable.status, "committed"), companyScoped(migrationBatchesTable.companyId))).limit(1);
  },
  updateBatch(id: number, values: Partial<typeof migrationBatchesTable.$inferInsert>) {
    return db.update(migrationBatchesTable).set({ ...values, updatedAt: new Date() }).where(eq(migrationBatchesTable.id, id)).returning();
  },
  async counts(batchId: number) {
    const [c] = await db.select({ n: count() }).from(migrationChartRowsTable).where(eq(migrationChartRowsTable.batchId, batchId));
    const [u] = await db.select({ n: count() }).from(migrationChartRowsTable).where(and(eq(migrationChartRowsTable.batchId, batchId), sql`${migrationChartRowsTable.decision} IS NULL`));
    const [p] = await db.select({ n: count() }).from(migrationPartiesTable).where(eq(migrationPartiesTable.batchId, batchId));
    const [o] = await db.select({ n: count() }).from(migrationOpenItemsTable).where(eq(migrationOpenItemsTable.batchId, batchId));
    const [a] = await db.select({ n: count() }).from(migrationAdvancesTable).where(eq(migrationAdvancesTable.batchId, batchId));
    return { chartRows: Number(c?.n ?? 0), chartRowsUnmapped: Number(u?.n ?? 0), parties: Number(p?.n ?? 0), openItems: Number(o?.n ?? 0), advances: Number(a?.n ?? 0) };
  },

  // ── chart rows ──
  chartRows(batchId: number) {
    return db.select().from(migrationChartRowsTable).where(eq(migrationChartRowsTable.batchId, batchId)).orderBy(asc(migrationChartRowsTable.sourceCode), asc(migrationChartRowsTable.id));
  },
  findChartRow(batchId: number, rowId: number) {
    return db.select().from(migrationChartRowsTable).where(and(eq(migrationChartRowsTable.batchId, batchId), eq(migrationChartRowsTable.id, rowId))).limit(1);
  },
  deleteChartRows(batchId: number) {
    return db.delete(migrationChartRowsTable).where(eq(migrationChartRowsTable.batchId, batchId));
  },
  insertChartRows(values: (typeof migrationChartRowsTable.$inferInsert)[]) {
    if (values.length === 0) return Promise.resolve([]);
    return db.insert(migrationChartRowsTable).values(values).returning();
  },
  updateChartRow(rowId: number, values: Partial<typeof migrationChartRowsTable.$inferInsert>) {
    return db.update(migrationChartRowsTable).set(values).where(eq(migrationChartRowsTable.id, rowId)).returning();
  },

  // ── parties / open items / advances (Phase 2) ──
  parties(batchId: number) {
    return db.select().from(migrationPartiesTable).where(eq(migrationPartiesTable.batchId, batchId)).orderBy(asc(migrationPartiesTable.partyType), asc(migrationPartiesTable.sourceId), asc(migrationPartiesTable.id));
  },
  findParty(batchId: number, rowId: number) {
    return db.select().from(migrationPartiesTable).where(and(eq(migrationPartiesTable.batchId, batchId), eq(migrationPartiesTable.id, rowId))).limit(1);
  },
  deleteParties(batchId: number) {
    return db.delete(migrationPartiesTable).where(eq(migrationPartiesTable.batchId, batchId));
  },
  insertParties(values: (typeof migrationPartiesTable.$inferInsert)[]) {
    if (values.length === 0) return Promise.resolve([]);
    return db.insert(migrationPartiesTable).values(values).returning();
  },
  updateParty(rowId: number, values: Partial<typeof migrationPartiesTable.$inferInsert>) {
    return db.update(migrationPartiesTable).set(values).where(eq(migrationPartiesTable.id, rowId)).returning();
  },
  openItems(batchId: number) {
    return db.select().from(migrationOpenItemsTable).where(eq(migrationOpenItemsTable.batchId, batchId)).orderBy(asc(migrationOpenItemsTable.itemType), asc(migrationOpenItemsTable.partySourceId), asc(migrationOpenItemsTable.issueDate), asc(migrationOpenItemsTable.id));
  },
  deleteOpenItems(batchId: number) {
    return db.delete(migrationOpenItemsTable).where(eq(migrationOpenItemsTable.batchId, batchId));
  },
  insertOpenItems(values: (typeof migrationOpenItemsTable.$inferInsert)[]) {
    if (values.length === 0) return Promise.resolve([]);
    return db.insert(migrationOpenItemsTable).values(values).returning();
  },
  advances(batchId: number) {
    return db.select().from(migrationAdvancesTable).where(eq(migrationAdvancesTable.batchId, batchId)).orderBy(asc(migrationAdvancesTable.partySourceId), asc(migrationAdvancesTable.receivedAt), asc(migrationAdvancesTable.id));
  },
  deleteAdvances(batchId: number) {
    return db.delete(migrationAdvancesTable).where(eq(migrationAdvancesTable.batchId, batchId));
  },
  insertAdvances(values: (typeof migrationAdvancesTable.$inferInsert)[]) {
    if (values.length === 0) return Promise.resolve([]);
    return db.insert(migrationAdvancesTable).values(values).returning();
  },

  // ── the existing records a party may be (RLS-scoped: this organisation only) ──
  customersByIds(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([] as (typeof customersTable.$inferSelect)[]);
    return db.select().from(customersTable).where(inArray(customersTable.id, ids));
  },
  vendorsByIds(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([] as (typeof vendorsTable.$inferSelect)[]);
    return db.select().from(vendorsTable).where(inArray(vendorsTable.id, ids));
  },
  /** Likely duplicates: the same VAT number, or the same name (case-insensitive, trimmed). */
  customerCandidates(taxNumbers: string[], names: string[]) {
    if (taxNumbers.length === 0 && names.length === 0) return Promise.resolve([] as (typeof customersTable.$inferSelect)[]);
    const byTax = taxNumbers.length ? inArray(customersTable.taxNumber, taxNumbers) : sql`false`;
    const byName = names.length ? inArray(sql`lower(trim(${customersTable.name}))`, names) : sql`false`;
    return db.select().from(customersTable).where(sql`(${byTax}) OR (${byName})`);
  },
  vendorCandidates(taxNumbers: string[], names: string[]) {
    if (taxNumbers.length === 0 && names.length === 0) return Promise.resolve([] as (typeof vendorsTable.$inferSelect)[]);
    const byTax = taxNumbers.length ? inArray(vendorsTable.taxNumber, taxNumbers) : sql`false`;
    const byName = names.length ? inArray(sql`lower(trim(${vendorsTable.name}))`, names) : sql`false`;
    return db.select().from(vendorsTable).where(sql`(${byTax}) OR (${byName})`);
  },
  /** Document numbers already taken in this company — an opening item keeps its original number and must not collide. */
  async takenInvoiceNumbers(numbers: string[]) {
    if (numbers.length === 0) return new Set<string>();
    const rows = await db.select({ n: invoicesTable.invoiceNumber }).from(invoicesTable).where(and(companyScoped(invoicesTable.companyId), inArray(invoicesTable.invoiceNumber, numbers)));
    return new Set(rows.map((r) => r.n));
  },
  async takenBillNumbers(numbers: string[]) {
    if (numbers.length === 0) return new Set<string>();
    const rows = await db.select({ n: billsTable.billNumber }).from(billsTable).where(and(companyScoped(billsTable.companyId), inArray(billsTable.billNumber, numbers)));
    return new Set(rows.map((r) => r.n));
  },
  bankAccountsByIds(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([] as (typeof bankAccountsTable.$inferSelect)[]);
    return db.select().from(bankAccountsTable).where(inArray(bankAccountsTable.id, ids));
  },
  bankLeaves(bankIds: number[]) {
    if (bankIds.length === 0) return Promise.resolve([] as (typeof categoriesTable.$inferSelect)[]);
    return db.select().from(categoriesTable).where(inArray(categoriesTable.bankAccountId, bankIds));
  },
  categoriesByIds(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([] as (typeof categoriesTable.$inferSelect)[]);
    return db.select().from(categoriesTable).where(inArray(categoriesTable.id, ids));
  },
  systemCategories(codes: string[]) {
    if (codes.length === 0) return Promise.resolve([] as (typeof categoriesTable.$inferSelect)[]);
    return db.select().from(categoriesTable).where(inArray(categoriesTable.systemCode, codes));
  },
  /** The batch's company — its fiscal-year declaration decides what the P&L rows may say (A2). */
  company(companyId: string) {
    return db.select().from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
  },

  // ── Phase 3: commit, reconciliation read-backs, reversal ──
  /** The batch row, locked: two commits (or a commit and a reversal) of one batch serialise here. */
  findBatchForUpdate(id: number) {
    return db.select().from(migrationBatchesTable).where(and(eq(migrationBatchesTable.id, id), companyScoped(migrationBatchesTable.companyId))).for("update").limit(1);
  },
  updateOpenItem(rowId: number, values: Partial<typeof migrationOpenItemsTable.$inferInsert>) {
    return db.update(migrationOpenItemsTable).set(values).where(eq(migrationOpenItemsTable.id, rowId)).returning();
  },
  updateAdvance(rowId: number, values: Partial<typeof migrationAdvancesTable.$inferInsert>) {
    return db.update(migrationAdvancesTable).set(values).where(eq(migrationAdvancesTable.id, rowId)).returning();
  },
  customersBySourceIdentity(sourceSystem: string, sourceIds: string[]) {
    if (sourceIds.length === 0) return Promise.resolve([] as (typeof customersTable.$inferSelect)[]);
    return db.select().from(customersTable).where(and(eq(customersTable.sourceSystem, sourceSystem), inArray(customersTable.sourceId, sourceIds)));
  },
  vendorsBySourceIdentity(sourceSystem: string, sourceIds: string[]) {
    if (sourceIds.length === 0) return Promise.resolve([] as (typeof vendorsTable.$inferSelect)[]);
    return db.select().from(vendorsTable).where(and(eq(vendorsTable.sourceSystem, sourceSystem), inArray(vendorsTable.sourceId, sourceIds)));
  },
  categoriesByAccountCodes(codes: string[]) {
    if (codes.length === 0) return Promise.resolve([] as (typeof categoriesTable.$inferSelect)[]);
    return db.select().from(categoriesTable).where(inArray(categoriesTable.accountCode, codes));
  },
  insertInvoice(values: typeof invoicesTable.$inferInsert) {
    return db.insert(invoicesTable).values(values).returning();
  },
  insertBill(values: typeof billsTable.$inferInsert) {
    return db.insert(billsTable).values(values).returning();
  },
  insertPayment(values: typeof paymentsTable.$inferInsert) {
    return db.insert(paymentsTable).values(values).returning();
  },
  updateBankAccount(id: number, values: Partial<typeof bankAccountsTable.$inferInsert>) {
    return db.update(bankAccountsTable).set(values).where(eq(bankAccountsTable.id, id)).returning();
  },
  updateCategory(id: number, values: Partial<typeof categoriesTable.$inferInsert>) {
    return db.update(categoriesTable).set(values).where(eq(categoriesTable.id, id)).returning();
  },
  journalEntry(id: number) {
    return db.select().from(journalEntriesTable).where(and(eq(journalEntriesTable.id, id), companyScoped(journalEntriesTable.companyId))).limit(1);
  },
  journalLines(journalEntryId: number) {
    return db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.journalEntryId, journalEntryId)).orderBy(asc(journalEntryLinesTable.id));
  },
  markJournalReversed(id: number) {
    return db.update(journalEntriesTable).set({ status: "reversed" }).where(eq(journalEntriesTable.id, id)).returning();
  },
  /**
   * In-books journal lines of this company dated on or before `date` — the
   * ledger must be EMPTY before an opening position is posted on it. A
   * reversed migration's own pair (opening + its mirror, netting to zero) is
   * not history: it is excluded so a corrected re-run can post.
   */
  async inBooksLinesUpTo(date: string) {
    const [row] = await db
      .select({ n: count(), debit: sql<string>`coalesce(sum(${journalEntryLinesTable.debitAmount}::numeric), 0)::text`, credit: sql<string>`coalesce(sum(${journalEntryLinesTable.creditAmount}::numeric), 0)::text` })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntriesTable.id, journalEntryLinesTable.journalEntryId))
      .where(and(inArray(journalEntriesTable.status, [...JE_IN_BOOKS]), companyScoped(journalEntriesTable.companyId), sql`${journalEntriesTable.date} <= ${date}`, sql`${journalEntriesTable.source} IS DISTINCT FROM 'opening' AND ${journalEntriesTable.source} IS DISTINCT FROM 'opening_reversal'`));
    return { lines: Number(row?.n ?? 0), debit: Number(row?.debit ?? 0), credit: Number(row?.credit ?? 0) };
  },
  /** Ledger read-back: balance per account (Dr - Cr) over in-books entries dated on or before `date`. */
  async ledgerBalancesUpTo(date: string) {
    const rows = await db
      .select({
        accountId: journalEntryLinesTable.accountId,
        systemCode: categoriesTable.systemCode,
        type: categoriesTable.type,
        bankAccountId: categoriesTable.bankAccountId,
        balance: sql<string>`sum(${journalEntryLinesTable.debitAmount}::numeric - ${journalEntryLinesTable.creditAmount}::numeric)::text`,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntriesTable.id, journalEntryLinesTable.journalEntryId))
      .innerJoin(categoriesTable, eq(categoriesTable.id, journalEntryLinesTable.accountId))
      .where(and(inArray(journalEntriesTable.status, [...JE_IN_BOOKS]), companyScoped(journalEntriesTable.companyId), sql`${journalEntriesTable.date} <= ${date}`))
      .groupBy(journalEntryLinesTable.accountId, categoriesTable.systemCode, categoriesTable.type, categoriesTable.bankAccountId);
    return rows.map((r) => ({ accountId: r.accountId!, systemCode: r.systemCode, type: r.type, bankAccountId: r.bankAccountId, balance: Number(r.balance) }));
  },
  /** Ledger read-back per PARTY on one system account (AR / AP / CUSTOMER_DEPOSITS), in-books, dated on or before `date`. */
  async ledgerPartyBalancesUpTo(systemCode: string, date: string) {
    const rows = await db
      .select({
        customerId: journalEntryLinesTable.customerId,
        vendorId: journalEntryLinesTable.vendorId,
        balance: sql<string>`sum(${journalEntryLinesTable.debitAmount}::numeric - ${journalEntryLinesTable.creditAmount}::numeric)::text`,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntriesTable.id, journalEntryLinesTable.journalEntryId))
      .innerJoin(categoriesTable, eq(categoriesTable.id, journalEntryLinesTable.accountId))
      .where(and(inArray(journalEntriesTable.status, [...JE_IN_BOOKS]), companyScoped(journalEntriesTable.companyId), eq(categoriesTable.systemCode, systemCode), sql`${journalEntriesTable.date} <= ${date}`))
      .groupBy(journalEntryLinesTable.customerId, journalEntryLinesTable.vendorId);
    return rows.map((r) => ({ customerId: r.customerId, vendorId: r.vendorId, balance: Number(r.balance) }));
  },
  /** The opening subledger rows this batch created, as the ledger's own tables hold them. */
  openingInvoices(batchId: number) {
    return db
      .select({ inv: invoicesTable, itemId: migrationOpenItemsTable.id })
      .from(invoicesTable)
      .innerJoin(migrationOpenItemsTable, eq(migrationOpenItemsTable.id, invoicesTable.migrationOpenItemId))
      .where(and(eq(migrationOpenItemsTable.batchId, batchId), companyScoped(invoicesTable.companyId)));
  },
  openingBills(batchId: number) {
    return db
      .select({ bill: billsTable, itemId: migrationOpenItemsTable.id })
      .from(billsTable)
      .innerJoin(migrationOpenItemsTable, eq(migrationOpenItemsTable.id, billsTable.migrationOpenItemId))
      .where(and(eq(migrationOpenItemsTable.batchId, batchId), companyScoped(billsTable.companyId)));
  },
  openingPayments(batchId: number) {
    return db
      .select({ pay: paymentsTable, advanceId: migrationAdvancesTable.id })
      .from(paymentsTable)
      .innerJoin(migrationAdvancesTable, eq(migrationAdvancesTable.id, paymentsTable.migrationAdvanceId))
      .where(and(eq(migrationAdvancesTable.batchId, batchId), companyScoped(paymentsTable.companyId)));
  },
  /** What has touched the opening subledger rows since commit: the reversal refuses while any of it exists. */
  async touchesSinceCommit(invoiceIds: number[], billIds: number[], paymentIds: number[]) {
    const out: string[] = [];
    const list = (ids: number[]) => sql.join(ids.map((x) => sql`${x}`), sql`, `);
    if (invoiceIds.length > 0) {
      const inv = await db.execute(sql`
        SELECT i.invoice_number AS n,
               (SELECT count(*) FROM payment_allocations a WHERE a.invoice_id = i.id) AS allocs,
               (SELECT count(*) FROM invoices c WHERE c.original_invoice_id = i.id) AS notes,
               coalesce(i.paid_amount::numeric, 0) AS paid, coalesce(i.credited_amount::numeric, 0) AS credited
          FROM invoices i WHERE i.id IN (${list(invoiceIds)})`);
      for (const r of inv.rows as { n: string; allocs: string; notes: string; paid: string; credited: string }[]) {
        if (Number(r.allocs) > 0 || Number(r.notes) > 0 || Number(r.paid) > 0 || Number(r.credited) > 0) out.push(`invoice ${r.n} (allocations ${r.allocs}, credit notes ${r.notes}, paid ${r.paid}, credited ${r.credited})`);
      }
    }
    if (billIds.length > 0) {
      const b = await db.execute(sql`SELECT bill_number AS n, coalesce(paid_amount::numeric, 0) AS paid FROM bills WHERE id IN (${list(billIds)})`);
      for (const r of b.rows as { n: string; paid: string }[]) if (Number(r.paid) > 0) out.push(`bill ${r.n} (paid ${r.paid})`);
    }
    if (paymentIds.length > 0) {
      const p = await db.execute(sql`
        SELECT p.id, p.reference,
               (SELECT count(*) FROM payment_allocations a WHERE a.payment_id = p.id) AS allocs,
               (SELECT count(*) FROM customer_refunds f WHERE f.payment_id = p.id) AS refunds
          FROM payments p WHERE p.id IN (${list(paymentIds)})`);
      for (const r of p.rows as { id: number; reference: string | null; allocs: string; refunds: string }[]) {
        if (Number(r.allocs) > 0 || Number(r.refunds) > 0) out.push(`deposit #${r.id}${r.reference ? ` (${r.reference})` : ""} (allocations ${r.allocs}, refunds ${r.refunds})`);
      }
    }
    return out;
  },
  deleteInvoices(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return db.delete(invoicesTable).where(inArray(invoicesTable.id, ids)).returning({ id: invoicesTable.id });
  },
  deleteBills(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return db.delete(billsTable).where(inArray(billsTable.id, ids)).returning({ id: billsTable.id });
  },
  deletePayments(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return db.delete(paymentsTable).where(inArray(paymentsTable.id, ids)).returning({ id: paymentsTable.id });
  },
  /** R7: the e-invoice / line rows an opening item must NOT have. */
  async einvoiceTraces(invoiceIds: number[]) {
    if (invoiceIds.length === 0) return { einvoiceDocuments: 0, lineItems: 0 };
    const ids = sql.join(invoiceIds.map((x) => sql`${x}`), sql`, `);
    const d = await db.execute(sql`SELECT count(*)::int AS n FROM einvoice_documents WHERE invoice_id IN (${ids})`);
    const l = await db.execute(sql`SELECT count(*)::int AS n FROM invoice_items WHERE invoice_id IN (${ids})`);
    return { einvoiceDocuments: Number((d.rows[0] as { n: number })?.n ?? 0), lineItems: Number((l.rows[0] as { n: number })?.n ?? 0) };
  },
  periodLock(id: number) {
    return db.select().from(periodLocksTable).where(eq(periodLocksTable.id, id)).limit(1);
  },
  periodLockByPeriod(period: string) {
    return db.select().from(periodLocksTable).where(and(eq(periodLocksTable.period, period), companyScoped(periodLocksTable.companyId))).limit(1);
  },

  // ── lookups the mapping validates against (all RLS-scoped) ──
  findCategory(id: number) {
    return db.select().from(categoriesTable).where(eq(categoriesTable.id, id)).limit(1);
  },
  findSystemCategory(code: string) {
    return db.select().from(categoriesTable).where(eq(categoriesTable.systemCode, code)).limit(1);
  },
  findBankAccount(id: number) {
    return db.select().from(bankAccountsTable).where(eq(bankAccountsTable.id, id)).limit(1);
  },
  bankLeaf(bankAccountId: number) {
    return db.select().from(categoriesTable).where(eq(categoriesTable.bankAccountId, bankAccountId)).limit(1);
  },
};
