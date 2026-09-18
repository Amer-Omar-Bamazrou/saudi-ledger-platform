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
} from "@workspace/db";
import { and, asc, desc, eq, sql, count } from "drizzle-orm";
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
