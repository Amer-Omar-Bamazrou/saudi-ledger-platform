/** Categories repository — tenant-scoped via RLS. */
import { db, categoriesTable } from "@workspace/db";

export const categoriesRepository = {
  list() {
    return db.select().from(categoriesTable).orderBy(categoriesTable.type, categoriesTable.name);
  },

  insert(values: typeof categoriesTable.$inferInsert) {
    return db.insert(categoriesTable).values(values).returning();
  },
};
