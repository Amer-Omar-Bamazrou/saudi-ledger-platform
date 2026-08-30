/**
 * Customers repository — all customer/AR data access. Queries run on the
 * request's tenant-scoped connection (RLS-enforced), so no explicit org filter
 * is added here (that is the established M4 enforcement mechanism).
 */
import { db, customersTable, invoicesTable } from "@workspace/db";
import { and, eq, ilike, notInArray, sql } from "drizzle-orm";
import { DEFAULT_PAGE } from "../lib/httpParams";

export interface CustomerListFilter {
  search?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

/** One predicate for the rows AND the count — so they cannot describe different sets. */
function customerListConditions(filter: CustomerListFilter) {
  const conditions = [];
  if (filter.search) conditions.push(ilike(customersTable.name, `%${filter.search}%`));
  if (filter.isActive !== undefined) conditions.push(eq(customersTable.isActive, filter.isActive));
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * Drafts and submitted invoices are NOT in the books, so they are not in a
 * customer's balance either. Mirrors `INVOICE_NOT_IN_BOOKS` in the reports
 * repository; the two must stay in lockstep.
 */
const NOT_IN_BOOKS = ["draft", "submitted"];

export const customersRepository = {
  list(filter: CustomerListFilter) {
    return db
      .select()
      .from(customersTable)
      .where(customerListConditions(filter))
      .orderBy(customersTable.name)
      .limit(filter.limit ?? DEFAULT_PAGE)
      .offset(filter.offset ?? 0);
  },

  /** Rows matching the filter — not rows on this page. */
  async listCount(filter: CustomerListFilter) {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(customersTable)
      .where(customerListConditions(filter));
    return Number(row?.total ?? 0);
  },

  /**
   * 🔴 Total AR across every customer MATCHING THE FILTER — never across the
   * page. The same predicate as the rows, so the headline and the table can
   * never describe different sets (B-6).
   */
  async listTotals(filter: CustomerListFilter) {
    const sign = sql`CASE WHEN ${invoicesTable.documentType} = 'credit_note' THEN -1 ELSE 1 END`;
    const [row] = await db
      .select({
        totalBilled: sql<number>`COALESCE(SUM(${sign} * ${invoicesTable.total}), 0)::float8`,
        totalPaid: sql<number>`COALESCE(SUM(${sign} * COALESCE(${invoicesTable.paidAmount}, 0)), 0)::float8`,
      })
      .from(invoicesTable)
      .innerJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(and(notInArray(invoicesTable.status, NOT_IN_BOOKS), customerListConditions(filter)));
    const totalBilled = Number(row?.totalBilled ?? 0);
    const totalPaid = Number(row?.totalPaid ?? 0);
    return { totalBilled, totalPaid, balance: totalBilled - totalPaid };
  },

  findById(id: number) {
    return db.select().from(customersTable).where(eq(customersTable.id, id)).limit(1);
  },

  /**
   * 🔴 AR per customer, in SQL — ONE definition of what a customer owes.
   *
   * The Customers page has always shown "Total AR" and "Total Billed", and both
   * were always **0.00**: `list` returns the customer row, which has no balance
   * column, so the page's `c.balance ?? 0` summed a field the API never sent.
   * The confident zero, in the shape §3 names — a missing producer yields an
   * ANSWER rather than a gap, so nobody reports it.
   *
   * It is computed here rather than in the service because `getById` needs the
   * same number, and a balance defined twice is a balance that will disagree
   * with itself. The sign convention is `documentSign`'s, stated in SQL: a
   * credit note reverses, a debit note does not.
   *
   * Omit `customerId` for every customer (one grouped query, not N+1).
   */
  customerBalances(customerId?: number) {
    const sign = sql`CASE WHEN ${invoicesTable.documentType} = 'credit_note' THEN -1 ELSE 1 END`;
    return db
      .select({
        customerId: invoicesTable.customerId,
        totalBilled: sql<number>`COALESCE(SUM(${sign} * ${invoicesTable.total}), 0)::float8`,
        totalPaid: sql<number>`COALESCE(SUM(${sign} * COALESCE(${invoicesTable.paidAmount}, 0)), 0)::float8`,
        invoiceCount: sql<number>`COUNT(*)::int`,
      })
      .from(invoicesTable)
      .where(
        and(
          notInArray(invoicesTable.status, NOT_IN_BOOKS),
          customerId !== undefined ? eq(invoicesTable.customerId, customerId) : undefined,
        ),
      )
      .groupBy(invoicesTable.customerId);
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
