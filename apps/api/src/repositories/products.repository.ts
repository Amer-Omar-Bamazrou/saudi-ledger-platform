/** Products repository — tenant-scoped via RLS. */
import { db, productsTable } from "@workspace/db";
import { and, eq, ilike, sql } from "drizzle-orm";
import { DEFAULT_PAGE } from "../lib/httpParams";

export interface ProductListFilter {
  search?: string;
  type?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

/** One predicate for the rows AND the count — so they cannot describe different sets. */
function productListConditions(filter: ProductListFilter) {
  const conditions = [];
  if (filter.search) conditions.push(ilike(productsTable.name, `%${filter.search}%`));
  if (filter.type) conditions.push(eq(productsTable.type, filter.type));
  if (filter.isActive !== undefined) conditions.push(eq(productsTable.isActive, filter.isActive));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export const productsRepository = {
  list(filter: ProductListFilter) {
    return db
      .select()
      .from(productsTable)
      .where(productListConditions(filter))
      .orderBy(productsTable.name)
      .limit(filter.limit ?? DEFAULT_PAGE)
      .offset(filter.offset ?? 0);
  },

  /**
   * 🔴 The catalog's four counts, over every matching row — never the page.
   * The page derived services / products / VAT-applicable by filtering the
   * fetched array, which is correct exactly while the list is unbounded and
   * becomes "how many of the first 50" the moment it is not (B-6).
   */
  async listTotals(filter: ProductListFilter) {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        serviceCount: sql<number>`COUNT(*) FILTER (WHERE ${productsTable.type} = 'service')::int`,
        productCount: sql<number>`COUNT(*) FILTER (WHERE ${productsTable.type} = 'product')::int`,
        vatApplicableCount: sql<number>`COUNT(*) FILTER (WHERE ${productsTable.vatApplicable})::int`,
      })
      .from(productsTable)
      .where(productListConditions(filter));
    return {
      total: Number(row?.total ?? 0),
      serviceCount: Number(row?.serviceCount ?? 0),
      productCount: Number(row?.productCount ?? 0),
      vatApplicableCount: Number(row?.vatApplicableCount ?? 0),
    };
  },

  findById(id: number) {
    return db.select().from(productsTable).where(eq(productsTable.id, id)).limit(1);
  },

  insert(values: typeof productsTable.$inferInsert) {
    return db.insert(productsTable).values(values).returning();
  },

  update(id: number, values: Partial<typeof productsTable.$inferInsert>) {
    return db.update(productsTable).set(values).where(eq(productsTable.id, id)).returning();
  },

  remove(id: number) {
    return db.delete(productsTable).where(eq(productsTable.id, id));
  },
};
