/** Categories repository — tenant-scoped via RLS. */
import { db, categoriesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export const categoriesRepository = {
  list() {
    return db.select().from(categoriesTable).orderBy(categoriesTable.type, categoriesTable.name);
  },

  insert(values: typeof categoriesTable.$inferInsert) {
    return db.insert(categoriesTable).values(values).returning();
  },

  async findById(id: number) {
    const [row] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, id)).limit(1);
    return row ?? null;
  },

  /**
   * Find one of the tenant's accounts by name, case-insensitively (M13).
   *
   * 🔴 Used ONLY where the USER named the account — a bill's free-text
   * `debitAccount`. It must never be used to resolve one of OUR posting
   * literals: those go through `system_code`, precisely so a rename cannot
   * silently break classification. See `glPosting.ts`.
   */
  async findByName(name: string) {
    const [row] = await db
      .select()
      .from(categoriesTable)
      .where(sql`lower(${categoriesTable.name}) = lower(${name})`)
      .limit(1);
    return row ?? null;
  },

  /** One of the tenant's system accounts by its stable code. */
  async findBySystemCode(code: string) {
    const [row] = await db
      .select()
      .from(categoriesTable)
      .where(eq(categoriesTable.systemCode, code))
      .limit(1);
    return row ?? null;
  },
};
