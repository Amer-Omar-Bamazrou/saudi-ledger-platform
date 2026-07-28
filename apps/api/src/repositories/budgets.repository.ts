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

  sumTransactions(categoryId: number, periodStart: string, periodEnd: string) {
    return db
      .select({ amount: sql<string>`sum(amount)` })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.categoryId, categoryId),
          gte(transactionsTable.date, periodStart),
          lte(transactionsTable.date, periodEnd),
        ),
      );
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
