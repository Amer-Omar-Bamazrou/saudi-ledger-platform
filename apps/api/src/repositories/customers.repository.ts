/**
 * Customers repository — all customer/AR data access. Queries run on the
 * request's tenant-scoped connection (RLS-enforced), so no explicit org filter
 * is added here (that is the established M4 enforcement mechanism).
 */
import { db, customersTable } from "@workspace/db";
import { and, eq, ilike, sql } from "drizzle-orm";
import { DEFAULT_PAGE } from "../lib/httpParams";
import { round2 } from "../lib/money";
import { customerStatementRepository, type CustomerPositionRow } from "./customerStatement.repository";

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

// Drafts and submitted invoices are NOT in the books, so they are not in a
// customer's balance either: `customerStatementRepository`'s IN_BOOKS mirrors
// `INVOICE_NOT_IN_BOOKS` in the reports repository; the two stay in lockstep.

/** The derived net, beside its three components — never stored, never a fourth definition. */
function withNet(r: CustomerPositionRow) {
  return { ...r, netPosition: round2(r.receivable - r.creditBalance - r.depositBalance) };
}

function sumPositions(rows: CustomerPositionRow[]) {
  const t = rows.reduce(
    (acc, r) => ({
      totalBilled: acc.totalBilled + r.totalBilled,
      totalPaid: acc.totalPaid + r.totalPaid,
      receivable: acc.receivable + r.receivable,
      creditBalance: acc.creditBalance + r.creditBalance,
      depositBalance: acc.depositBalance + r.depositBalance,
    }),
    { totalBilled: 0, totalPaid: 0, receivable: 0, creditBalance: 0, depositBalance: 0 },
  );
  const netPosition = round2(t.receivable - t.creditBalance - t.depositBalance);
  return {
    totalBilled: round2(t.totalBilled),
    totalPaid: round2(t.totalPaid),
    receivable: round2(t.receivable),
    creditBalance: round2(t.creditBalance),
    depositBalance: round2(t.depositBalance),
    netPosition,
    balance: netPosition,
  };
}

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
   * 🔴 Totals across every customer MATCHING THE FILTER — never across the
   * page. The same predicate as the rows, so the headline and the table can
   * never describe different sets (B-6). Phase E: the position components
   * come from `customerStatementRepository.positions` (one definition), and
   * `balance` is the NET position — receivable − credit − deposit — which is
   * what "what do our customers owe us, net" legitimately means; the three
   * components are beside it so a liability is never read as negative AR.
   */
  async listTotals(filter: CustomerListFilter) {
    const rows = await customerStatementRepository.positions({ restrictTo: customerListConditions(filter) });
    return sumPositions(rows);
  },

  findById(id: number) {
    return db.select().from(customersTable).where(eq(customersTable.id, id)).limit(1);
  },

  /**
   * 🔴 A customer's position, in SQL — ONE definition of what a customer owes
   * and of what we owe them.
   *
   * The Customers page has always shown "Total AR" and "Total Billed", and both
   * were always **0.00**: `list` returns the customer row, which has no balance
   * column, so the page's `c.balance ?? 0` summed a field the API never sent.
   * The confident zero, in the shape §3 names — a missing producer yields an
   * ANSWER rather than a gap, so nobody reports it.
   *
   * Phase E (2026-09-17): the old figure was Σ sign·total − Σ sign·paid, which
   * read an unapplied credit note or an over-payment as a NEGATIVE receivable.
   * Under D-4 those are liabilities with their own accounts, so the reader now
   * returns three non-negative components (`receivable`, `creditBalance`,
   * `depositBalance`) and derives `netPosition`; `balance` IS `netPosition`,
   * kept under its old name for every existing reader of "net exposure".
   * The definition lives in `customerStatementRepository.positions` so this
   * page, the detail, the statement and the ageing report cannot disagree.
   *
   * Omit `customerId` for every customer (one grouped query, not N+1).
   */
  async customerBalances(customerId?: number) {
    const rows = await customerStatementRepository.positions(customerId !== undefined ? { customerId } : {});
    return rows.map(withNet);
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
