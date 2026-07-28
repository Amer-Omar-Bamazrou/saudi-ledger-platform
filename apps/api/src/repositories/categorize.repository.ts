/** Categorization repository — transactions/categories data access (tenant-scoped via RLS). */
import { db, transactionsTable, categoriesTable } from "@workspace/db";
import { eq, inArray, isNull } from "drizzle-orm";

export const categorizeRepository = {
  fetchTransactions(transactionIds?: number[], overrideExisting?: boolean | null) {
    let query = db.select({ tx: transactionsTable }).from(transactionsTable).$dynamic();
    if (transactionIds && transactionIds.length > 0) {
      query = query.where(inArray(transactionsTable.id, transactionIds)) as typeof query;
    } else if (!overrideExisting) {
      query = query.where(isNull(transactionsTable.categoryId)) as typeof query;
    }
    // If overrideExisting but no specific ids, process all.
    return query;
  },

  allCategories() {
    return db.select().from(categoriesTable);
  },

  updateCategory(id: number, values: Partial<typeof transactionsTable.$inferInsert>) {
    return db.update(transactionsTable).set(values).where(eq(transactionsTable.id, id));
  },
};
