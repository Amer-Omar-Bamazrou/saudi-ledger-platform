/**
 * Analytics repository — the trend read model (M19.1). Tenant-scoped via RLS.
 *
 * 🔴 ONE QUERY, NOT ONE PER POINT.
 *
 * The obvious build for a liquidity trend is a loop over
 * `reportsService.balanceSheet(as_of)`. That is a CUMULATIVE query — it reads
 * every posted GL line from the beginning of time for each call — so N points
 * cost `O(N × lines)`, and since `lines` grows with history the real shape is
 * quadratic in how long the tenant has been a customer. Measured at 4,612ms for
 * 12 points over 6,000 lines, against 138ms over 61: fine in dev, unusable
 * exactly when a customer finally has enough history to want a trend.
 *
 * So this reads each line ONCE, pre-aggregated by (month, account) in Postgres,
 * and the service folds forward. The DB does the grouping because it is far
 * better at it than a JS reduce over every row.
 *
 * Semantics are copied deliberately from `reportsRepository.bsLines`: posted
 * entries only, `date <= as_of`. A trend that disagreed with the balance sheet
 * it is charting would be meta-finding #9 in a new costume.
 */
import { db, journalEntriesTable, journalEntryLinesTable, categoriesTable } from "@workspace/db";
import { and, eq, lte, sql } from "drizzle-orm";

export interface MonthlyAccountMovement {
  /** `YYYY-MM` — the month the movement fell in. */
  month: string;
  accountId: number | null;
  /** `income | expense | asset | liability | equity`, or null for an unresolved line. */
  type: string | null;
  /** `cash | quick | current | non_current`, or NULL = unclassified (M18.1). */
  liquidityClass: string | null;
  systemCode: string | null;
  debit: string;
  credit: string;
}

export const analyticsRepository = {
  /**
   * Every posted movement up to `asOf`, summed per (month, account).
   *
   * Returns from the beginning of time — NOT from the window start — because a
   * balance is cumulative: the opening position of the first charted month is
   * the sum of everything before it. Aggregating in SQL keeps that cheap; the
   * row count is bounded by (months × accounts), not by transactions.
   */
  monthlyMovements(asOf: string) {
    return db
      .select({
        month: sql<string>`to_char(${journalEntriesTable.date}::date, 'YYYY-MM')`,
        accountId: journalEntryLinesTable.accountId,
        type: categoriesTable.type,
        liquidityClass: categoriesTable.liquidityClass,
        systemCode: categoriesTable.systemCode,
        debit: sql<string>`coalesce(sum(${journalEntryLinesTable.debitAmount}), 0)`,
        credit: sql<string>`coalesce(sum(${journalEntryLinesTable.creditAmount}), 0)`,
      })
      .from(journalEntryLinesTable)
      .innerJoin(
        journalEntriesTable,
        eq(journalEntriesTable.id, journalEntryLinesTable.journalEntryId),
      )
      .leftJoin(categoriesTable, eq(categoriesTable.id, journalEntryLinesTable.accountId))
      .where(and(eq(journalEntriesTable.status, "posted"), lte(journalEntriesTable.date, asOf)))
      .groupBy(
        sql`to_char(${journalEntriesTable.date}::date, 'YYYY-MM')`,
        journalEntryLinesTable.accountId,
        categoriesTable.type,
        categoriesTable.liquidityClass,
        categoriesTable.systemCode,
      )
      .orderBy(sql`to_char(${journalEntriesTable.date}::date, 'YYYY-MM')`);
  },
};
