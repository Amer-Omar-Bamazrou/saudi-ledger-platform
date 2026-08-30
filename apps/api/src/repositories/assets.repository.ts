/** Fixed assets repository — tenant-scoped via RLS. */
import { db, fixedAssetsTable, depreciationEntriesTable, categoriesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { DEFAULT_PAGE } from "../lib/httpParams";

export const assetsRepository = {
  /**
   * 🔴 The category NAME is joined, because the Fixed Asset Schedule has a
   * Category column and the row carries only `category_id`. The page had been
   * reading `a.category` — a field no response ever contained — so the column
   * rendered blank beside four other invented fields that rendered NaN.
   */
  list(page: { limit?: number; offset?: number } = {}) {
    return db
      .select({ asset: fixedAssetsTable, categoryName: categoriesTable.name })
      .from(fixedAssetsTable)
      .leftJoin(categoriesTable, eq(fixedAssetsTable.categoryId, categoriesTable.id))
      .orderBy(fixedAssetsTable.purchaseDate)
      .limit(page.limit ?? DEFAULT_PAGE)
      .offset(page.offset ?? 0);
  },

  /**
   * 🔴 The register's figures, over EVERY asset — never over the page.
   * `activeCount` is here rather than filtered client-side for the same reason:
   * the Fixed Asset Schedule's "Total Assets" card counts active assets, and a
   * page-scoped count of them is a number describing a set the reader is not
   * looking at (B-6).
   */
  async listTotals() {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        activeCount: sql<number>`COUNT(*) FILTER (WHERE ${fixedAssetsTable.status} = 'active')::int`,
        purchaseCost: sql<number>`COALESCE(SUM(${fixedAssetsTable.purchaseCost}), 0)::float8`,
        accumulatedDepreciation: sql<number>`COALESCE(SUM(${fixedAssetsTable.accumulatedDepreciation}), 0)::float8`,
        currentBookValue: sql<number>`COALESCE(SUM(${fixedAssetsTable.currentBookValue}), 0)::float8`,
      })
      .from(fixedAssetsTable);
    return {
      total: Number(row?.total ?? 0),
      activeCount: Number(row?.activeCount ?? 0),
      purchaseCost: Number(row?.purchaseCost ?? 0),
      accumulatedDepreciation: Number(row?.accumulatedDepreciation ?? 0),
      currentBookValue: Number(row?.currentBookValue ?? 0),
    };
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
