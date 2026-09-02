/**
 * The pending-approvals queue (contract batch 5, owner decision A).
 *
 * 🔴 UNBOUNDED, DELIBERATELY. The page this replaces fetched the default page
 * (50) of each list and filtered client-side, so pending drafts older than the
 * newest 50 documents were invisible — "nothing pending" while money waited.
 * The pending set is bounded by what approvers have not acted on, not by data
 * volume; a LIMIT returning here would be the same defect wearing the fix.
 */
import { db, billsTable, invoicesTable, journalEntriesTable, payrollRunsTable } from "@workspace/db";
import { and, desc, inArray, sql } from "drizzle-orm";

const PENDING = ["draft", "submitted"];

/**
 * 🔴 Scoped to the ACTIVE COMPANY, not just the org. RLS scopes by
 * organization only (`app.current_company_id` is in no policy — the open
 * decision in CLAUDE.md §5), so a queue that filtered by org alone would show
 * a two-company org BOTH companies' pending work under whichever company the
 * user is operating as. The lists this queue replaced have that defect; a new
 * surface does not inherit it, and `tests/cross-company-isolation` treats a new
 * company-blind repository as a JOIN to a list that may only shrink.
 */
const currentCompany = sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`;

export const approvalsQueueRepository = {
  pendingInvoices() {
    return db
      .select({ id: invoicesTable.id, label: invoicesTable.invoiceNumber, status: invoicesTable.status, amount: invoicesTable.total })
      .from(invoicesTable)
      .where(and(inArray(invoicesTable.status, PENDING), sql`${invoicesTable.companyId} = ${currentCompany}`))
      .orderBy(desc(invoicesTable.date), desc(invoicesTable.id));
  },

  pendingBills() {
    return db
      .select({ id: billsTable.id, label: billsTable.billNumber, status: billsTable.status, amount: billsTable.total })
      .from(billsTable)
      .where(and(inArray(billsTable.status, PENDING), sql`${billsTable.companyId} = ${currentCompany}`))
      .orderBy(desc(billsTable.date), desc(billsTable.id));
  },

  /** Journal entries have no submit stage — a pending entry is a draft. Amounts come from lineTotals, not from here. */
  pendingJournalEntries() {
    return db
      .select({ id: journalEntriesTable.id, label: journalEntriesTable.entryNumber, status: journalEntriesTable.status })
      .from(journalEntriesTable)
      .where(and(inArray(journalEntriesTable.status, ["draft"]), sql`${journalEntriesTable.companyId} = ${currentCompany}`))
      .orderBy(desc(journalEntriesTable.date), desc(journalEntriesTable.id));
  },

  pendingPayrollRuns() {
    return db
      .select({ id: payrollRunsTable.id, label: payrollRunsTable.period, status: payrollRunsTable.status, amount: payrollRunsTable.totalNetPay })
      .from(payrollRunsTable)
      .where(and(inArray(payrollRunsTable.status, PENDING), sql`${payrollRunsTable.companyId} = ${currentCompany}`))
      .orderBy(desc(payrollRunsTable.period), desc(payrollRunsTable.id));
  },
};
