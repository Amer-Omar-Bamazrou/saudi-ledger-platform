/**
 * One queue the server can actually describe (contract batch 5, owner
 * decision A): `{ entity, id, label, status, amount }` rows built from every
 * approvable entity — not several types wearing one name on the client.
 *
 * Phase 16/17 (QA-15, 2026-10-04): a submitted tax computation version, a
 * pending treaty relief and a planned payment joined it. Before, a bookkeeper
 * "submitted" and no approver was ever told — the act existed and its audience
 * did not. Each row's actions still post to that entity's OWN route, behind its
 * own permission; the queue moves nothing itself.
 *
 * 🔴 A journal entry's amount comes from the SAME aggregate the ledger list
 * uses (`journalEntriesRepository.lineTotals`) — never a second computation.
 * That aggregate is the fix for the confident zero batch 4 found; computing
 * the queue's number any other way would let the two drift apart again.
 *
 * 🔴 Phase 18 H-11 — DR-18 (register §11.59; DECIDED 2026-10-27, owner
 * accepted the stated recommendation): an entity's rows are listed only to a
 * role holding APPROVE on its resource — the queue is an approver's worklist,
 * not a reader's (a reader still reads each record on its own page). Each row
 * says whether the caller created it (`own`; a computation version, created or
 * submitted it). Nothing is refused because of `own`: an approver approving
 * their own item is FLAGGED (DR-14, R-11a's control flags), never refused.
 * Shipped by R-12 step 3 (register §11.118), after step 2 gave every document
 * its own Submit — the queue is no longer the preparer's only way to submit.
 */
import { can } from "../lib/rbac";
import { approvalsQueueRepository } from "../repositories/approvalsQueue.repository";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";

export type ApprovalEntity = "invoices" | "bills" | "journal-entries" | "payroll" | "tax-computations" | "wht-reliefs" | "payment-plans"
  | "quotations" | "purchase-orders" | "budgets";

export interface ApprovalPendingRow {
  entity: ApprovalEntity;
  id: number;
  label: string;
  /** The label with the party's Arabic name, where it has one. */
  labelAr?: string | null;
  status: string;
  /**
   * The record's own amount — or null where it has none: a treaty relief is a
   * rate, and a computation's figure is the working paper's live reading, shown
   * on its own page rather than copied into a list where it would go stale.
   */
  amount: number | null;
  /** A computation version's computation (its routes are nested under it). */
  parentId?: number | null;
  /** zakat | income_tax for a computation; the WHT nature for a relief — the page names it in the reader's language. */
  subtype?: string | null;
  /** DR-18: the caller created this item (a computation version: created or submitted it). A flag, never a refusal. */
  own: boolean;
}

const toNum = (v: unknown) => (v != null ? Number(v) : 0);
/** A stored fraction as a percentage, for a label (display only — never computed with). */
const pct = (v: unknown) => `${Number((Number(v) * 100).toFixed(2))}%`;

export const approvalsQueueService = {
  async pending(role: string, userId: number | null = null): Promise<ApprovalPendingRow[]> {
    const [showInvoices, showBills, showJEs, showPayroll, showTax, showTreasury, showQuotations, showOrders, showBudgets] = await Promise.all([
      can(role, "invoices", "approve"),
      can(role, "bills", "approve"),
      can(role, "journal_entries", "approve"),
      can(role, "payroll", "approve"),
      can(role, "tax", "approve"),
      can(role, "treasury", "approve"),
      // 🔴 Phase 18 audit A17: the three documents with a submitted state the queue had never listed.
      can(role, "quotations", "approve"),
      can(role, "purchase_orders", "approve"),
      can(role, "budgets", "approve"),
    ]);
    const mine = (by: number | null | undefined) => userId != null && by === userId;

    const rows: ApprovalPendingRow[] = [];
    if (showInvoices) {
      for (const r of await approvalsQueueRepository.pendingInvoices()) {
        rows.push({ entity: "invoices", id: r.id, label: r.label, status: r.status, amount: toNum(r.amount), own: mine(r.createdBy) });
      }
    }
    if (showBills) {
      for (const r of await approvalsQueueRepository.pendingBills()) {
        rows.push({ entity: "bills", id: r.id, label: r.label, status: r.status, amount: toNum(r.amount), own: mine(r.createdBy) });
      }
    }
    if (showJEs) {
      const jes = await approvalsQueueRepository.pendingJournalEntries();
      const totals = await journalEntriesRepository.lineTotals(jes.map((j) => j.id));
      for (const r of jes) {
        rows.push({ entity: "journal-entries", id: r.id, label: r.label, status: r.status, amount: totals.get(r.id)?.totalDebit ?? 0, own: mine(r.createdBy) });
      }
    }
    if (showQuotations) {
      for (const r of await approvalsQueueRepository.pendingQuotations()) {
        rows.push({ entity: "quotations", id: r.id, label: `${r.number} · ${r.partyName ?? "—"}`, labelAr: r.partyNameAr ? `${r.number} · ${r.partyNameAr}` : null, status: r.status, amount: toNum(r.amount), own: mine(r.createdBy) });
      }
    }
    if (showOrders) {
      for (const r of await approvalsQueueRepository.pendingPurchaseOrders()) {
        rows.push({ entity: "purchase-orders", id: r.id, label: `${r.number} · ${r.partyName ?? "—"}`, labelAr: r.partyNameAr ? `${r.number} · ${r.partyNameAr}` : null, status: r.status, amount: toNum(r.amount), own: mine(r.createdBy) });
      }
    }
    if (showBudgets) {
      for (const r of await approvalsQueueRepository.pendingBudgetVersions()) {
        // a budget has no single amount: its figure is the version's lines, read on its own page
        rows.push({ entity: "budgets", id: r.id, parentId: r.budgetId, label: `${r.name} · ${r.fiscalLabel} · v${r.versionNo}`, labelAr: r.nameAr ? `${r.nameAr} · ${r.fiscalLabel} · v${r.versionNo}` : null, status: r.status, amount: null, own: mine(r.submittedBy) || mine(r.createdBy) });
      }
    }
    if (showPayroll) {
      for (const r of await approvalsQueueRepository.pendingPayrollRuns()) {
        rows.push({ entity: "payroll", id: r.id, label: r.label, status: r.status, amount: toNum(r.amount), own: mine(r.createdBy) });
      }
    }
    if (showTax) {
      for (const r of await approvalsQueueRepository.pendingTaxComputationVersions()) {
        rows.push({ entity: "tax-computations", id: r.id, parentId: r.computationId, subtype: r.kind, label: `${r.fiscalLabel} · v${r.versionNo}`, status: r.status, amount: null, own: mine(r.createdBy) || mine(r.submittedBy) });
      }
      for (const r of await approvalsQueueRepository.pendingWhtReliefs()) {
        const tail = ` · ${r.treatyCountry} · ${pct(r.reducedRate)}`;
        rows.push({ entity: "wht-reliefs", id: r.id, subtype: r.paymentType, label: `${r.vendorName ?? "—"}${tail}`, labelAr: r.vendorNameAr ? `${r.vendorNameAr}${tail}` : null, status: r.status, amount: null, own: mine(r.createdBy) });
      }
    }
    if (showTreasury) {
      for (const r of await approvalsQueueRepository.pendingPaymentPlans()) {
        const head = `${r.billNumber ?? `#${r.billId}`} · ${r.plannedDate}`;
        rows.push({ entity: "payment-plans", id: r.id, label: `${head}${r.vendorName ? ` · ${r.vendorName}` : ""}`, labelAr: r.vendorNameAr ? `${head} · ${r.vendorNameAr}` : null, status: r.status, amount: toNum(r.amount), own: mine(r.createdBy) });
      }
    }
    return rows;
  },
};
