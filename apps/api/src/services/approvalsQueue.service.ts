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
 * Entities the caller's role cannot READ are omitted entirely — the queue
 * widens no read surface beyond the permission matrix.
 */
import { can } from "../lib/rbac";
import { approvalsQueueRepository } from "../repositories/approvalsQueue.repository";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";

export type ApprovalEntity = "invoices" | "bills" | "journal-entries" | "payroll" | "tax-computations" | "wht-reliefs" | "payment-plans";

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
}

const toNum = (v: unknown) => (v != null ? Number(v) : 0);
/** A stored fraction as a percentage, for a label (display only — never computed with). */
const pct = (v: unknown) => `${Number((Number(v) * 100).toFixed(2))}%`;

export const approvalsQueueService = {
  async pending(role: string): Promise<ApprovalPendingRow[]> {
    const [showInvoices, showBills, showJEs, showPayroll, showTax, showTreasury] = await Promise.all([
      can(role, "invoices", "read"),
      can(role, "bills", "read"),
      can(role, "journal_entries", "read"),
      can(role, "payroll", "read"),
      can(role, "tax", "read"),
      can(role, "treasury", "read"),
    ]);

    const rows: ApprovalPendingRow[] = [];
    if (showInvoices) {
      for (const r of await approvalsQueueRepository.pendingInvoices()) {
        rows.push({ entity: "invoices", id: r.id, label: r.label, status: r.status, amount: toNum(r.amount) });
      }
    }
    if (showBills) {
      for (const r of await approvalsQueueRepository.pendingBills()) {
        rows.push({ entity: "bills", id: r.id, label: r.label, status: r.status, amount: toNum(r.amount) });
      }
    }
    if (showJEs) {
      const jes = await approvalsQueueRepository.pendingJournalEntries();
      const totals = await journalEntriesRepository.lineTotals(jes.map((j) => j.id));
      for (const r of jes) {
        rows.push({ entity: "journal-entries", id: r.id, label: r.label, status: r.status, amount: totals.get(r.id)?.totalDebit ?? 0 });
      }
    }
    if (showPayroll) {
      for (const r of await approvalsQueueRepository.pendingPayrollRuns()) {
        rows.push({ entity: "payroll", id: r.id, label: r.label, status: r.status, amount: toNum(r.amount) });
      }
    }
    if (showTax) {
      for (const r of await approvalsQueueRepository.pendingTaxComputationVersions()) {
        rows.push({ entity: "tax-computations", id: r.id, parentId: r.computationId, subtype: r.kind, label: `${r.fiscalLabel} · v${r.versionNo}`, status: r.status, amount: null });
      }
      for (const r of await approvalsQueueRepository.pendingWhtReliefs()) {
        const tail = ` · ${r.treatyCountry} · ${pct(r.reducedRate)}`;
        rows.push({ entity: "wht-reliefs", id: r.id, subtype: r.paymentType, label: `${r.vendorName ?? "—"}${tail}`, labelAr: r.vendorNameAr ? `${r.vendorNameAr}${tail}` : null, status: r.status, amount: null });
      }
    }
    if (showTreasury) {
      for (const r of await approvalsQueueRepository.pendingPaymentPlans()) {
        const head = `${r.billNumber ?? `#${r.billId}`} · ${r.plannedDate}`;
        rows.push({ entity: "payment-plans", id: r.id, label: `${head}${r.vendorName ? ` · ${r.vendorName}` : ""}`, labelAr: r.vendorNameAr ? `${head} · ${r.vendorNameAr}` : null, status: r.status, amount: toNum(r.amount) });
      }
    }
    return rows;
  },
};
