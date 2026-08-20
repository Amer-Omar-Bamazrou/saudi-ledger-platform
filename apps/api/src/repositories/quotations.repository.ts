/** Quotations repository (M21.1) — tenant-scoped via RLS. */
import { db, quotationsTable, quotationItemsTable, customersTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";

export interface QuotationListFilter {
  status?: string;
  customerId?: number;
  /** `live` hides quotations the tenant has declined or closed. */
  outcome?: "live" | "declined" | "closed";
}

export const quotationsRepository = {
  list(filter: QuotationListFilter) {
    const conditions = [];
    if (filter.status) conditions.push(eq(quotationsTable.status, filter.status));
    if (filter.customerId) conditions.push(eq(quotationsTable.customerId, filter.customerId));
    if (filter.outcome === "live") conditions.push(sql`${quotationsTable.outcome} IS NULL`);
    else if (filter.outcome) conditions.push(eq(quotationsTable.outcome, filter.outcome));
    return db
      .select({ quo: quotationsTable, cust: customersTable })
      .from(quotationsTable)
      .leftJoin(customersTable, eq(quotationsTable.customerId, customersTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(quotationsTable.date), desc(quotationsTable.id));
  },

  findWithCustomer(id: number) {
    return db
      .select({ quo: quotationsTable, cust: customersTable })
      .from(quotationsTable)
      .leftJoin(customersTable, eq(quotationsTable.customerId, customersTable.id))
      .where(eq(quotationsTable.id, id))
      .limit(1);
  },

  findById(id: number) {
    return db.select().from(quotationsTable).where(eq(quotationsTable.id, id)).limit(1);
  },

  itemsByQuotation(id: number) {
    return db
      .select()
      .from(quotationItemsTable)
      .where(eq(quotationItemsTable.quotationId, id))
      .orderBy(quotationItemsTable.id);
  },

  /**
   * Allocate the next number for a company: `QUO-{YYYY}-{NNNN}`.
   *
   * 🔴 This read-then-write is a RACE, and it is meant to be. Two concurrent
   * creates can both read the same max; the loser's INSERT then violates
   * `quotations_company_number_unq` and the service retries. The unique index
   * is the guarantee — this function is only the allocator, and an allocator
   * that appeared to be safe on its own would be the more dangerous design
   * (`unique(company_id, icv)` carries the same warning in `invoices`).
   *
   * The year is the QUOTATION's own year, not "now": a quotation dated
   * 2025-12-31 entered in January belongs to the 2025 series. Counting is
   * per (company, year-prefix), so the series restarts each year without a
   * separate counter table.
   */
  async nextNumber(date: string): Promise<string> {
    const year = date.slice(0, 4);
    // Scoped to the CURRENT company the same way the column default is, rather
    // than by a companyId threaded down from the service — services in this
    // codebase never resolve the company themselves (invoices.service.ts never
    // mentions `companyId`); the tenant transaction's GUC supplies it. Using
    // the same source keeps the counter and the stored column in agreement by
    // construction.
    const [row] = await db
      .select({
        maxSeq: sql<number>`COALESCE(MAX(NULLIF(regexp_replace(${quotationsTable.quotationNumber}, '^.*-', ''), '')::int), 0)`,
      })
      .from(quotationsTable)
      .where(
        and(
          sql`${quotationsTable.companyId} = (nullif(current_setting('app.current_company_id', true), ''))::uuid`,
          sql`${quotationsTable.quotationNumber} ~ ${`^QUO-${year}-[0-9]+$`}`,
        ),
      );
    const next = Number(row?.maxSeq ?? 0) + 1;
    return `QUO-${year}-${String(next).padStart(4, "0")}`;
  },

  insert(values: typeof quotationsTable.$inferInsert) {
    return db.insert(quotationsTable).values(values).returning();
  },

  insertItems(values: (typeof quotationItemsTable.$inferInsert)[]) {
    if (values.length === 0) return Promise.resolve([]);
    return db.insert(quotationItemsTable).values(values).returning();
  },

  update(id: number, values: Partial<typeof quotationsTable.$inferInsert>) {
    return db.update(quotationsTable).set(values).where(eq(quotationsTable.id, id)).returning();
  },

  deleteItems(quotationId: number) {
    return db.delete(quotationItemsTable).where(eq(quotationItemsTable.quotationId, quotationId));
  },

  delete(id: number) {
    return db.delete(quotationsTable).where(eq(quotationsTable.id, id));
  },
};
