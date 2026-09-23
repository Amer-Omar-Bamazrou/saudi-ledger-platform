/** Vendors repository — all vendor/AP data access (tenant-scoped via RLS). */
import { db, vendorsTable, billsTable } from "@workspace/db";
import { and, eq, ilike, notInArray, or, sql } from "drizzle-orm";
import { DEFAULT_PAGE } from "../lib/httpParams";
import { billIsPayableSql, billLivePaidBySubledgerSql, billSignSql } from "./billPosition";

/**
 * 🔴 PHASE 11 PART 2 — what a vendor was billed and paid, from `billPosition`.
 *
 *   totalBilled = Σ signed totals — a CREDIT note reduces it (it is the
 *                 supplier crediting us, not a charge);
 *   totalPaid   = Σ over bills/debit notes of money that settled them: the
 *                 legacy `paid_amount` AND live AP-subledger allocations from
 *                 a PAYMENT (an advance applied is money paid earlier);
 *   balance     = totalBilled − totalPaid — what AP carries for the vendor in
 *                 the GL.
 *
 * A credit note's APPLICATION is deliberately not in totalPaid: its effect is
 * already in totalBilled as the note's negative total, and counting the
 * application too would reduce the balance twice for one note.
 */
const TOTAL_BILLED = sql<number>`COALESCE(SUM(${billSignSql("bills")} * ${billsTable.total}::numeric), 0)::float8`;
const TOTAL_PAID = sql<number>`COALESCE(SUM(CASE WHEN ${billIsPayableSql("bills")}
  THEN COALESCE(${billsTable.paidAmount}::numeric, 0) + ${billLivePaidBySubledgerSql("bills")} ELSE 0 END), 0)::float8`;

export interface VendorListFilter {
  search?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

/** One predicate for the rows AND the count — so they cannot describe different sets. */
function vendorListConditions(filter: VendorListFilter) {
  const conditions = [];
  if (filter.search) conditions.push(ilike(vendorsTable.name, `%${filter.search}%`));
  if (filter.isActive !== undefined) conditions.push(eq(vendorsTable.isActive, filter.isActive));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * 🔴 Drafts and submitted bills are NOT in the books, so they are not in a
 * vendor's balance either — the customer twin of this rule was fixed in M12.1b
 * and the vendor side was left as it was, so a draft bill has been inflating
 * every vendor balance ever since. "Green fixes the case, not the class" (§3),
 * found by building the two sides in one pass.
 */
const NOT_IN_BOOKS = ["draft", "submitted"];
import { billNotReversed } from "./openingReversal";

export const vendorsRepository = {
  list(filter: VendorListFilter) {
    return db
      .select()
      .from(vendorsTable)
      .where(vendorListConditions(filter))
      .orderBy(vendorsTable.name)
      .limit(filter.limit ?? DEFAULT_PAGE)
      .offset(filter.offset ?? 0);
  },

  /** Rows matching the filter — not rows on this page. */
  async listCount(filter: VendorListFilter) {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(vendorsTable)
      .where(vendorListConditions(filter));
    return Number(row?.total ?? 0);
  },

  /**
   * 🔴 Total AP across every vendor MATCHING THE FILTER — never across the page.
   * Same predicate as the rows, so the headline and the table cannot describe
   * different sets (B-6).
   */
  async listTotals(filter: VendorListFilter) {
    const [row] = await db
      .select({ totalBilled: TOTAL_BILLED, totalPaid: TOTAL_PAID })
      .from(billsTable)
      .innerJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(and(notInArray(billsTable.status, NOT_IN_BOOKS), billNotReversed(), vendorListConditions(filter)));
    const totalBilled = Number(row?.totalBilled ?? 0);
    const totalPaid = Number(row?.totalPaid ?? 0);
    return { totalBilled, totalPaid, balance: totalBilled - totalPaid };
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
   * 🔴 There IS a sign case now. Until Phase 11 Part 2 this comment said there
   * was none because `bills` had no `document_type` — true when written, and
   * an obsolete assertion the day B7 added the column. The sign and the paid
   * figure come from `billPosition` (see TOTAL_BILLED / TOTAL_PAID above).
   *
   * Omit `vendorId` for every vendor (one grouped query, not N+1).
   */
  vendorBalances(vendorId?: number) {
    return db
      .select({
        vendorId: billsTable.vendorId,
        totalBilled: TOTAL_BILLED,
        totalPaid: TOTAL_PAID,
        billCount: sql<number>`COUNT(*)::int`,
      })
      .from(billsTable)
      .where(
        and(
          notInArray(billsTable.status, NOT_IN_BOOKS),
          billNotReversed(),
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
