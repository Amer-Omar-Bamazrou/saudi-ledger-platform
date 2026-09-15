/** Bank accounts repository — tenant-scoped via RLS. */
import { db, bankAccountsTable } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";

export const bankAccountsRepository = {
  list() {
    return db.select().from(bankAccountsTable).orderBy(bankAccountsTable.name);
  },
  findById(id: number) {
    return db.select().from(bankAccountsTable).where(eq(bankAccountsTable.id, id)).limit(1);
  },
  insert(values: typeof bankAccountsTable.$inferInsert) {
    return db.insert(bankAccountsTable).values(values).returning();
  },
  update(id: number, values: Partial<typeof bankAccountsTable.$inferInsert>) {
    return db.update(bankAccountsTable).set(values).where(eq(bankAccountsTable.id, id)).returning();
  },
  /**
   * Clear the default flag on every account of the current tenant except
   * `keepId`. RLS scopes the update to the tenant; the service calls this
   * before it sets a new default, so ONE effective default is a property of
   * the write boundary, not of the page.
   */
  clearDefaultsExcept(keepId: number | null) {
    return db
      .update(bankAccountsTable)
      .set({ isDefault: false })
      .where(keepId == null ? eq(bankAccountsTable.isDefault, true) : and(eq(bankAccountsTable.isDefault, true), ne(bankAccountsTable.id, keepId)));
  },
  remove(id: number) {
    return db.delete(bankAccountsTable).where(eq(bankAccountsTable.id, id));
  },
};
