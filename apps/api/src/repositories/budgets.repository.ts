/** Budgets repository — tenant-scoped via RLS. */
import { db, budgetsTable, categoriesTable, transactionsTable } from "@workspace/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";

export const budgetsRepository = {
  listWithCategory(period?: string) {
    return db
      .select({ budget: budgetsTable, cat: categoriesTable })
      .from(budgetsTable)
      .leftJoin(categoriesTable, eq(budgetsTable.categoryId, categoriesTable.id))
      .where(period ? eq(budgetsTable.period, period) : undefined)
      .orderBy(categoriesTable.type, categoriesTable.name);
  },

  /**
   * 🔴 M19.0 — returns DEBIT and CREDIT totals separately, never a bare
   * `sum(amount)`.
   *
   * Amounts are stored POSITIVE and the direction lives in `type` (CLAUDE.md
   * §4), so summing the column alone treats every movement as if it went the
   * same way. On an expense budget that meant a REFUND INCREASED "spent": a
   * 5,000 purchase followed by a 5,000 refund reported 10,000 of spending
   * against the budget instead of nothing.
   *
   * The direction cannot be resolved here, because it depends on the ACCOUNT
   * TYPE — spending is debits on an expense account and credits on an income
   * one. So this returns both sides and the service applies the sign, which is
   * the same split the income statement already uses.
   */
  sumTransactions(categoryId: number, periodStart: string, periodEnd: string) {
    return db
      .select({
        debit: sql<string>`coalesce(sum(case when ${transactionsTable.type} = 'debit' then ${transactionsTable.amount}::numeric else 0 end), 0)`,
        credit: sql<string>`coalesce(sum(case when ${transactionsTable.type} = 'credit' then ${transactionsTable.amount}::numeric else 0 end), 0)`,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.categoryId, categoryId),
          // M15 holding area: budget ACTUALS count only accepted rows.
          eq(transactionsTable.reviewStatus, "accepted"),
          // M16.2: and only OPERATING rows — a transfer is not spending.
          eq(transactionsTable.kind, "operating"),
          gte(transactionsTable.date, periodStart),
          lte(transactionsTable.date, periodEnd),
        ),
      );
  },

  findById(id: number) {
    return db.select().from(budgetsTable).where(eq(budgetsTable.id, id)).limit(1);
  },

  insert(values: typeof budgetsTable.$inferInsert) {
    return db.insert(budgetsTable).values(values).returning();
  },
  update(id: number, values: Partial<typeof budgetsTable.$inferInsert>) {
    return db.update(budgetsTable).set(values).where(eq(budgetsTable.id, id)).returning();
  },
  remove(id: number) {
    return db.delete(budgetsTable).where(eq(budgetsTable.id, id));
  },
};
