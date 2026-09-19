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
} from "@workspace/db";
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
