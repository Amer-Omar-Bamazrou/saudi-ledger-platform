/**
 * Analytics repository — the trend read model (M19.1). Tenant-scoped via RLS.
 *
 * 🔴 ONE QUERY, NOT ONE PER POINT.
 *
 * The obvious build for a liquidity trend is a loop over
 * `reportsService.balanceSheet(as_of)`. That is a CUMULATIVE query — it reads
 * every posted GL line from the beginning of time for each call — so N points
 * cost `O(N × lines)`, and since `lines` grows with history the real shape is
 * quadratic in how long the tenant has been a customer. Measured at 4,612ms for
 * 12 points over 6,000 lines, against 138ms over 61: fine in dev, unusable
 * exactly when a customer finally has enough history to want a trend.
 *
 * So this reads each line ONCE, pre-aggregated by (month, account) in Postgres,
 * and the service folds forward. The DB does the grouping because it is far
 * better at it than a JS reduce over every row.
 *
 * Semantics are copied deliberately from `reportsRepository.bsLines`: posted
 * entries only, `date <= as_of`. A trend that disagreed with the balance sheet
 * it is charting would be meta-finding #9 in a new costume.
 */
import {
  db,
  journalEntriesTable,
  journalEntryLinesTable,
  categoriesTable,
  transactionsTable,
  invoicesTable,
  billsTable,
  customersTable,
  vendorsTable,
} from "@workspace/db";
import { and, eq, gte, lte, notInArray, sql } from "drizzle-orm";
import { taxVisible } from "./summary.repository";

export interface MonthlyAccountMovement {
  /** `YYYY-MM` — the month the movement fell in. */
  month: string;
  accountId: number | null;
  /** `income | expense | asset | liability | equity`, or null for an unresolved line. */
  type: string | null;
  /** `cash | quick | current | non_current`, or NULL = unclassified (M18.1). */
  liquidityClass: string | null;
  systemCode: string | null;
  debit: string;
  credit: string;
}

export const analyticsRepository = {
  /**
   * Every posted movement up to `asOf`, summed per (month, account).
   *
   * Returns from the beginning of time — NOT from the window start — because a
   * balance is cumulative: the opening position of the first charted month is
   * the sum of everything before it. Aggregating in SQL keeps that cheap; the
   * row count is bounded by (months × accounts), not by transactions.
   */
  monthlyMovements(asOf: string) {
    return db
      .select({
        month: sql<string>`to_char(${journalEntriesTable.date}::date, 'YYYY-MM')`,
        accountId: journalEntryLinesTable.accountId,
        type: categoriesTable.type,
        liquidityClass: categoriesTable.liquidityClass,
        systemCode: categoriesTable.systemCode,
        debit: sql<string>`coalesce(sum(${journalEntryLinesTable.debitAmount}), 0)`,
        credit: sql<string>`coalesce(sum(${journalEntryLinesTable.creditAmount}), 0)`,
      })
      .from(journalEntryLinesTable)
      .innerJoin(
        journalEntriesTable,
        eq(journalEntriesTable.id, journalEntryLinesTable.journalEntryId),
      )
      .leftJoin(categoriesTable, eq(categoriesTable.id, journalEntryLinesTable.accountId))
      .where(and(eq(journalEntriesTable.status, "posted"), lte(journalEntriesTable.date, asOf)))
      .groupBy(
        sql`to_char(${journalEntriesTable.date}::date, 'YYYY-MM')`,
        journalEntryLinesTable.accountId,
        categoriesTable.type,
        categoriesTable.liquidityClass,
        categoriesTable.systemCode,
      )
      .orderBy(sql`to_char(${journalEntriesTable.date}::date, 'YYYY-MM')`);
  },

  /**
   * ── M19.2: per-dimension totals for one window ────────────────────────────
   *
   * 🔴 Each of these reuses the SAME filter every other money report uses, so a
   * decomposition can never disagree with the report it is explaining:
   *
   *   transactions  `taxVisible()` — accepted AND operating (M15 + M16.2)
   *   invoices      approved only, with `documentSign` applied per row so a
   *                 credit note SUBTRACTS (M12.1b)
   *   bills         approved only
   *
   * Signing invoices is done in SQL rather than in the service because the
   * grouping has to happen after the sign — summing magnitudes and negating
   * afterwards would make a credited customer look like their biggest month.
   */
  categoryTotals(from: string, to: string) {
    return db
      .select({
        id: sql<string>`coalesce(${transactionsTable.categoryId}::text, 'uncategorised')`,
        name: sql<string>`coalesce(max(${categoriesTable.name}), 'Uncategorised')`,
        nameAr: sql<string>`coalesce(max(${categoriesTable.nameAr}), 'غير مصنف')`,
        total: sql<string>`coalesce(sum(
          case when ${transactionsTable.type} = 'debit'
               then ${transactionsTable.amount}::numeric
               else -${transactionsTable.amount}::numeric end), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(categoriesTable.id, transactionsTable.categoryId))
      .where(
        and(
          taxVisible(),
          gte(transactionsTable.date, from),
          lte(transactionsTable.date, to),
        ),
      )
      .groupBy(transactionsTable.categoryId);
  },

  customerTotals(from: string, to: string) {
    return db
      .select({
        id: sql<string>`coalesce(${invoicesTable.customerId}::text, 'none')`,
        name: sql<string>`coalesce(max(${customersTable.name}), 'No customer')`,
        nameAr: sql<string>`coalesce(max(${customersTable.nameAr}), '')`,
        total: sql<string>`coalesce(sum(
          case when ${invoicesTable.documentType} = 'credit_note'
               then -${invoicesTable.total}::numeric
               else ${invoicesTable.total}::numeric end), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(customersTable.id, invoicesTable.customerId))
      .where(
        and(
          notInArray(invoicesTable.status, ["draft", "submitted"]),
          gte(invoicesTable.date, from),
          lte(invoicesTable.date, to),
        ),
      )
      .groupBy(invoicesTable.customerId);
  },

  vendorTotals(from: string, to: string) {
    return db
      .select({
        id: sql<string>`coalesce(${billsTable.vendorId}::text, 'none')`,
        name: sql<string>`coalesce(max(${vendorsTable.name}), 'No vendor')`,
        nameAr: sql<string>`coalesce(max(${vendorsTable.nameAr}), '')`,
        total: sql<string>`coalesce(sum(${billsTable.total}::numeric), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(vendorsTable.id, billsTable.vendorId))
      .where(
        and(
          notInArray(billsTable.status, ["draft", "submitted"]),
          gte(billsTable.date, from),
          lte(billsTable.date, to),
        ),
      )
      .groupBy(billsTable.vendorId);
  },
  /**
   * The RECEIVABLES BRIDGE, per month — every movement on the AR account,
   * split by what the other side of the entry was (design §4).
   *
   * ── 🔴 Why all five terms come from ONE account's journal lines ───────────
   * The bridge is an identity:
   *
   *     opening + invoiced − collected − credited − other = closing
   *
   * It holds **by construction** here, because every term is a debit or a
   * credit on the SAME account: the sum of debits less the sum of credits IS
   * the change in the balance, however the credits are labelled. Taking
   * `invoiced` from `invoices.total` and `closing` from the GL would produce
   * five numbers from two stores that agree only by luck — meta-finding #9 in a
   * new costume, and an identity that "usually reconciles" is worth nothing.
   *
   * So the split is a LABELLING of the credit side, never a second computation.
   *
   * ── How the label is decided ──────────────────────────────────────────────
   * By the contra lines of the same entry, matching what the posting path
   * actually writes (`invoices.approvable.ts`, `invoices.service.pay`):
   *
   *   Dr AR                          → invoiced   (invoice or DEBIT note —
   *                                                 a debit note posts like an
   *                                                 invoice, it does not reverse)
   *   Cr AR, entry debits cash       → collected
   *   Cr AR, entry debits income     → credited   (credit note reverses revenue)
   *   Cr AR, anything else           → other
   *
   * `other` is deliberately reported rather than folded into `credited`: a
   * write-off or an offset is neither a payment nor a credit note, and a bridge
   * that silently mislabels it would be describing a movement it did not
   * understand. Zero in ordinary use; visible the moment it is not.
   *
   * Returns from the beginning of time, like `monthlyMovements` — the opening
   * balance of the first charted month is the sum of everything before it.
   */
  async monthlyReceivables(asOf: string) {
    const res = await db.execute<{
      month: string;
      invoiced: string;
      collected: string;
      credited: string;
      other: string;
    }>(sql`
      WITH ar AS (
        SELECT e.id AS entry_id,
               to_char(e.date::date, 'YYYY-MM') AS month,
               l.debit_amount  AS dr,
               l.credit_amount AS cr
          FROM journal_entry_lines l
          JOIN journal_entries e ON e.id = l.journal_entry_id
          JOIN categories c      ON c.id = l.account_id
         WHERE e.status = 'posted'
           AND e.date <= ${asOf}
           AND c.system_code = 'AR'
      ),
      contra AS (
        SELECT ar.entry_id,
               bool_or(c2.liquidity_class = 'cash')       AS has_cash,
               bool_or(c2.type IN ('income', 'revenue'))  AS has_income
          FROM ar
          JOIN journal_entry_lines l2 ON l2.journal_entry_id = ar.entry_id
          LEFT JOIN categories c2     ON c2.id = l2.account_id
         WHERE coalesce(c2.system_code, '') <> 'AR'
         GROUP BY ar.entry_id
      )
      SELECT ar.month,
             coalesce(sum(ar.dr), 0)::text AS invoiced,
             -- 🔴 coalesce, not a bare boolean: a NULL from either the LEFT JOIN
             -- or an unresolved contra account makes every FILTER predicate
             -- NULL, so the credit would fall into NO bucket and silently
             -- break the identity. Every credit must land in exactly one.
             coalesce(sum(ar.cr) FILTER (WHERE coalesce(contra.has_cash, false)), 0)::text AS collected,
             coalesce(sum(ar.cr) FILTER (WHERE NOT coalesce(contra.has_cash, false)
                                           AND coalesce(contra.has_income, false)), 0)::text AS credited,
             coalesce(sum(ar.cr) FILTER (WHERE NOT coalesce(contra.has_cash, false)
                                           AND NOT coalesce(contra.has_income, false)), 0)::text AS other
        FROM ar
        LEFT JOIN contra ON contra.entry_id = ar.entry_id
       GROUP BY ar.month
       ORDER BY ar.month
    `);
    return ((res as unknown as { rows: unknown[] }).rows ?? []) as {
      month: string;
      invoiced: string;
      collected: string;
      credited: string;
      other: string;
    }[];
  },
};
