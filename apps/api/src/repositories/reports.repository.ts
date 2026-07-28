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
  billsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  customersTable,
  vendorsTable,
} from "@workspace/db";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";

/** Posted-JE conditions used by most reports (status + optional date range). */
function jeConditions(date_from?: string, date_to?: string, statusFilter = true) {
  const conds: any[] = [];
  if (statusFilter) conds.push(eq(journalEntriesTable.status, "posted"));
  if (date_from) conds.push(gte(journalEntriesTable.date, date_from));
  if (date_to) conds.push(lte(journalEntriesTable.date, date_to));
  return conds;
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
  txWithCategory(date_from?: string, date_to?: string) {
    const conds: any[] = [];
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
    const conds: any[] = [eq(journalEntriesTable.status, "posted")];
    if (as_of) conds.push(lte(journalEntriesTable.date, as_of));
    return lineJoin().where(and(...conds));
  },
  allInvoices() {
    return db.select().from(invoicesTable);
  },
  allBills() {
    return db.select().from(billsTable);
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
      .where(inArray(journalEntryLinesTable.journalEntryId, ids));
  },

  // general-ledger
  glPreLines(date_from: string, account_id?: string, account_name?: string) {
    const preConds: any[] = [eq(journalEntriesTable.status, "posted"), sql`${journalEntriesTable.date} < ${date_from}`];
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
    const preConds: any[] = [eq(journalEntriesTable.status, "posted"), sql`${journalEntriesTable.date} < ${date_from}`];
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
    return lineJoin().where(and(eq(journalEntriesTable.status, "posted"), sql`${journalEntriesTable.date} < ${date_from}`));
  },
  acctSummaryPeriod(date_from?: string, date_to?: string) {
    return lineJoin().where(and(...jeConditions(date_from, date_to)));
  },

  // customer-ledger
  customerInvoices(customer_id?: string, date_from?: string, date_to?: string) {
    const conds: any[] = [];
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
    const preConds: any[] = [eq(journalEntriesTable.status, "posted"), sql`${journalEntriesTable.date} < ${date_from}`];
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

  // ar-aging / ap-aging
  invoicesWithCustomer() {
    return db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id));
  },
  billsWithVendor() {
    return db
      .select({ bill: billsTable, vendor: vendorsTable })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id));
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
      .where(inArray(journalEntriesTable.id, ids))
      .orderBy(desc(journalEntriesTable.date));
  },

  // activity
  activityEntries(date_from?: string, date_to?: string) {
    const conds: any[] = [];
    if (date_from) conds.push(gte(journalEntriesTable.date, date_from));
    if (date_to) conds.push(lte(journalEntriesTable.date, date_to));
    return db
      .select()
      .from(journalEntriesTable)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(journalEntriesTable.date), desc(journalEntriesTable.id))
      .limit(500);
  },

  // vat-return
  invoicesInRange(dateFrom: string, dateTo: string) {
    return db.select().from(invoicesTable).where(and(gte(invoicesTable.date, dateFrom), lte(invoicesTable.date, dateTo)));
  },
  billsInRange(dateFrom: string, dateTo: string) {
    return db.select().from(billsTable).where(and(gte(billsTable.date, dateFrom), lte(billsTable.date, dateTo)));
  },
};
