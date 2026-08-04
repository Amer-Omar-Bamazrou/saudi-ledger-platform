/** Invoices repository — tenant-scoped via RLS. */
import { db, invoicesTable, invoiceItemsTable, customersTable } from "@workspace/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";

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

  /**
   * The most recent issued invoice's hash for ONE COMPANY — the tail of that
   * company's chain.
   *
   * ── M12.1a bug fix ────────────────────────────────────────────────────────
   * This used to live in `services/accounting/zatca.ts` as
   * `getPreviousInvoiceHash(db, invoicesTable)`, taking `any` params and
   * filtering ONLY on `invoice_hash IS NOT NULL`. RLS confined it to the active
   * organization, but NOT to a company — so an org with two companies
   * INTERLEAVED their chains into one, which is invalid: ZATCA's chain (and the
   * ICV counter) are per EGS unit, i.e. per company. Harmless while every org
   * had one company; a correctness bug the moment one had two.
   *
   * It also belongs here on layering grounds — repositories own Drizzle access.
   * That it lived in the accounting layer behind `any` types is precisely why
   * the missing filter was invisible.
   *
   * Drafts are excluded by the `invoice_hash IS NOT NULL` predicate (M10.4), so
   * a draft still consumes no sequence number.
   */
  async previousInvoiceHash(companyId: string): Promise<string | null> {
    const [row] = await db
      .select({ hash: invoicesTable.invoiceHash })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.companyId, companyId), isNotNull(invoicesTable.invoiceHash)))
      .orderBy(desc(invoicesTable.id))
      .limit(1);
    return row?.hash ?? null;
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
