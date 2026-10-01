/**
 * Reports repository — ALL read-only query logic for financial reports,
 * tenant-scoped via RLS. The pre-M6 `sql.raw(ids.join(","))` id-lists are
 * replaced with Drizzle's parameterized `inArray(...)` (same result set).
 */
import {
  db,
  categoriesTable,
  TAX_ACCOUNT_SYSTEM_CODES,
  invoicesTable,
  invoiceItemsTable,
  invoicePrepaymentsTable,
  billsTable,
  billItemsTable,
  journalEntriesTable,
  journalEntryLinesTable,
  customersTable,
  vendorsTable, billPrepaymentsTable, assetCategoriesTable } from "@workspace/db";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lte, notInArray, or, sql } from "drizzle-orm";
import { companyScoped } from "./companyScope";
import { invoiceNotReversed, billNotReversed } from "./openingReversal";
import { billOutstandingSql } from "./billPosition";

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
/** D14-03 — a Batch 1C migration opening entry (or its whole-batch reversal): never a cash flow. */
const isOpeningSourceEntry = () => sql`coalesce(${journalEntriesTable.source}, '') in ('opening', 'opening_reversal')`;
/**
 * D14-03, refined (accounting review, 2026-10-01): of a migration opening entry, only the
 * BALANCE-SHEET lines are an opening balance. Its INCOME and EXPENSE lines are the previous
 * system's year-to-date P&L, which belongs to the fiscal year (Batch 1C R5) — period movement,
 * exactly as the income statement already counts it — so the trial balance, the general ledger
 * and the statement of changes in equity agree with the P&L. (ERPNext forbids P&L accounts in an
 * opening entry, so its `is_opening` precedent only ever covered balance-sheet lines.)
 */
const plAccountLine = () => sql`${journalEntryLinesTable.accountId} in (select c.id from categories c where c.type in ('income', 'revenue', 'expense'))`;
const openingBalanceLine = () => sql`(${isOpeningSourceEntry()} and not coalesce(${plAccountLine()}, false))`;

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
// Policy C: a reversed opening bill is out of every money report (openingReversal.ts).
const approvedBillsOnly = () => and(notInArray(billsTable.status, BILL_NOT_IN_BOOKS), billNotReversed(), companyScoped(billsTable.companyId))!;
/**
 * Phase 13A — a bill whose input VAT is CLAIMED, in the period of its claim
 * date (see `billsClaimedInRange`). NULL state = posted outside the approval:
 * claimed on its own date, the pre-Phase-13 reading.
 */
const claimedInputVatIn = (dateFrom: string, dateTo: string) =>
  sql`(coalesce(${billsTable.inputVatState}, 'claimed') = 'claimed'
       AND coalesce(${billsTable.inputVatClaimedOn}, ${billsTable.date}) BETWEEN ${dateFrom} AND ${dateTo})`;

// Draft/approval workflow (M10.4): an invoice affects AR/revenue/VAT only once
// APPROVED (issued). Draft and submitted invoices are NOT in the books — and are
// not even in the ZATCA hash chain — so every money report that reads invoices
// must exclude them. Shared so the AR-aging, balance-sheet-AR, VAT-sales, and
// customer-ledger queries stay in lockstep.
export const INVOICE_NOT_IN_BOOKS = ["draft", "submitted"];
// N1: approved invoices OF THE SCOPED COMPANY — same inheritance as bills.
// Policy C: a reversed opening invoice is out of every money report (openingReversal.ts).
const approvedInvoicesOnly = () => and(notInArray(invoicesTable.status, INVOICE_NOT_IN_BOOKS), invoiceNotReversed(), companyScoped(invoicesTable.companyId))!;

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
  // AP-3: a credit note against an advance tax invoice reverses the advance's declared base and VAT (the return reads its line negative, in the note's period — IR Art. 40(5)).
  return documentType === "credit_note" || documentType === "advance_credit_note" ? -1 : 1;
}

export type GlParty = { type: "customer" | "vendor"; id: number };
const partyCondition = (p: GlParty) =>
  p.type === "customer"
    ? and(eq(journalEntryLinesTable.partyType, "customer"), eq(journalEntryLinesTable.customerId, p.id))!
    : and(eq(journalEntryLinesTable.partyType, "vendor"), eq(journalEntryLinesTable.vendorId, p.id))!;

export const reportsRepository = {
  allCategories() {
    return db.select().from(categoriesTable);
  },
  /** The COST and accumulated-depreciation accounts this company's asset categories bind to — investing in the cash flow whatever their liquidity class (accounting review L1). */
  fixedAssetAccounts() {
    return db
      .select({ cost: assetCategoriesTable.costAccountId, accumulated: assetCategoriesTable.accumulatedDepreciationAccountId })
      .from(assetCategoriesTable)
      .where(companyScoped(assetCategoriesTable.companyId));
  },
  categoryById(id: number) {
    return db.select().from(categoriesTable).where(eq(categoriesTable.id, id)).limit(1);
  },

  /**
   * 🔴 PHASE 14 — THE LEDGER AGGREGATION SEAM (D14-01, 2026-10-01).
   *
   * Every GL-derived statement figure (trial balance, P&L, balance sheet,
   * owner equity, account summary, budget actuals) is ONE grouped SQL query
   * here — never the whole ledger loaded into the process and summed as
   * floats (the pre-Phase-14 shape, which both held every line of the books in
   * memory and accumulated IEEE-754 error before rounding).
   *
   * - The books: `inBooks()` — posted + reversed (the reversal's mirror is in
   *   the books too) AND the scoped company (N1). RLS is the second layer.
   * - The date: the ACCOUNTING date, `journal_entries.date`. Never posted_at
   *   or created_at.
   * - `opening` = Σ(debit − credit) of lines dated before `from`, plus — when
   *   `openingSourcesAsOpening` — migration opening entries anywhere in the
   *   window (D14-03: `journal_entries.source`'s contract — "readers that must
   *   exclude the opening from period MOVEMENT key on this, never on the date").
   * - `debit` / `credit` = the period movement (everything else up to `to`).
   * - Amounts come back as DECIMAL STRINGS from `numeric` sums; callers carry
   *   them through `lib/money.ts` `toHalalas` — exact to the halala.
   * - Grouped by account id; a legacy line with no account id is grouped by its
   *   stored name (`legacyName`), as every report here always keyed it.
   */
  ledgerBalances(opts: { from?: string; to?: string; openingSourcesAsOpening?: boolean; accountIds?: number[]; movementOnly?: boolean } = {}) {
    const isOpeningSource = openingBalanceLine();
    // `movementOnly` (P&L, cash-flow-style readers): the window's movement and
    // nothing before it — the scan is BOUNDED at `from`, not the whole history
    // summed into an opening the caller would discard.
    const openingCond = opts.movementOnly
      ? sql`false`
      : opts.from
      ? opts.openingSourcesAsOpening
        ? sql`(${journalEntriesTable.date} < ${opts.from} or ${isOpeningSource})`
        : sql`(${journalEntriesTable.date} < ${opts.from})`
      : opts.openingSourcesAsOpening
        ? sql`(${isOpeningSource})`
        : sql`false`;
    const legacyName = sql<string | null>`case when ${journalEntryLinesTable.accountId} is null then ${journalEntryLinesTable.accountName} end`;
    const conds: any[] = [inBooks()];
    if (opts.to) conds.push(lte(journalEntriesTable.date, opts.to));
    if (opts.movementOnly && opts.from) conds.push(gte(journalEntriesTable.date, opts.from));
    if (opts.accountIds) conds.push(opts.accountIds.length > 0 ? inArray(journalEntryLinesTable.accountId, opts.accountIds) : sql`false`);
    return db
      .select({
        accountId: journalEntryLinesTable.accountId,
        legacyName,
        opening: sql<string>`coalesce(sum(case when ${openingCond} then ${journalEntryLinesTable.debitAmount} - ${journalEntryLinesTable.creditAmount} end), 0)::text`,
        debit: sql<string>`coalesce(sum(case when not ${openingCond} then ${journalEntryLinesTable.debitAmount} end), 0)::text`,
        credit: sql<string>`coalesce(sum(case when not ${openingCond} then ${journalEntryLinesTable.creditAmount} end), 0)::text`,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds))
      .groupBy(journalEntryLinesTable.accountId, legacyName);
  },

  /**
   * The same seam, bucketed by explicit periods (D14-12 P&L trend, D15 budget
   * actuals). `periods` are inclusive [start, end] accounting-date ranges the
   * CALLER resolved (calendar months, or fiscal months in a Hijri year) — this
   * query never invents a period boundary. Lines outside every period are not
   * read at all (the WHERE bounds the scan to [min start, max end]).
   */
  ledgerMovementsByPeriod(periods: { key: string; start: string; end: string }[], opts: { accountIds?: number[]; excludeOpeningSources?: boolean } = {}) {
    if (periods.length === 0) return Promise.resolve([] as { period: string; accountId: number | null; legacyName: string | null; debit: string; credit: string }[]);
    const starts = periods.map((p) => p.start).sort();
    const ends = periods.map((p) => p.end).sort();
    const periodKey = sql<string>`case ${sql.join(periods.map((p) => sql`when ${journalEntriesTable.date} between ${p.start} and ${p.end} then ${p.key}::text`), sql` `)} end`;
    const legacyName = sql<string | null>`case when ${journalEntryLinesTable.accountId} is null then ${journalEntryLinesTable.accountName} end`;
    const conds: any[] = [inBooks(), gte(journalEntriesTable.date, starts[0]!), lte(journalEntriesTable.date, ends[ends.length - 1]!)];
    if (opts.accountIds) conds.push(opts.accountIds.length > 0 ? inArray(journalEntryLinesTable.accountId, opts.accountIds) : sql`false`);
    if (opts.excludeOpeningSources) conds.push(sql`not ${isOpeningSourceEntry()}`);
    return db
      .select({
        period: periodKey,
        accountId: journalEntryLinesTable.accountId,
        legacyName,
        debit: sql<string>`coalesce(sum(${journalEntryLinesTable.debitAmount}), 0)::text`,
        credit: sql<string>`coalesce(sum(${journalEntryLinesTable.creditAmount}), 0)::text`,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds))
      // By select-list POSITION: the period CASE carries bind parameters, and a
      // GROUP BY copy of it would be numbered differently ($n) — Postgres would
      // then see two different expressions and refuse.
      .groupBy(sql`1`, sql`2`, sql`3`);
  },

  /**
   * Migration opening entries' lines per account in [from, to], with their date: the previous
   * system's year-to-date figures. The P&L trend and budget vs actual keep them OUT of the monthly
   * buckets — a year's movement booked on one day would read as that month's — and show them as
   * one amount on its date, never apportioned (accounting review M2, 2026-10-01).
   */
  openingSourceMovements(from: string, to: string, opts: { accountIds?: number[] } = {}) {
    const conds: any[] = [inBooks(), isOpeningSourceEntry(), gte(journalEntriesTable.date, from), lte(journalEntriesTable.date, to)];
    if (opts.accountIds) conds.push(opts.accountIds.length > 0 ? inArray(journalEntryLinesTable.accountId, opts.accountIds) : sql`false`);
    return db
      .select({
        accountId: journalEntryLinesTable.accountId,
        date: sql<string>`max(${journalEntriesTable.date})`,
        debit: sql<string>`coalesce(sum(${journalEntryLinesTable.debitAmount}), 0)::text`,
        credit: sql<string>`coalesce(sum(${journalEntryLinesTable.creditAmount}), 0)::text`,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds))
      .groupBy(journalEntryLinesTable.accountId);
  },

  /**
   * D14-07 — the cash flow's two ledger reads, both over the entries of the
   * window that touch a CASH account (`cashIds`, liquidity class 'cash'):
   *
   * `cashFlowContributions` — per NON-cash account, Σ(credit − debit) of its
   * lines in those entries. An entry balances, so Σ contributions of an entry =
   * its net cash movement EXACTLY: the cash an entry moved is attributed to the
   * accounts on the other side of it, with no pro-rata estimate anywhere.
   * Migration opening entries are excluded (D14-03 — the cut-over position is
   * an opening balance, never a cash flow); they are read separately below.
   *
   * `cashFromOpeningSources` — Σ(debit − credit) of cash lines in migration
   * opening entries dated in the window: the reconciling line "opening
   * balances brought in by migration".
   */
  cashFlowContributions(from: string | undefined, to: string | undefined, cashIds: number[]) {
    if (cashIds.length === 0) return Promise.resolve([] as { accountId: number | null; legacyName: string | null; amount: string }[]);
    const entryConds: any[] = [inBooks(), inArray(journalEntryLinesTable.accountId, cashIds), sql`not ${isOpeningSourceEntry()}`];
    if (from) entryConds.push(gte(journalEntriesTable.date, from));
    if (to) entryConds.push(lte(journalEntriesTable.date, to));
    const cashEntries = db
      .selectDistinct({ id: journalEntryLinesTable.journalEntryId })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...entryConds));
    const legacyName = sql<string | null>`case when ${journalEntryLinesTable.accountId} is null then ${journalEntryLinesTable.accountName} end`;
    return db
      .select({
        accountId: journalEntryLinesTable.accountId,
        legacyName,
        amount: sql<string>`coalesce(sum(${journalEntryLinesTable.creditAmount} - ${journalEntryLinesTable.debitAmount}), 0)::text`,
      })
      .from(journalEntryLinesTable)
      .where(and(
        inArray(journalEntryLinesTable.journalEntryId, cashEntries),
        companyScoped(journalEntryLinesTable.companyId),
        sql`(${journalEntryLinesTable.accountId} is null or ${journalEntryLinesTable.accountId} not in (${sql.join(cashIds.map((id) => sql`${id}`), sql`, `)}))`,
      ))
      .groupBy(journalEntryLinesTable.accountId, legacyName);
  },
  cashFromOpeningSources(from: string | undefined, to: string | undefined, cashIds: number[]) {
    if (cashIds.length === 0) return Promise.resolve([{ amount: "0" }]);
    const conds: any[] = [inBooks(), inArray(journalEntryLinesTable.accountId, cashIds), isOpeningSourceEntry()];
    if (from) conds.push(gte(journalEntriesTable.date, from));
    if (to) conds.push(lte(journalEntriesTable.date, to));
    return db
      .select({ amount: sql<string>`coalesce(sum(${journalEntryLinesTable.debitAmount} - ${journalEntryLinesTable.creditAmount}), 0)::text` })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds));
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
  /**
   * D14-11 — the PARTY dimension (N3): a GL filtered to one customer or one
   * vendor reads only lines that name that party. The same predicate feeds the
   * opening, so a party-filtered ledger opens on that party's balance.
   */
  /**
   * D14-09 — the opening of a GL / account statement, computed EXACTLY as the
   * trial-balance row it is drilled from (one aggregate, in SQL):
   * - lines dated before `from`;
   * - plus migration opening entries (D14-03 — ERPNext's `is_opening` rule,
   *   which its own general ledger applies too) dated up to `to`, wherever
   *   they fall;
   * - with `notBefore` (the fiscal-year start, for an income or expense
   *   account — Odoo's general ledger opens P&L accounts there), lines before
   *   it are not this account's opening: they are the prior-years row.
   */
  glOpening(opts: { from?: string; to?: string; notBefore?: string; accountId?: number; accountName?: string; party?: GlParty }) {
    const conds: any[] = [inBooks(), opts.from ? sql`(${journalEntriesTable.date} < ${opts.from} or ${openingBalanceLine()})` : openingBalanceLine()];
    if (opts.to) conds.push(lte(journalEntriesTable.date, opts.to));
    if (opts.notBefore) conds.push(gte(journalEntriesTable.date, opts.notBefore));
    if (opts.accountId != null) conds.push(eq(journalEntryLinesTable.accountId, opts.accountId));
    else if (opts.accountName) conds.push(eq(journalEntryLinesTable.accountName, opts.accountName));
    if (opts.party) conds.push(partyCondition(opts.party));
    return db
      .select({ amount: sql<string>`coalesce(sum(${journalEntryLinesTable.debitAmount} - ${journalEntryLinesTable.creditAmount}), 0)::text` })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds));
  },
  /** The movements of the window — migration opening entries are the OPENING (above), never a movement. */
  glRows(date_from?: string, date_to?: string, account_id?: string, account_name?: string, party?: GlParty) {
    const conds = jeConditions(date_from, date_to);
    conds.push(sql`not ${openingBalanceLine()}`);
    if (account_id) conds.push(eq(journalEntryLinesTable.accountId, Number(account_id)));
    if (account_name && !account_id) conds.push(eq(journalEntryLinesTable.accountName, account_name));
    if (party) conds.push(partyCondition(party));
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
        partyType: journalEntryLinesTable.partyType,
        customerId: journalEntryLinesTable.customerId,
        vendorId: journalEntryLinesTable.vendorId,
        debit: journalEntryLinesTable.debitAmount,
        credit: journalEntryLinesTable.creditAmount,
      })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      .where(and(...conds))
      .orderBy(asc(journalEntriesTable.date), asc(journalEntriesTable.id), asc(journalEntryLinesTable.id));
  },

// account-statement: served by the general-ledger reads above (D14-09 — one
  // definition of an account's opening and movements; the statement used to
  // carry its own copy, which knew nothing of opening entries).

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

  // ar-aging — approved invoices only (drafts/submitted are not receivables yet).
  invoicesWithCustomer() {
    return db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(approvedInvoicesOnly());
  },
  /**
   * ap-aging — approved bills only (drafts/submitted are not payable AP yet),
   * each with what it still OWES.
   *
   * B6 (2026-09-22): outstanding is `billPosition`'s definition — `paid_amount`
   * AND live AP-subledger allocations (payments, applied advances, applied
   * credit notes), and 0 for a credit note. A reversed allocation stops being
   * live, so a correction puts the exposure straight back into the ageing.
   * 🔴 Neither fact is folded into the other: `paid_amount` has one writer
   * (`billsService.pay`), allocations have theirs.
   */
  billsWithVendor() {
    return db
      .select({ bill: billsTable, vendor: vendorsTable, outstanding: sql<string>`${billOutstandingSql("bills")}` })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(approvedBillsOnly());
  },

  // tax-journal-entries
  /** The tenant's tax accounts, by system_code — the set a line's account id is tested against. */
  taxAccountIds() {
    return db
      .select({ id: categoriesTable.id })
      .from(categoriesTable)
      .where(inArray(categoriesTable.systemCode, [...TAX_ACCOUNT_SYSTEM_CODES]));
  },
  taxLineEntryIds(date_from?: string, date_to?: string) {
    return db
      .select({ journalEntryId: journalEntryLinesTable.journalEntryId })
      .from(journalEntryLinesTable)
      .innerJoin(journalEntriesTable, eq(journalEntryLinesTable.journalEntryId, journalEntriesTable.id))
      // By system_code, the posting path's own definition — never by name.
      .innerJoin(categoriesTable, eq(journalEntryLinesTable.accountId, categoriesTable.id))
      .where(
        and(
          ...jeConditions(date_from, date_to),
          inArray(categoriesTable.systemCode, [...TAX_ACCOUNT_SYSTEM_CODES]),
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

  // vat-return (sales/output-VAT side) — approved invoices only, and NEVER an
  // opening item (Batch 1C, R7): a migrated receivable is the previous
  // system's document, whose VAT that system reported. It carries no VAT and
  // no line items, so without this predicate the header fallback above would
  // read its outstanding amount as a zero-rated sale of the month it was
  // issued in — a VAT event the migration must never create.
  invoicesInRange(dateFrom: string, dateTo: string) {
    return db
      .select()
      .from(invoicesTable)
      .where(and(gte(invoicesTable.date, dateFrom), lte(invoicesTable.date, dateTo), approvedInvoicesOnly(), eq(invoicesTable.isOpening, false)));
  },
  // vat-return (bill/input-VAT side) — approved bills only, never an opening item (R7).
  billsInRange(dateFrom: string, dateTo: string) {
    return db
      .select()
      .from(billsTable)
      .where(and(gte(billsTable.date, dateFrom), lte(billsTable.date, dateTo), approvedBillsOnly(), eq(billsTable.isOpening, false)));
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
  /**
   * AP-2 — the PREPAYMENT ADJUSTMENT rows (KSA-31…34) of the in-books final
   * invoices dated in the window. The return reads a 388 NET of the advance
   * it adjusts: the 386 declared that base and VAT in ITS period (GCC
   * Agreement Art. 23(1) "to the extent of the received amount"), so the
   * final invoice adds only what was not yet declared — one row per
   * (invoice, advance), category and rate copied from the 386.
   */
  prepaymentsInRange(dateFrom: string, dateTo: string) {
    return db
      .select({ row: invoicePrepaymentsTable, invoiceId: invoicePrepaymentsTable.invoiceId })
      .from(invoicePrepaymentsTable)
      .innerJoin(invoicesTable, eq(invoicePrepaymentsTable.invoiceId, invoicesTable.id))
      .where(and(gte(invoicesTable.date, dateFrom), lte(invoicesTable.date, dateTo), approvedInvoicesOnly(), isNotNull(invoicePrepaymentsTable.allocationId)));
  },
  /**
   * 2026-09-22: bad-debt reliefs CLAIMED HERE (Art. 40(7)) whose claim date is
   * in the range — the return's box 7 (output-VAT adjustments). A migrated
   * relief was claimed in the previous system's return and is not in ours.
   */
  badDebtReliefsInRange(dateFrom: string, dateTo: string) {
    return db
      .select({ id: invoicesTable.id, invoiceNumber: invoicesTable.invoiceNumber, claimedOn: invoicesTable.badDebtReliefClaimedOn, reliefVat: invoicesTable.badDebtReliefVatAmount, writtenOff: invoicesTable.writtenOffAmount })
      .from(invoicesTable)
      // F-05 (Phase 14): the in-books + company predicate every sibling query
      // carries (`approvedInvoicesOnly` — N1, Policy C). RLS already held the
      // company; the query layer refuses too, so a misconfigured caller gets
      // an empty answer, never another company's relief.
      .where(and(approvedInvoicesOnly(), eq(invoicesTable.badDebtReliefSource, "recorded"), gte(invoicesTable.badDebtReliefClaimedOn, dateFrom), lte(invoicesTable.badDebtReliefClaimedOn, dateTo)));
  },
  /**
   * Z-AP1 — the PREPAYMENT ADJUSTMENT rows of the in-books FINAL bills dated in
   * the window: what each final bill must NOT claim again, because the
   * supplier's advance tax invoice claimed it in ITS period. Finalised rows
   * only (allocation_id set at the bill's approval) — the same rows its GL
   * entry netted.
   */
  billPrepaymentsInRange(dateFrom: string, dateTo: string) {
    return db
      .select({ row: billPrepaymentsTable, billId: billPrepaymentsTable.billId })
      .from(billPrepaymentsTable)
      .innerJoin(billsTable, eq(billPrepaymentsTable.billId, billsTable.id))
      .where(and(gte(billsTable.date, dateFrom), lte(billsTable.date, dateTo), approvedBillsOnly(), isNotNull(billPrepaymentsTable.allocationId)));
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

  /**
   * 🔴 PHASE 13A — THE INPUT-VAT CLAIM SET (the narrow return guard,
   * accountant X1/X2/X3/X5, 2026-09-27). The three queries above select the
   * purchases of a period by the DOCUMENT's date; these select the same rows —
   * same filters — by the date their input VAT is CLAIMED, and only the
   * documents whose VAT reached VAT_INPUT:
   *   · `claimed`: in the period of `input_vat_claimed_on` — the document's own
   *     date when it was evidenced at posting, the evidence date when the
   *     evidence entry moved held VAT (X2: a later return, never a
   *     prior-period correction); a credit note on held VAT follows its
   *     original into that period (X3), so the claim is the NET;
   *   · `awaiting_evidence`: on NO return — the VAT is in the holding asset;
   *   · `not_deductible`: on NO return as input VAT — it is cost (X5, and the
   *     0 %-recovery fixed asset, closing P13-D2's remaining half);
   *   · NULL (posted outside the approval — opening items, older rows): the
   *     pre-Phase-13 reading, claimed on its own date.
   * Only the input-VAT figure reads this set; nothing about boxes or layout
   * changes (P13-N1 stays open).
   */
  billsClaimedInRange(dateFrom: string, dateTo: string) {
    return db
      .select()
      .from(billsTable)
      .where(and(claimedInputVatIn(dateFrom, dateTo), approvedBillsOnly(), eq(billsTable.isOpening, false)));
  },
  billLinesClaimedInRange(dateFrom: string, dateTo: string) {
    return db
      .select({ line: billItemsTable, billId: billItemsTable.billId })
      .from(billItemsTable)
      .innerJoin(billsTable, eq(billItemsTable.billId, billsTable.id))
      .where(and(claimedInputVatIn(dateFrom, dateTo), approvedBillsOnly()));
  },
  billPrepaymentsClaimedInRange(dateFrom: string, dateTo: string) {
    return db
      .select({ row: billPrepaymentsTable, billId: billPrepaymentsTable.billId })
      .from(billPrepaymentsTable)
      .innerJoin(billsTable, eq(billPrepaymentsTable.billId, billsTable.id))
      .where(and(claimedInputVatIn(dateFrom, dateTo), approvedBillsOnly(), isNotNull(billPrepaymentsTable.allocationId)));
  },
};
