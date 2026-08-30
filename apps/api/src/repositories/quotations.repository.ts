/** Quotations repository (M21.1) — tenant-scoped via RLS. */
import {
  db,
  quotationsTable,
  quotationItemsTable,
  quotationConversionsTable,
  quotationConversionItemsTable,
  invoicesTable,
  customersTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DEFAULT_PAGE } from "../lib/httpParams";

export interface QuotationListFilter {
  status?: string;
  customerId?: number;
  /** `live` hides quotations the tenant has declined or closed. */
  outcome?: "live" | "declined" | "closed";
  limit?: number;
  offset?: number;
}

/** One predicate for the rows AND the count — so they cannot describe different sets. */
function quotationListConditions(filter: QuotationListFilter) {
  const conditions = [];
  if (filter.status) conditions.push(eq(quotationsTable.status, filter.status));
  if (filter.customerId) conditions.push(eq(quotationsTable.customerId, filter.customerId));
  if (filter.outcome === "live") conditions.push(sql`${quotationsTable.outcome} IS NULL`);
  else if (filter.outcome) conditions.push(eq(quotationsTable.outcome, filter.outcome));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export const quotationsRepository = {
  list(filter: QuotationListFilter) {
    return db
      .select({ quo: quotationsTable, cust: customersTable })
      .from(quotationsTable)
      .leftJoin(customersTable, eq(quotationsTable.customerId, customersTable.id))
      .where(quotationListConditions(filter))
      .orderBy(desc(quotationsTable.date), desc(quotationsTable.id))
      .limit(filter.limit ?? DEFAULT_PAGE)
      .offset(filter.offset ?? 0);
  },

  /** Rows matching the filter — not rows on this page. */
  async listCount(filter: QuotationListFilter) {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(quotationsTable)
      .where(quotationListConditions(filter));
    return Number(row?.total ?? 0);
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

  updateItem(id: number, values: Partial<typeof quotationItemsTable.$inferInsert>) {
    return db.update(quotationItemsTable).set(values).where(eq(quotationItemsTable.id, id)).returning();
  },

  /**
   * Delete SPECIFIC lines. Used by the edit path, which reconciles by id
   * rather than replacing wholesale — a converted line must keep its id, or
   * the conversion rows that reference it are orphaned (and the RESTRICT FK
   * turns the attempt into a raw 500).
   */
  deleteItemsByIds(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return db.delete(quotationItemsTable).where(inArray(quotationItemsTable.id, ids)).returning();
  },

  deleteItems(quotationId: number) {
    return db.delete(quotationItemsTable).where(eq(quotationItemsTable.quotationId, quotationId));
  },

  /**
   * Converted quantity PER LINE for one quotation, derived by SUM.
   *
   * 🔴 This is the only source of converted quantity anywhere. There is no
   * stored column to disagree with it — see the schema header for why (a
   * running total carries one date; an aggregate beside line-level truth
   * drifts). Lines with no conversions simply do not appear in the map, and
   * callers default them to 0.
   */
  async convertedQuantities(quotationId: number): Promise<Map<number, number>> {
    const rows = await db
      .select({
        quotationItemId: quotationConversionItemsTable.quotationItemId,
        qty: sql<string>`SUM(${quotationConversionItemsTable.quantity})`,
      })
      .from(quotationConversionItemsTable)
      .innerJoin(
        quotationConversionsTable,
        eq(quotationConversionItemsTable.conversionId, quotationConversionsTable.id),
      )
      .where(eq(quotationConversionsTable.quotationId, quotationId))
      .groupBy(quotationConversionItemsTable.quotationItemId);
    return new Map(rows.map((r) => [r.quotationItemId, Number(r.qty)]));
  },

  /**
   * 🔴 AUD-3 — the totals the LIST needs, in ONE query.
   *
   * The list never loaded items, so `buildQuotationOut` derived
   * `conversionState` from an empty array and every row — including fully
   * converted ones — reported "open", with a Convert button beside it. The
   * presenter was reasoning about a quotation with NO LINES; the list was
   * handing it a quotation whose lines it had not fetched. Two different
   * emptinesses, one of them a lie.
   *
   * Sums are sufficient for the three-way state: converted totals can never
   * exceed ordered (over-conversion 409s), so `0`, `< ordered` and `>= ordered`
   * separate open / partial / converted exactly as the per-item form does.
   */
  async conversionTotals(): Promise<Map<number, { quantity: number; convertedQuantity: number }>> {
    const ordered = await db
      .select({
        quotationId: quotationItemsTable.quotationId,
        qty: sql<string>`SUM(${quotationItemsTable.quantity})`,
      })
      .from(quotationItemsTable)
      .groupBy(quotationItemsTable.quotationId);

    const converted = await db
      .select({
        quotationId: quotationConversionsTable.quotationId,
        qty: sql<string>`SUM(${quotationConversionItemsTable.quantity})`,
      })
      .from(quotationConversionItemsTable)
      .innerJoin(
        quotationConversionsTable,
        eq(quotationConversionItemsTable.conversionId, quotationConversionsTable.id),
      )
      .groupBy(quotationConversionsTable.quotationId);

    const out = new Map<number, { quantity: number; convertedQuantity: number }>();
    for (const r of ordered) out.set(r.quotationId, { quantity: Number(r.qty), convertedQuantity: 0 });
    for (const r of converted) {
      const e = out.get(r.quotationId) ?? { quantity: 0, convertedQuantity: 0 };
      e.convertedQuantity = Number(r.qty);
      out.set(r.quotationId, e);
    }
    return out;
  },

  /** The dated conversion history, with the invoice each one produced. */
  conversions(quotationId: number) {
    return db
      .select({ conv: quotationConversionsTable, inv: invoicesTable })
      .from(quotationConversionsTable)
      .leftJoin(invoicesTable, eq(quotationConversionsTable.invoiceId, invoicesTable.id))
      .where(eq(quotationConversionsTable.quotationId, quotationId))
      .orderBy(quotationConversionsTable.convertedOn, quotationConversionsTable.id);
  },

  /** True when ANY conversion exists — used to refuse deletion. */
  async hasConversions(quotationId: number): Promise<boolean> {
    const [row] = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(quotationConversionsTable)
      .where(eq(quotationConversionsTable.quotationId, quotationId));
    return Number(row?.n ?? 0) > 0;
  },

  insertConversion(values: typeof quotationConversionsTable.$inferInsert) {
    return db.insert(quotationConversionsTable).values(values).returning();
  },

  insertConversionItems(values: (typeof quotationConversionItemsTable.$inferInsert)[]) {
    return db.insert(quotationConversionItemsTable).values(values).returning();
  },

  // The invoice-number allocator that used to live here is GONE (C12).
  // It produced INV-{YYYY}-{NNNN} restarting each January and had no unique
  // constraint behind it. Conversion now leaves `invoiceNumber` unset and
  // `invoicesService.create` allocates from the single monotonic per-company
  // counter — one allocator for every invoice, which is what "one sequence per
  // unit" requires. See docs/tax/invoice-numbering-verification.md.

  delete(id: number) {
    return db.delete(quotationsTable).where(eq(quotationsTable.id, id));
  },
};
