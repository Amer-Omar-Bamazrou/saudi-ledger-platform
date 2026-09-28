/**
 * 🔴 PHASE 13C (2026-09-24) — EXPENSES: purchases paid when they are
 * recorded, as opposed to a BILL, which leaves a supplier payable
 * outstanding.
 *
 * There is no expense table, no expense posting and no expense payment. An
 * expense is a bill recorded with `recorded_as_expense` and the bank and date
 * it was paid; its approval posts it through the bill posting path and pays
 * it through THE bill-payment path in the same transaction
 * (`bills.approvable` → `payBill`). So the GL, `billPosition`, the payment
 * row, its entry and the bank reconciliation are the bills' own — this module
 * only READS them into the Expenses view, and a second source of truth cannot
 * exist.
 *
 * Employee reimbursement is NOT here: there is no employee party, payable or
 * payment model yet, so an expense is always paid by the company, from a
 * named bank.
 */
import { billsRepository } from "../repositories/bills.repository";
import { capturedDocumentsRepository } from "../repositories/capturedDocuments.repository";
import { buildBillOut } from "./bills.presenter";

export interface ExpenseListFilter {
  /** `unposted` (draft/submitted) · `posted` · undefined = all. */
  status?: string;
  q?: string;
  limit: number;
  offset: number;
}

export const expensesService = {
  async list(filter: ExpenseListFilter) {
    const [rows, meta] = await Promise.all([billsRepository.expenses(filter), billsRepository.expensesMeta(filter)]);
    const ids = rows.map((r) => r.bill.id);
    const [payments, captures] = await Promise.all([
      billsRepository.paymentsForBills(ids),
      capturedDocumentsRepository.activeForBills(ids),
    ]);
    return {
      items: rows.map((r) => {
        const out = buildBillOut(r.bill, r.vendor, undefined, r.outstanding, null);
        const posted = r.bill.status !== "draft" && r.bill.status !== "submitted";
        const own = payments.filter((p) => p.billId === r.bill.id);
        const doc = captures.find((c) => c.billId === r.bill.id) ?? null;
        return {
          ...out,
          expenseAccountName: r.expenseAccountName ?? null,
          paidFromBankName: r.bankName ?? null,
          // What the view says about payment is read from the rows, never assumed from the flag.
          paymentStatus: !posted ? "not_posted" : (out.outstanding ?? 0) < 0.01 ? "paid" : own.length > 0 ? "part_paid" : "unpaid",
          payments: own.map((p) => ({
            id: p.id, amount: Number(p.amount), paidAt: p.paidAt, bankAccountId: p.bankAccountId ?? null,
            journalEntryId: p.journalEntryId ?? null, backfilled: p.backfilled,
          })),
          evidenceDocument: doc ? { captureId: doc.id, contentType: doc.contentType, source: doc.source, signatureStatus: doc.signatureStatus ?? null } : null,
        };
      }),
      page: { limit: filter.limit, offset: filter.offset, total: meta.total },
      totals: { postedAmount: meta.postedAmount, postedVat: meta.postedVat, unposted: meta.unposted },
    };
  },
};
