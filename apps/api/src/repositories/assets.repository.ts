/** Fixed assets repository — tenant-scoped via RLS. */
import { db, fixedAssetsTable, depreciationEntriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const assetsRepository = {
  list() {
    return db.select().from(fixedAssetsTable).orderBy(fixedAssetsTable.purchaseDate);
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
