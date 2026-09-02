/**
 * One queue the server can actually describe (contract batch 5, owner
 * decision A): `{ entity, id, label, status, amount }` rows built from all
 * four draftable entities — not four types wearing one name on the client.
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

export type ApprovalEntity = "invoices" | "bills" | "journal-entries" | "payroll";

export interface ApprovalPendingRow {
  entity: ApprovalEntity;
  id: number;
  label: string;
  status: string;
  amount: number;
}

const toNum = (v: unknown) => (v != null ? Number(v) : 0);

export const approvalsQueueService = {
  async pending(role: string): Promise<ApprovalPendingRow[]> {
    const [showInvoices, showBills, showJEs, showPayroll] = await Promise.all([
      can(role, "invoices", "read"),
      can(role, "bills", "read"),
      can(role, "journal_entries", "read"),
      can(role, "payroll", "read"),
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
    return rows;
  },
};
