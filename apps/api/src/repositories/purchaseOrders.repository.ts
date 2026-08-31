/** Purchase orders repository (M21.3) — tenant-scoped via RLS. */
import {
  db,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  purchaseOrderConversionsTable,
  purchaseOrderConversionItemsTable,
  billsTable,
  vendorsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DEFAULT_PAGE } from "../lib/httpParams";

export interface PurchaseOrderListFilter {
  status?: string;
  vendorId?: number;
  outcome?: "live" | "cancelled" | "closed";
  /** Derived from the conversion rows, never stored — see `CONVERTED`. */
  converted?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * "Has been billed, in whole or in part" — the purchase-order twin of the
 * quotation `CONVERTED` predicate, and derived for the same reason: the
 * conversion axis is deliberately not a column, because one status string
 * cannot say "approved AND partially billed".
 */
const CONVERTED = sql`EXISTS (
  SELECT 1 FROM purchase_order_conversions pc
  WHERE pc.purchase_order_id = ${purchaseOrdersTable.id}
)`;

/** One predicate for the rows AND the count — so they cannot describe different sets. */
function purchaseOrderListConditions(filter: PurchaseOrderListFilter) {
  const conditions = [];
  if (filter.converted) conditions.push(CONVERTED);
  if (filter.status) conditions.push(eq(purchaseOrdersTable.status, filter.status));
  if (filter.vendorId) conditions.push(eq(purchaseOrdersTable.vendorId, filter.vendorId));
  if (filter.outcome === "live") conditions.push(sql`${purchaseOrdersTable.outcome} IS NULL`);
  else if (filter.outcome) conditions.push(eq(purchaseOrdersTable.outcome, filter.outcome));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export const purchaseOrdersRepository = {
  list(filter: PurchaseOrderListFilter) {
    return db
      .select({ po: purchaseOrdersTable, vendor: vendorsTable })
      .from(purchaseOrdersTable)
      .leftJoin(vendorsTable, eq(purchaseOrdersTable.vendorId, vendorsTable.id))
      .where(purchaseOrderListConditions(filter))
      .orderBy(desc(purchaseOrdersTable.date), desc(purchaseOrdersTable.id))
      .limit(filter.limit ?? DEFAULT_PAGE)
      .offset(filter.offset ?? 0);
  },

  /** Rows matching the filter — not rows on this page. */
  async listCount(filter: PurchaseOrderListFilter) {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(purchaseOrdersTable)
      .where(purchaseOrderListConditions(filter));
    return Number(row?.total ?? 0);
  },

  findWithVendor(id: number) {
    return db
      .select({ po: purchaseOrdersTable, vendor: vendorsTable })
      .from(purchaseOrdersTable)
      .leftJoin(vendorsTable, eq(purchaseOrdersTable.vendorId, vendorsTable.id))
      .where(eq(purchaseOrdersTable.id, id))
      .limit(1);
  },

  findById(id: number) {
    return db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, id)).limit(1);
  },

  itemsByOrder(id: number) {
    return db
      .select()
      .from(purchaseOrderItemsTable)
      .where(eq(purchaseOrderItemsTable.purchaseOrderId, id))
      .orderBy(purchaseOrderItemsTable.id);
  },

  /** `PO-{YYYY}-{NNNN}`. The unique index is the guarantee; this is the allocator. */
  async nextNumber(date: string): Promise<string> {
    const year = date.slice(0, 4);
    const [row] = await db
      .select({
        maxSeq: sql<number>`COALESCE(MAX(NULLIF(regexp_replace(${purchaseOrdersTable.orderNumber}, '^.*-', ''), '')::int), 0)`,
      })
      .from(purchaseOrdersTable)
      .where(
        and(
          sql`${purchaseOrdersTable.companyId} = (nullif(current_setting('app.current_company_id', true), ''))::uuid`,
          sql`${purchaseOrdersTable.orderNumber} ~ ${`^PO-${year}-[0-9]+$`}`,
        ),
      );
    return `PO-${year}-${String(Number(row?.maxSeq ?? 0) + 1).padStart(4, "0")}`;
  },

  /**
   * Allocate a bill number for a converted PO.
   *
   * 🔴 Note the difference from the invoice side: a bill number is normally
   * the SUPPLIER'S reference, and `bills.vendor_reference` exists for exactly
   * that. This allocates our own internal `BILL-{YYYY}-{NNNN}` only when the
   * caller supplies nothing, so a supplier's own number always wins.
   */
  async nextBillNumber(date: string): Promise<string> {
    const year = date.slice(0, 4);
    const [row] = await db
      .select({
        maxSeq: sql<number>`COALESCE(MAX(NULLIF(regexp_replace(${billsTable.billNumber}, '^.*-', ''), '')::int), 0)`,
      })
      .from(billsTable)
      .where(
        and(
          sql`${billsTable.companyId} = (nullif(current_setting('app.current_company_id', true), ''))::uuid`,
          sql`${billsTable.billNumber} ~ ${`^BILL-${year}-[0-9]+$`}`,
        ),
      );
    return `BILL-${year}-${String(Number(row?.maxSeq ?? 0) + 1).padStart(4, "0")}`;
  },

  /**
   * BILLED quantity per line, derived by SUM. Never a stored column — see the
   * schema header. Note the name: billed, not received. We have no goods
   * receipt and cannot claim to know what arrived.
   */
  async billedQuantities(purchaseOrderId: number): Promise<Map<number, number>> {
    const rows = await db
      .select({
        purchaseOrderItemId: purchaseOrderConversionItemsTable.purchaseOrderItemId,
        qty: sql<string>`SUM(${purchaseOrderConversionItemsTable.quantity})`,
      })
      .from(purchaseOrderConversionItemsTable)
      .innerJoin(
        purchaseOrderConversionsTable,
        eq(purchaseOrderConversionItemsTable.conversionId, purchaseOrderConversionsTable.id),
      )
      .where(eq(purchaseOrderConversionsTable.purchaseOrderId, purchaseOrderId))
      .groupBy(purchaseOrderConversionItemsTable.purchaseOrderItemId);
    return new Map(rows.map((r) => [r.purchaseOrderItemId, Number(r.qty)]));
  },

  /**
   * 🔴 AUD-3 (the purchase-order mirror) — billing totals for the LIST.
   *
   * `billingState` is derived from quantities and the list fetched none, so
   * every PO — including fully billed ones — reported "open" with a Bill button
   * beside it. Same defect, same cause, found by the same question: does the
   * endpoint load what the field is derived from?
   */
  async billingTotals(): Promise<Map<number, { quantity: number; billedQuantity: number }>> {
    const ordered = await db
      .select({
        purchaseOrderId: purchaseOrderItemsTable.purchaseOrderId,
        qty: sql<string>`SUM(${purchaseOrderItemsTable.quantity})`,
      })
      .from(purchaseOrderItemsTable)
      .groupBy(purchaseOrderItemsTable.purchaseOrderId);

    const billed = await db
      .select({
        purchaseOrderId: purchaseOrderConversionsTable.purchaseOrderId,
        qty: sql<string>`SUM(${purchaseOrderConversionItemsTable.quantity})`,
      })
      .from(purchaseOrderConversionItemsTable)
      .innerJoin(
        purchaseOrderConversionsTable,
        eq(purchaseOrderConversionItemsTable.conversionId, purchaseOrderConversionsTable.id),
      )
      .groupBy(purchaseOrderConversionsTable.purchaseOrderId);

    const out = new Map<number, { quantity: number; billedQuantity: number }>();
    for (const r of ordered) out.set(r.purchaseOrderId, { quantity: Number(r.qty), billedQuantity: 0 });
    for (const r of billed) {
      const e = out.get(r.purchaseOrderId) ?? { quantity: 0, billedQuantity: 0 };
      e.billedQuantity = Number(r.qty);
      out.set(r.purchaseOrderId, e);
    }
    return out;
  },

  /**
   * Every billed line with the price the supplier actually charged — the raw
   * material for the price-variance view. Returned per EVENT rather than
   * aggregated, because "they billed 10 at 100 then 5 at 120" is the fact a
   * buyer wants, and an average would hide it.
   */
  billedLines(purchaseOrderId: number) {
    return db
      .select({
        conversionId: purchaseOrderConversionItemsTable.conversionId,
        purchaseOrderItemId: purchaseOrderConversionItemsTable.purchaseOrderItemId,
        quantity: purchaseOrderConversionItemsTable.quantity,
        unitPrice: purchaseOrderConversionItemsTable.unitPrice,
        billedOn: purchaseOrderConversionsTable.billedOn,
      })
      .from(purchaseOrderConversionItemsTable)
      .innerJoin(
        purchaseOrderConversionsTable,
        eq(purchaseOrderConversionItemsTable.conversionId, purchaseOrderConversionsTable.id),
      )
      .where(eq(purchaseOrderConversionsTable.purchaseOrderId, purchaseOrderId));
  },

  conversions(purchaseOrderId: number) {
    return db
      .select({ conv: purchaseOrderConversionsTable, bill: billsTable })
      .from(purchaseOrderConversionsTable)
      .leftJoin(billsTable, eq(purchaseOrderConversionsTable.billId, billsTable.id))
      .where(eq(purchaseOrderConversionsTable.purchaseOrderId, purchaseOrderId))
      .orderBy(purchaseOrderConversionsTable.billedOn, purchaseOrderConversionsTable.id);
  },

  async hasConversions(purchaseOrderId: number): Promise<boolean> {
    const [row] = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(purchaseOrderConversionsTable)
      .where(eq(purchaseOrderConversionsTable.purchaseOrderId, purchaseOrderId));
    return Number(row?.n ?? 0) > 0;
  },

  insert(values: typeof purchaseOrdersTable.$inferInsert) {
    return db.insert(purchaseOrdersTable).values(values).returning();
  },

  insertItems(values: (typeof purchaseOrderItemsTable.$inferInsert)[]) {
    if (values.length === 0) return Promise.resolve([]);
    return db.insert(purchaseOrderItemsTable).values(values).returning();
  },

  update(id: number, values: Partial<typeof purchaseOrdersTable.$inferInsert>) {
    return db.update(purchaseOrdersTable).set(values).where(eq(purchaseOrdersTable.id, id)).returning();
  },

  updateItem(id: number, values: Partial<typeof purchaseOrderItemsTable.$inferInsert>) {
    return db.update(purchaseOrderItemsTable).set(values).where(eq(purchaseOrderItemsTable.id, id)).returning();
  },

  /** Targeted delete — ids must stay stable so conversion rows keep pointing at the right line. */
  deleteItemsByIds(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return db.delete(purchaseOrderItemsTable).where(inArray(purchaseOrderItemsTable.id, ids)).returning();
  },

  deleteItems(purchaseOrderId: number) {
    return db.delete(purchaseOrderItemsTable).where(eq(purchaseOrderItemsTable.purchaseOrderId, purchaseOrderId));
  },

  delete(id: number) {
    return db.delete(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, id));
  },

  insertConversion(values: typeof purchaseOrderConversionsTable.$inferInsert) {
    return db.insert(purchaseOrderConversionsTable).values(values).returning();
  },

  insertConversionItems(values: (typeof purchaseOrderConversionItemsTable.$inferInsert)[]) {
    return db.insert(purchaseOrderConversionItemsTable).values(values).returning();
  },
};
