/**
 * Customers repository — all customer/AR data access. Queries run on the
 * request's tenant-scoped connection (RLS-enforced), so no explicit org filter
 * is added here (that is the established M4 enforcement mechanism).
 */
import { db, customersTable, invoicesTable } from "@workspace/db";
import { and, eq, ilike, notInArray } from "drizzle-orm";

export interface CustomerListFilter {
  search?: string;
  isActive?: boolean;
}

export const customersRepository = {
  list(filter: CustomerListFilter) {
    const conditions = [];
    if (filter.search) conditions.push(ilike(customersTable.name, `%${filter.search}%`));
    if (filter.isActive !== undefined) conditions.push(eq(customersTable.isActive, filter.isActive));
    return db
      .select()
      .from(customersTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(customersTable.name);
  },

  findById(id: number) {
    return db.select().from(customersTable).where(eq(customersTable.id, id)).limit(1);
  },

  /**
   * Issued documents for a customer — drafts and submitted invoices EXCLUDED.
   *
   * The previous `invoicesByCustomer` had no status filter, so unapproved drafts
   * counted toward the customer's balance (M12.1b fix). The exclusion list
   * mirrors `INVOICE_NOT_IN_BOOKS` in the reports repository; the two must stay
   * in lockstep.
   */
  issuedInvoicesByCustomer(id: number) {
    return db
      .select()
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.customerId, id),
          notInArray(invoicesTable.status, ["draft", "submitted"]),
        ),
      );
  },

  insert(values: typeof customersTable.$inferInsert) {
    return db.insert(customersTable).values(values).returning();
  },

  update(id: number, values: Partial<typeof customersTable.$inferInsert>) {
    return db.update(customersTable).set(values).where(eq(customersTable.id, id)).returning();
  },

  remove(id: number) {
    return db.delete(customersTable).where(eq(customersTable.id, id));
  },
};
