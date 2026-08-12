/** Transactions repository — tenant-scoped via RLS. */
import { db, transactionsTable, categoriesTable } from "@workspace/db";
import { and, desc, eq, ilike, sql } from "drizzle-orm";

export interface TransactionFilter {
  categoryId?: number | null;
  isZakatRelevant?: boolean | null;
  isManuallyOverridden?: boolean | null;
  type?: string | null;
  search?: string | null;
  limit?: number | null;
  offset?: number | null;
}

function whereFor(f: TransactionFilter) {
  const conditions = [];
  if (f.categoryId != null) conditions.push(eq(transactionsTable.categoryId, f.categoryId));
  if (f.isZakatRelevant != null) conditions.push(eq(transactionsTable.isZakatRelevant, f.isZakatRelevant));
  if (f.isManuallyOverridden != null)
    conditions.push(eq(transactionsTable.isManuallyOverridden, f.isManuallyOverridden));
  if (f.type != null) conditions.push(eq(transactionsTable.type, f.type));
  if (f.search) conditions.push(ilike(transactionsTable.description, `%${f.search}%`));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export const transactionsRepository = {
  list(f: TransactionFilter) {
    return db
      .select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(whereFor(f))
      .orderBy(desc(transactionsTable.date), desc(transactionsTable.id))
      .limit(f.limit ?? 50)
      .offset(f.offset ?? 0);
  },

  count(f: TransactionFilter) {
    return db.select({ count: sql<number>`count(*)::int` }).from(transactionsTable).where(whereFor(f));
  },

  findWithCategory(id: number) {
    return db
      .select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(eq(transactionsTable.id, id))
      .limit(1);
  },

  insert(values: typeof transactionsTable.$inferInsert) {
    return db.insert(transactionsTable).values(values).returning();
  },

  /**
   * Does an IDENTICAL row already exist? (M15 duplicate guard.)
   *
   * The key is (date, description, amount, type) — deliberately INCLUDING the
   * full description. Statement lines carry references ("TRANSFER TO ALMARAI -
   * INV 88231" vs "… INV 88240"), so two genuine same-amount-same-payee
   * payments differ in description and BOTH survive. What this catches is the
   * same statement uploaded twice, where every field is byte-identical — which
   * previously doubled every tax figure silently.
   *
   * Two genuinely identical rows (same day, same wording, same amount, no
   * reference) WILL be collapsed, and that is the accepted trade: the response
   * reports every skip, so the rarer case is visible and re-enterable by hand,
   * while the common failure (a re-upload) stops corrupting VAT and Zakat.
   */
  async existsIdentical(v: { date: string; description: string; amount: string; type: string }): Promise<boolean> {
    const [row] = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.date, v.date),
          eq(transactionsTable.description, v.description),
          eq(transactionsTable.amount, v.amount),
          eq(transactionsTable.type, v.type),
        ),
      )
      .limit(1);
    return !!row;
  },

  update(id: number, values: Partial<typeof transactionsTable.$inferInsert>) {
    return db.update(transactionsTable).set(values).where(eq(transactionsTable.id, id));
  },

  remove(id: number) {
    return db.delete(transactionsTable).where(eq(transactionsTable.id, id));
  },
};
