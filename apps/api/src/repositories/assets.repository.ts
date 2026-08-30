/** Fixed assets repository — tenant-scoped via RLS. */
import { db, fixedAssetsTable, depreciationEntriesTable, categoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const assetsRepository = {
  /**
   * 🔴 The category NAME is joined, because the Fixed Asset Schedule has a
   * Category column and the row carries only `category_id`. The page had been
   * reading `a.category` — a field no response ever contained — so the column
   * rendered blank beside four other invented fields that rendered NaN.
   */
  list() {
    return db
      .select({ asset: fixedAssetsTable, categoryName: categoriesTable.name })
      .from(fixedAssetsTable)
      .leftJoin(categoriesTable, eq(fixedAssetsTable.categoryId, categoriesTable.id))
      .orderBy(fixedAssetsTable.purchaseDate);
  },
  findById(id: number) {
    return db.select().from(fixedAssetsTable).where(eq(fixedAssetsTable.id, id)).limit(1);
  },
  depreciationByAsset(id: number) {
    return db
      .select()
      .from(depreciationEntriesTable)
      .where(eq(depreciationEntriesTable.assetId, id))
      .orderBy(depreciationEntriesTable.period);
  },
  insert(values: typeof fixedAssetsTable.$inferInsert) {
    return db.insert(fixedAssetsTable).values(values).returning();
  },
  update(id: number, values: Partial<typeof fixedAssetsTable.$inferInsert>) {
    return db.update(fixedAssetsTable).set(values).where(eq(fixedAssetsTable.id, id)).returning();
  },
  insertDepreciationEntry(values: typeof depreciationEntriesTable.$inferInsert) {
    return db.insert(depreciationEntriesTable).values(values).returning();
  },
  remove(id: number) {
    return db.delete(fixedAssetsTable).where(eq(fixedAssetsTable.id, id));
  },
};
