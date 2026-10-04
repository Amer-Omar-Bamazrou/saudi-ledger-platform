/**
 * The pending-approvals queue (contract batch 5, owner decision A).
 *
 * 🔴 UNBOUNDED, DELIBERATELY. The page this replaces fetched the default page
 * (50) of each list and filtered client-side, so pending drafts older than the
 * newest 50 documents were invisible — "nothing pending" while money waited.
 * The pending set is bounded by what approvers have not acted on, not by data
 * volume; a LIMIT returning here would be the same defect wearing the fix.
 */
import {
  db, billsTable, categoriesTable, invoicesTable, journalEntriesTable, payrollRunsTable,
  taxComputationsTable, taxComputationVersionsTable, vendorWhtTreatyReliefsTable, scheduledPaymentsTable, vendorsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

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
      // The label names the expense account the bill will post to on approval
      // (its own choice, or the seeded default), so the approver sees what they
      // are releasing — the queue is where the two-person flow ends.
      .select({
        id: billsTable.id,
        label: sql<string>`${billsTable.billNumber} || ' → ' || coalesce(${categoriesTable.name}, 'Purchases')`,
        status: billsTable.status,
        amount: billsTable.total,
      })
      .from(billsTable)
      .leftJoin(categoriesTable, eq(categoriesTable.id, billsTable.expenseAccountId))
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

  /**
   * Phase 16 (QA-15): a computation version a preparer SUBMITTED. A draft is the
   * preparer's working paper — a live projection until its year ends — not a
   * request for approval, so only `submitted` is listed (the act of submitting is
   * what asks an approver). Company by the computation's own column.
   */
  pendingTaxComputationVersions() {
    return db
      .select({
        id: taxComputationVersionsTable.id, computationId: taxComputationVersionsTable.computationId,
        versionNo: taxComputationVersionsTable.versionNo, status: taxComputationVersionsTable.status,
        kind: taxComputationsTable.kind, fiscalLabel: taxComputationsTable.fiscalLabel,
      })
      .from(taxComputationVersionsTable)
      .innerJoin(taxComputationsTable, eq(taxComputationsTable.id, taxComputationVersionsTable.computationId))
      .where(and(eq(taxComputationVersionsTable.status, "submitted"), sql`${taxComputationsTable.companyId} = ${currentCompany}`))
      .orderBy(desc(taxComputationVersionsTable.submittedAt), desc(taxComputationVersionsTable.id));
  },

  /** Phase 16 (QA-15): a treaty relief recorded and not yet approved — it relieves nothing until it is. */
  pendingWhtReliefs() {
    return db
      .select({
        id: vendorWhtTreatyReliefsTable.id, status: vendorWhtTreatyReliefsTable.status,
        paymentType: vendorWhtTreatyReliefsTable.paymentType, reducedRate: vendorWhtTreatyReliefsTable.reducedRate,
        treatyCountry: vendorWhtTreatyReliefsTable.treatyCountry, vendorName: vendorsTable.name, vendorNameAr: vendorsTable.nameAr,
      })
      .from(vendorWhtTreatyReliefsTable)
      .leftJoin(vendorsTable, eq(vendorsTable.id, vendorWhtTreatyReliefsTable.vendorId))
      .where(and(eq(vendorWhtTreatyReliefsTable.status, "pending"), sql`${vendorWhtTreatyReliefsTable.companyId} = ${currentCompany}`))
      .orderBy(desc(vendorWhtTreatyReliefsTable.createdAt), desc(vendorWhtTreatyReliefsTable.id));
  },

  /**
   * Phase 17 (QA-15): a payment plan not yet approved. An APPROVED plan waits for
   * payment, not for approval, and is not listed. The amount is the plan's own —
   * what it would settle — never a bill figure.
   */
  pendingPaymentPlans() {
    return db
      .select({
        id: scheduledPaymentsTable.id, status: scheduledPaymentsTable.status, amount: scheduledPaymentsTable.amount,
        plannedDate: scheduledPaymentsTable.plannedDate, billId: scheduledPaymentsTable.billId, billNumber: billsTable.billNumber,
        vendorName: vendorsTable.name, vendorNameAr: vendorsTable.nameAr,
      })
      .from(scheduledPaymentsTable)
      .innerJoin(billsTable, eq(billsTable.id, scheduledPaymentsTable.billId))
      .leftJoin(vendorsTable, eq(vendorsTable.id, billsTable.vendorId))
      .where(and(eq(scheduledPaymentsTable.status, "planned"), sql`${scheduledPaymentsTable.companyId} = ${currentCompany}`))
      .orderBy(desc(scheduledPaymentsTable.plannedDate), desc(scheduledPaymentsTable.id));
  },
};
