/** Vendors repository — all vendor/AP data access (tenant-scoped via RLS). */
import { db, vendorsTable, billsTable } from "@workspace/db";
import { and, eq, ilike, notInArray, or, sql } from "drizzle-orm";

export interface VendorListFilter {
  search?: string;
  isActive?: boolean;
}

/**
 * 🔴 Drafts and submitted bills are NOT in the books, so they are not in a
 * vendor's balance either — the customer twin of this rule was fixed in M12.1b
 * and the vendor side was left as it was, so a draft bill has been inflating
 * every vendor balance ever since. "Green fixes the case, not the class" (§3),
 * found by building the two sides in one pass.
 */
const NOT_IN_BOOKS = ["draft", "submitted"];

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

  /**
   * 🔴 AP per vendor, in SQL — ONE definition of what we owe a vendor.
   *
   * The Vendors page has always shown "Total AP" and "Total Billed", and both
   * were always **0.00**: `list` returns the vendor row, which has no balance
   * column, so the page summed a field the API never sent. Same defect as the
   * customer side, on the payable half.
   *
   * There is no sign case here and that is deliberate, not an omission: `bills`
   * has no `document_type` column (checked — the M21.3 "a mirror is a
   * hypothesis" rule), so there is no supplier credit note to reverse.
   *
   * Omit `vendorId` for every vendor (one grouped query, not N+1).
   */
  vendorBalances(vendorId?: number) {
    return db
      .select({
        vendorId: billsTable.vendorId,
        totalBilled: sql<number>`COALESCE(SUM(${billsTable.total}), 0)::float8`,
        totalPaid: sql<number>`COALESCE(SUM(COALESCE(${billsTable.paidAmount}, 0)), 0)::float8`,
        billCount: sql<number>`COUNT(*)::int`,
      })
      .from(billsTable)
      .where(
        and(
          notInArray(billsTable.status, NOT_IN_BOOKS),
          vendorId !== undefined ? eq(billsTable.vendorId, vendorId) : undefined,
        ),
      )
      .groupBy(billsTable.vendorId);
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
