/** Bank accounts repository — tenant-scoped via RLS. */
import { db, bankAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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
  remove(id: number) {
    return db.delete(bankAccountsTable).where(eq(bankAccountsTable.id, id));
  },
};
