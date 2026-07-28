/** Products repository — tenant-scoped via RLS. */
import { db, productsTable } from "@workspace/db";
import { and, eq, ilike } from "drizzle-orm";

export interface ProductListFilter {
  search?: string;
  type?: string;
  isActive?: boolean;
}

export const productsRepository = {
  list(filter: ProductListFilter) {
    const conditions = [];
    if (filter.search) conditions.push(ilike(productsTable.name, `%${filter.search}%`));
    if (filter.type) conditions.push(eq(productsTable.type, filter.type));
    if (filter.isActive !== undefined) conditions.push(eq(productsTable.isActive, filter.isActive));
    return db
      .select()
      .from(productsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(productsTable.name);
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
