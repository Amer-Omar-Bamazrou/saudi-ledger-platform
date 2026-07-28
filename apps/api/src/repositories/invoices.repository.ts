/** Invoices repository — tenant-scoped via RLS. */
import { db, invoicesTable, invoiceItemsTable, customersTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

export interface InvoiceListFilter {
  status?: string;
  customerId?: number;
}

export const invoicesRepository = {
  list(filter: InvoiceListFilter) {
    const conditions = [];
    if (filter.status) conditions.push(eq(invoicesTable.status, filter.status));
    if (filter.customerId) conditions.push(eq(invoicesTable.customerId, filter.customerId));
    return db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(invoicesTable.date), desc(invoicesTable.id));
  },

  findWithCustomer(id: number) {
    return db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(eq(invoicesTable.id, id))
      .limit(1);
  },

  findById(id: number) {
    return db.select().from(invoicesTable).where(eq(invoicesTable.id, id)).limit(1);
  },

  itemsByInvoice(id: number) {
    return db.select().from(invoiceItemsTable).where(eq(invoiceItemsTable.invoiceId, id));
  },

  insert(values: typeof invoicesTable.$inferInsert) {
    return db.insert(invoicesTable).values(values).returning();
  },

  insertItems(values: (typeof invoiceItemsTable.$inferInsert)[]) {
    return db.insert(invoiceItemsTable).values(values);
  },

  update(id: number, values: Partial<typeof invoicesTable.$inferInsert>) {
    return db.update(invoicesTable).set(values).where(eq(invoicesTable.id, id)).returning();
  },

  remove(id: number) {
    return db.delete(invoicesTable).where(eq(invoicesTable.id, id));
  },
};
