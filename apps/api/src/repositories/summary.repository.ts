/** Summary/analytics repository — read-only aggregations, tenant-scoped via RLS. */
import { db, transactionsTable, categoriesTable } from "@workspace/db";

/**
 * 🔴 THE M15 HOLDING-AREA FILTER. Every tax-facing read of `transactions` MUST
 * carry this: a `pending_review` row is visible in the Transactions list but
 * moves NOTHING — not VAT, not Zakat, not cash flow, not the dashboard, not
 * budget actuals — until a human accepts it. Proven by the zero-movement test
 * (`transaction-review.test.ts`) through the real report services, to the
 * M10.3/10.4 standard.
 */
export const acceptedOnly = () => eq(transactionsTable.reviewStatus, "accepted");
import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";

export interface DateRange {
  dateFrom?: string | null;
  dateTo?: string | null;
}

export const summaryRepository = {
  summaryRows(range: DateRange) {
    const conditions = [acceptedOnly()];
    conditions.push(acceptedOnly());
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
    const conditions = [isNotNull(transactionsTable.vatAmount), acceptedOnly()];
    if (range.dateFrom) conditions.push(gte(transactionsTable.date, range.dateFrom));
    if (range.dateTo) conditions.push(lte(transactionsTable.date, range.dateTo));
    return db.select().from(transactionsTable).where(and(...conditions)).orderBy(transactionsTable.date);
  },

  zakatRows() {
    return db
      .select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(and(eq(transactionsTable.isZakatRelevant, true), acceptedOnly()))
      .orderBy(transactionsTable.date);
  },

  byCategoryRows(range: DateRange) {
    const conditions = [isNotNull(transactionsTable.categoryId), acceptedOnly()];
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
