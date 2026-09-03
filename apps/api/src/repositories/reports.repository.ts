/**
 * Reports repository — ALL read-only query logic for financial reports,
 * tenant-scoped via RLS. The pre-M6 `sql.raw(ids.join(","))` id-lists are
 * replaced with Drizzle's parameterized `inArray(...)` (same result set).
 */
import {
  db,
  transactionsTable,
  categoriesTable,
  invoicesTable,
  invoiceItemsTable,
  billsTable,
  billItemsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  customersTable,
  vendorsTable,
} from "@workspace/db";
import { and, asc, desc, eq, gte, ilike, inArray, lte, notInArray, or, sql } from "drizzle-orm";
import { companyScoped } from "./companyScope";

/**
 * 🔴 Journal-entry statuses that ARE the books (fixed 2026-08-17, found
 * during A's build).
 *
 * `reverse()` does TWO things: it posts a mirror entry AND flips the
 * original's status to 'reversed'. Filtering reports to 'posted' alone
 * therefore DOUBLE-NEGATED every reversal: the original's effect vanished
 * (excluded) while the mirror's opposite effect stayed (included), so a
 * reverse-and-repost left the books off by the original amount — observed
 * live as CASH −8,750 / SUSPENSE +8,750 on the dev org, from one M16.2-era
 * repost. The original entry HAPPENED; 'reversed' is a marker that it has a
 * cancelling twin, not an eraser. Both sides are in the books; only drafts
 * are not.
 */
export const JE_IN_BOOKS = ["posted", "reversed"];
/**
 * 🔴 N1 (2026-09-03): "the books" means THE SCOPED COMPANY'S books. Two
 * companies in one org are separate sets of books, and this helper is the one
 * shared root every JE-based report condition passes through — so the company
 * predicate lives HERE, inherited by every caller, rather than re-declared per
 * method (the per-path form is how fifteen repositories ended up blind; see
 * `companyScope.ts` and `docs/history/erpnext-comparison-2026-09-03.md` §1).
 */
const inBooks = () => and(inArray(journalEntriesTable.status, JE_IN_BOOKS), companyScoped(journalEntriesTable.companyId))!;

/** In-books JE conditions used by most reports (status + optional date range). */
function jeConditions(date_from?: string, date_to?: string, statusFilter = true) {
  const conds: any[] = [];
  if (statusFilter) conds.push(inBooks());
  if (date_from) conds.push(gte(journalEntriesTable.date, date_from));
  if (date_to) conds.push(lte(journalEntriesTable.date, date_to));
  return conds;
}

// Draft/approval workflow (M10.3): a bill affects AP/expense/VAT only once
// APPROVED. Draft and submitted (queued) bills are NOT in the books, so every
// money report that reads bills must exclude them. Kept as a shared condition
// so the AP-aging, balance-sheet-AP, and VAT-return bill queries stay in lockstep.
const BILL_NOT_IN_BOOKS = ["draft", "submitted"];
// N1: approved bills OF THE SCOPED COMPANY — company scoping inherited by
// every bill-reading report through this one helper.
const approvedBillsOnly = () => and(notInArray(billsTable.status, BILL_NOT_IN_BOOKS), companyScoped(billsTable.companyId))!;

// Draft/approval workflow (M10.4): an invoice affects AR/revenue/VAT only once
// APPROVED (issued). Draft and submitted invoices are NOT in the books — and are
// not even in the ZATCA hash chain — so every money report that reads invoices
// must exclude them. Shared so the AR-aging, balance-sheet-AR, VAT-sales, and
// customer-ledger queries stay in lockstep.
const INVOICE_NOT_IN_BOOKS = ["draft", "submitted"];
// N1: approved invoices OF THE SCOPED COMPANY — same inheritance as bills.
const approvedInvoicesOnly = () => and(notInArray(invoicesTable.status, INVOICE_NOT_IN_BOOKS), companyScoped(invoicesTable.companyId))!;

/**
 * The sign a document contributes to receivables, sales and output VAT (M12.1b).
 *
 * 🔴 READ THIS BEFORE WRITING A REPORT THAT SUMS INVOICE ROWS.
 *
 * Notes live in the `invoices` table with `document_type` = credit_note |
 * debit_note, and their amounts are stored **POSITIVE** — the direction is
 * carried by the type, not by the sign of the number.
 *
 * Storing negatives was considered and rejected because it FAILS SILENTLY:
 *   - AR aging skips them entirely (`if (outstanding < 0.01) continue`);
 *   - the VAT return misroutes them — a negative `vat_amount` computes a rate of
 *     0, so the note lands in the ZERO-RATED box and never reduces output VAT.
 * Balance-sheet AR and the customer ledger *would* net correctly, and two of
 * four reports being right is precisely what makes negatives dangerous.
 *
 * So: every consumer applies this explicitly, and forgetting it is a visible
 * omission rather than an invisible one. A DEBIT note is +1 — it is an
 * additional charge, not a reversal.
 */
export function documentSign(documentType: string | null | undefined): 1 | -1 {
  return documentType === "credit_note" ? -1 : 1;
}

const lineJoin = () =>
  db
    .select({
      accountName: journalEntryLinesTable.accountName,
      accountId: journalEntryLinesTable.accountId,
      debit: journalEntryLinesTable.debitAmount,
      credit: journalEntryLinesTable.creditAmount,
    })
    .from(journalEntryLinesTable)
    .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id));

export const reportsRepository = {
  allCategories() {
    return db.select().from(categoriesTable);
  },
  categoriesByType(type: string) {
    return db.select().from(categoriesTable).where(eq(categoriesTable.type, type));
  },
  categoryById(id: number) {
    return db.select().from(categoriesTable).where(eq(categoriesTable.id, id)).limit(1);
  },

  // trial-balance + income-statement: posted lines {accountName, accountId, debit, credit}
  jeLines(date_from?: string, date_to?: string) {
    return lineJoin().where(and(...jeConditions(date_from, date_to)));
  },

  // income-statement fallback + cash-flow: transactions joined to categories in a date range
  txWithCategory(date_from?: string, date_to?: string, opts?: { includeNonOperating?: boolean }) {
    // M15 holding area: pending rows move nothing in cash flow or the
    // income-statement transaction fallback.
    const conds: any[] = [eq(transactionsTable.reviewStatus, "accepted"), companyScoped(transactionsTable.companyId)];
    // M16.2 — transfers/settlements are excluded from P&L-type readers by
    // DEFAULT; only cash flow opts in, because the bank balance genuinely
    // moved. A new consumer that wants transfers must say so explicitly.
    if (!opts?.includeNonOperating) conds.push(eq(transactionsTable.kind, "operating"));
    if (date_from) conds.push(gte(transactionsTable.date, date_from));
    if (date_to) conds.push(lte(transactionsTable.date, date_to));
    return db
      .select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(conds.length > 0 ? and(...conds) : undefined);
  },

  // balance-sheet: posted lines as-of a date
  bsLines(as_of?: string) {
    const conds: any[] = [inBooks()];
    if (as_of) conds.push(lte(journalEntriesTable.date, as_of));
    return lineJoin().where(and(...conds));
  },
  // balance-sheet AR — approved invoices only (drafts/submitted are not in the books).
  allInvoices() {
    return db.select().from(invoicesTable).where(approvedInvoicesOnly());
  },
  // balance-sheet AP — approved bills only (drafts/submitted are not in the books).
  allBills() {
    return db.select().from(billsTable).where(approvedBillsOnly());
  },

  // journal-report + activity
  postedEntries(date_from?: string, date_to?: string) {
    return db
      .select()
      .from(journalEntriesTable)
      .where(and(...jeConditions(date_from, date_to)))
      .orderBy(desc(journalEntriesTable.date), desc(journalEntriesTable.id));
  },
  jeLinesByEntryIds(ids: number[]) {
    return db
      .select()
      .from(journalEntryLinesTable)
      .where(and(inArray(journalEntryLinesTable.journalEntryId, ids), companyScoped(journalEntryLinesTable.companyId)));
  },

  // general-ledger
  glPreLines(date_from: string, account_id?: string, account_name?: string) {
    const preConds: any[] = [inBooks(), sql`${journalEntriesTable.date} < ${date_from}`];
    if (account_id) preConds.push(eq(journalEntryLinesTable.accountId, Number(account_id)));
    else if (account_name) preConds.push(eq(journalEntryLinesTable.accountName, account_name));
    return db
      .select({ debit: journalEntryLinesTable.debitAmount, credit: journalEntryLinesTable.creditAmount })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...preConds));
  },
  glRows(date_from?: string, date_to?: string, account_id?: string, account_name?: string) {
    const conds = jeConditions(date_from, date_to);
    if (account_id) conds.push(eq(journalEntryLinesTable.accountId, Number(account_id)));
    if (account_name && !account_id) conds.push(eq(journalEntryLinesTable.accountName, account_name));
    return db
      .select({
        lineId: journalEntryLinesTable.id,
        jeId: journalEntriesTable.id,
        entryNumber: journalEntriesTable.entryNumber,
        date: journalEntriesTable.date,
        description: journalEntriesTable.description,
        reference: journalEntriesTable.reference,
        lineDesc: journalEntryLinesTable.description,
        accountName: journalEntryLinesTable.accountName,
        accountId: journalEntryLinesTable.accountId,
        debit: journalEntryLinesTable.debitAmount,
        credit: journalEntryLinesTable.creditAmount,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds))
      .orderBy(asc(journalEntriesTable.date), asc(journalEntriesTable.id));
  },

  // account-statement
  acctStmtPre(date_from: string, account_id?: string, account_name?: string) {
    const preConds: any[] = [inBooks(), sql`${journalEntriesTable.date} < ${date_from}`];
    if (account_id) preConds.push(eq(journalEntryLinesTable.accountId, Number(account_id)));
    else preConds.push(eq(journalEntryLinesTable.accountName, account_name as string));
    return db
      .select({ d: journalEntryLinesTable.debitAmount, c: journalEntryLinesTable.creditAmount })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...preConds));
  },
  acctStmtRows(date_from?: string, date_to?: string, account_id?: string, account_name?: string) {
    const conds = jeConditions(date_from, date_to);
    if (account_id) conds.push(eq(journalEntryLinesTable.accountId, Number(account_id)));
    else if (account_name) conds.push(eq(journalEntryLinesTable.accountName, account_name));
    return db
      .select({
        date: journalEntriesTable.date,
        entryNumber: journalEntriesTable.entryNumber,
        reference: journalEntriesTable.reference,
        description: journalEntriesTable.description,
        lineDesc: journalEntryLinesTable.description,
        debit: journalEntryLinesTable.debitAmount,
        credit: journalEntryLinesTable.creditAmount,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds))
      .orderBy(asc(journalEntriesTable.date));
  },

  // account-summary
  acctSummaryPre(date_from: string) {
    return lineJoin().where(and(inBooks(), sql`${journalEntriesTable.date} < ${date_from}`));
  },
  acctSummaryPeriod(date_from?: string, date_to?: string) {
    return lineJoin().where(and(...jeConditions(date_from, date_to)));
  },

  // customer-ledger — approved invoices only (a draft is not a receivable yet).
  customerInvoices(customer_id?: string, date_from?: string, date_to?: string) {
    const conds: any[] = [approvedInvoicesOnly()];
    if (customer_id) conds.push(eq(invoicesTable.customerId, Number(customer_id)));
    if (date_from) conds.push(gte(invoicesTable.date, date_from));
    if (date_to) conds.push(lte(invoicesTable.date, date_to));
    return db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(asc(customersTable.name), asc(invoicesTable.date));
  },

  // owner-equity
  ownerEquityPre(date_from: string) {
    const preConds: any[] = [inBooks(), sql`${journalEntriesTable.date} < ${date_from}`];
    return db
      .select({
        d: journalEntryLinesTable.debitAmount,
        c: journalEntryLinesTable.creditAmount,
        accountId: journalEntryLinesTable.accountId,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...preConds));
  },
  ownerEquityIncomeLines(date_from?: string, date_to?: string) {
    return db
      .select({
        accountId: journalEntryLinesTable.accountId,
        debit: journalEntryLinesTable.debitAmount,
        credit: journalEntryLinesTable.creditAmount,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...jeConditions(date_from, date_to)));
  },

  // ar-aging — approved invoices only (drafts/submitted are not receivables yet).
  invoicesWithCustomer() {
    return db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(approvedInvoicesOnly());
  },
  // ap-aging — approved bills only (drafts/submitted are not payable AP yet).
  billsWithVendor() {
    return db
      .select({ bill: billsTable, vendor: vendorsTable })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(approvedBillsOnly());
  },

  // tax-journal-entries
  taxLineEntryIds(date_from?: string, date_to?: string) {
    return db
      .select({ journalEntryId: journalEntryLinesTable.journalEntryId })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(
        and(
          ...jeConditions(date_from, date_to),
          or(
            ilike(journalEntryLinesTable.accountName, "%vat%"),
            ilike(journalEntryLinesTable.accountName, "%tax%"),
            ilike(journalEntryLinesTable.accountName, "%ضريبة%"),
            ilike(journalEntryLinesTable.accountName, "%زكاة%"),
          ),
        ),
      );
  },
  entriesByIds(ids: number[]) {
    return db
      .select()
      .from(journalEntriesTable)
      .where(and(inArray(journalEntriesTable.id, ids), companyScoped(journalEntriesTable.companyId)))
      .orderBy(desc(journalEntriesTable.date));
  },

  // activity
  activityEntries(date_from?: string, date_to?: string) {
    const conds: any[] = [companyScoped(journalEntriesTable.companyId)];
    if (date_from) conds.push(gte(journalEntriesTable.date, date_from));
    if (date_to) conds.push(lte(journalEntriesTable.date, date_to));
    return db
      .select()
      .from(journalEntriesTable)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(journalEntriesTable.date), desc(journalEntriesTable.id))
      .limit(500);
  },

  // vat-return (sales/output-VAT side) — approved invoices only.
  invoicesInRange(dateFrom: string, dateTo: string) {
    return db
      .select()
      .from(invoicesTable)
      .where(and(gte(invoicesTable.date, dateFrom), lte(invoicesTable.date, dateTo), approvedInvoicesOnly()));
  },
  // vat-return (bill/input-VAT side) — approved bills only.
  billsInRange(dateFrom: string, dateTo: string) {
    return db
      .select()
      .from(billsTable)
      .where(and(gte(billsTable.date, dateFrom), lte(billsTable.date, dateTo), approvedBillsOnly()));
  },

  /**
   * VAT-return LINE-LEVEL queries (audit Tier 1, finding 1).
   *
   * 🔴 The return must classify per LINE from `invoice_items.tax_category_code`
   * — never by reconstructing a rate from rounded header cents. The header
   * inference (`vat/subtotal*100` with `>= 14.9` / `=== 0` branches) silently
   * DROPPED every mixed-rate document (one S line + one Z line ⇒ header rate
   * 7.5% ⇒ matched neither branch ⇒ absent from every box, including its
   * posted output VAT) and every 15% invoice small enough for the rounded rate
   * to fall under 14.9%. Credit notes against such documents never reduced
   * output VAT — the exact failure `documentSign()` exists to prevent,
   * reintroduced through the threshold instead of the sign.
   */
  invoiceLinesInRange(dateFrom: string, dateTo: string) {
    return db
      .select({ line: invoiceItemsTable, invoiceId: invoiceItemsTable.invoiceId })
      .from(invoiceItemsTable)
      .innerJoin(invoicesTable, eq(invoiceItemsTable.invoiceId, invoicesTable.id))
      .where(and(gte(invoicesTable.date, dateFrom), lte(invoicesTable.date, dateTo), approvedInvoicesOnly()));
  },
  /** Bill lines carry no ZATCA category (vendor documents) — classification is
   *  per-line VAT presence, which still fixes the mixed-rate hole. */
  billLinesInRange(dateFrom: string, dateTo: string) {
    return db
      .select({ line: billItemsTable, billId: billItemsTable.billId })
      .from(billItemsTable)
      .innerJoin(billsTable, eq(billItemsTable.billId, billsTable.id))
      .where(and(gte(billsTable.date, dateFrom), lte(billsTable.date, dateTo), approvedBillsOnly()));
  },
};
