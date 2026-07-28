/** Vendors repository — all vendor/AP data access (tenant-scoped via RLS). */
import { db, vendorsTable, billsTable } from "@workspace/db";
import { and, eq, ilike, or } from "drizzle-orm";

export interface VendorListFilter {
  search?: string;
  isActive?: boolean;
}

export const vendorsRepository = {
  list(filter: VendorListFilter) {
    const conditions = [];
    if (filter.search) conditions.push(ilike(vendorsTable.name, `%${filter.search}%`));
    if (filter.isActive !== undefined) conditions.push(eq(vendorsTable.isActive, filter.isActive));
    return db
      .select()
      .from(vendorsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(vendorsTable.name);
  },

  findById(id: number) {
    return db.select().from(vendorsTable).where(eq(vendorsTable.id, id)).limit(1);
  },

  billsByVendor(id: number) {
    return db.select().from(billsTable).where(eq(billsTable.vendorId, id));
  },

  findByTaxNumber(taxNumber: string) {
    return db.select().from(vendorsTable).where(eq(vendorsTable.taxNumber, taxNumber)).limit(1);
  },

  searchByNameToken(token: string) {
    return db
      .select()
      .from(vendorsTable)
      .where(or(ilike(vendorsTable.name, `%${token}%`), ilike(vendorsTable.nameAr, `%${token}%`)))
      .limit(5);
  },

  insert(values: typeof vendorsTable.$inferInsert) {
    return db.insert(vendorsTable).values(values).returning();
  },

  update(id: number, values: Partial<typeof vendorsTable.$inferInsert>) {
    return db.update(vendorsTable).set(values).where(eq(vendorsTable.id, id)).returning();
  },

  remove(id: number) {
    return db.delete(vendorsTable).where(eq(vendorsTable.id, id));
  },
};
