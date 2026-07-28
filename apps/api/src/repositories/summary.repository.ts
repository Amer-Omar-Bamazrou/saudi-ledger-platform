/** Summary/analytics repository — read-only aggregations, tenant-scoped via RLS. */
import { db, transactionsTable, categoriesTable } from "@workspace/db";
import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";

export interface DateRange {
  dateFrom?: string | null;
  dateTo?: string | null;
}

export const summaryRepository = {
  summaryRows(range: DateRange) {
    const conditions = [];
    if (range.dateFrom) conditions.push(gte(transactionsTable.date, range.dateFrom));
    if (range.dateTo) conditions.push(lte(transactionsTable.date, range.dateTo));
    return db
      .select({
        type: transactionsTable.type,
        amount: transactionsTable.amount,
        vatAmount: transactionsTable.vatAmount,
        categoryId: transactionsTable.categoryId,
      })
      .from(transactionsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
  },

  vatRows(range: DateRange) {
    const conditions = [isNotNull(transactionsTable.vatAmount)];
    if (range.dateFrom) conditions.push(gte(transactionsTable.date, range.dateFrom));
    if (range.dateTo) conditions.push(lte(transactionsTable.date, range.dateTo));
    return db.select().from(transactionsTable).where(and(...conditions)).orderBy(transactionsTable.date);
  },

  zakatRows() {
    return db
      .select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(eq(transactionsTable.isZakatRelevant, true))
      .orderBy(transactionsTable.date);
  },

  byCategoryRows(range: DateRange) {
    const conditions = [isNotNull(transactionsTable.categoryId)];
    if (range.dateFrom) conditions.push(gte(transactionsTable.date, range.dateFrom));
    if (range.dateTo) conditions.push(lte(transactionsTable.date, range.dateTo));
    return db
      .select({
        categoryId: transactionsTable.categoryId,
        categoryName: categoriesTable.name,
        categoryNameAr: categoriesTable.nameAr,
        categoryType: categoriesTable.type,
        total: sql<number>`sum(${transactionsTable.amount}::numeric)`,
        count: sql<number>`count(*)::int`,
        vatTotal: sql<number>`coalesce(sum(${transactionsTable.vatAmount}::numeric), 0)`,
      })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(and(...conditions))
      .groupBy(
        transactionsTable.categoryId,
        categoriesTable.name,
        categoriesTable.nameAr,
        categoriesTable.type,
      )
      .orderBy(sql`sum(${transactionsTable.amount}::numeric) desc`);
  },
};
