/** Bills repository — tenant-scoped via RLS. */
import { db, billsTable, billItemsTable, vendorsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";

export interface BillListFilter {
  status?: string;
  vendorId?: number;
  limit?: number;
  offset?: number;
}

/** The default page. Stated once so the API, the UI and the tests agree. */
export const DEFAULT_PAGE = 50;

/** One predicate for the rows AND the totals — so they cannot describe different sets. */
function billListConditions(filter: BillListFilter) {
  const conditions = [];
  if (filter.status) conditions.push(eq(billsTable.status, filter.status));
  if (filter.vendorId) conditions.push(eq(billsTable.vendorId, filter.vendorId));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export const billsRepository = {
  /** A PAGE. See the note on `invoicesRepository.list` for why offset, not cursor. */
  list(filter: BillListFilter) {
    return db
      .select({ bill: billsTable, vendor: vendorsTable })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(billListConditions(filter))
      .orderBy(desc(billsTable.date), desc(billsTable.id))
      .limit(filter.limit ?? DEFAULT_PAGE)
      .offset(filter.offset ?? 0);
  },

  /** Totals in SQL over the WHOLE filtered set — never over the page. */
  async listMeta(filter: BillListFilter) {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        outstanding: sql<number>`COALESCE(SUM(
          CASE WHEN ${billsTable.status} <> 'paid'
               THEN ${billsTable.total} - ${billsTable.paidAmount} ELSE 0 END), 0)::float8`,
        paid: sql<number>`COALESCE(SUM(
          CASE WHEN ${billsTable.status} = 'paid' THEN ${billsTable.total} ELSE 0 END), 0)::float8`,
      })
      .from(billsTable)
      .where(billListConditions(filter));
    return {
      total: Number(row?.total ?? 0),
      outstanding: Number(row?.outstanding ?? 0),
      paid: Number(row?.paid ?? 0),
    };
  },

  findWithVendor(id: number) {
    return db
      .select({ bill: billsTable, vendor: vendorsTable })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(eq(billsTable.id, id))
      .limit(1);
  },

  findById(id: number) {
    return db.select().from(billsTable).where(eq(billsTable.id, id)).limit(1);
  },

  /**
   * Open bills a bank debit could pay (M16.3 reconciliation). "Open" mirrors
   * AP aging: approved (bills have no hash — `status` past the draft/submitted
   * queue IS the approval marker), not fully paid, outstanding >= 0.01.
   */
  openForSettlement() {
    return db
      .select({ bill: billsTable, vendor: vendorsTable })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(
        and(
          sql`${billsTable.status} NOT IN ('draft','submitted','paid')`,
          sql`(${billsTable.total}::numeric - COALESCE(${billsTable.paidAmount}::numeric, 0)) >= 0.01`,
        ),
      )
      .orderBy(desc(billsTable.date), desc(billsTable.id));
  },

  itemsByBill(id: number) {
    return db.select().from(billItemsTable).where(eq(billItemsTable.billId, id));
  },

  insert(values: typeof billsTable.$inferInsert) {
    return db.insert(billsTable).values(values).returning();
  },

  insertItems(values: (typeof billItemsTable.$inferInsert)[]) {
    return db.insert(billItemsTable).values(values);
  },

  update(id: number, values: Partial<typeof billsTable.$inferInsert>) {
    return db.update(billsTable).set(values).where(eq(billsTable.id, id)).returning();
  },

  remove(id: number) {
    return db.delete(billsTable).where(eq(billsTable.id, id));
  },
};
