/**
 * Bill presenter — the single place a bill (+ vendor + items) is shaped into the
 * API/audit response object. Extracted from the service so both the service and
 * the approval adapter share one shape without a circular import.
 */
import type { billsTable, billItemsTable, vendorsTable } from "@workspace/db";

type Bill = typeof billsTable.$inferSelect;
type BillItem = typeof billItemsTable.$inferSelect;
type Vendor = typeof vendorsTable.$inferSelect;

export const toNum = (v: unknown) => (v != null ? Number(v) : 0);

/**
 * `outstanding` is what the document still owes, computed by the repository
 * through `billPosition` (the one definition: a credit note owes nothing, and
 * AP-subledger allocations count as well as `paidAmount`). Reads pass it; a
 * write response that did not read it back sends `null` — never a figure
 * re-derived here from `total − paidAmount`, which is the expression Part 2
 * made wrong.
 */
export type BillPrepaymentOut = { id: number; advanceBillId: number; advanceBillNumber: string; supplierReference: string | null; amount: number; taxableAmount: number; taxAmount: number; vatRate: number; finalised: boolean };

export function buildBillOut(bill: Bill, vendor?: Vendor | null, items?: BillItem[], outstanding?: string | number | null, prepaid?: string | number | null, prepayments?: BillPrepaymentOut[]) {
  const prepaidAmount = Math.round(Number(prepaid ?? 0) * 100) / 100;
  return {
    id: bill.id,
    billNumber: bill.billNumber,
    // B7: what this document IS travels with it. A read path that drops the
    // field every write path sets is how a note comes back looking like a bill.
    documentType: bill.documentType,
    creditNoteAgainstBillId: bill.creditNoteAgainstBillId ?? null,
    // Z-AP1: an advance invoice names the supplier payment it invoices; a final
    // bill carries the advance deductions (KSA-31/32) and what is left to pay.
    advanceSupplierPaymentId: bill.advanceSupplierPaymentId ?? null,
    prepaidAmount: prepaidAmount,
    amountDue: bill.documentType === "bill" || bill.documentType === "debit_note" ? Math.round((toNum(bill.total) - prepaidAmount) * 100) / 100 : 0,
    ...(prepayments ? { prepayments } : {}),
    vendorReference: bill.vendorReference,
    date: bill.date,
    dueDate: bill.dueDate,
    vendorId: bill.vendorId,
    vendorName: vendor?.name ?? null,
    status: bill.status,
    subtotal: toNum(bill.subtotal),
    vatAmount: toNum(bill.vatAmount),
    total: toNum(bill.total),
    currency: bill.currency,
    paidAmount: toNum(bill.paidAmount),
    outstanding: outstanding == null ? null : Math.max(0, Math.round(Number(outstanding) * 100) / 100),
    paidAt: bill.paidAt,
    reviewNote: bill.reviewNote,
    expenseAccountId: bill.expenseAccountId ?? null,
    // FA-B: the draft fixed asset this bill buys (its approval capitalises it).
    capitalisesAssetId: bill.capitalisesAssetId ?? null,
    notes: bill.notes,
    isOpening: bill.isOpening,
    reversedAt: bill.reversedAt ? bill.reversedAt.toISOString() : null,
    reversedByMigrationBatchId: bill.reversedByMigrationBatchId ?? null,
    replacesBillId: bill.replacesBillId ?? null,
    createdAt: bill.createdAt.toISOString(),
    items:
      items?.map((it) => ({
        id: it.id,
        billId: it.billId,
        productId: it.productId,
        description: it.description,
        descriptionAr: it.descriptionAr,
        quantity: toNum(it.quantity),
        unitPrice: toNum(it.unitPrice),
        vatRate: toNum(it.vatRate),
        vatAmount: toNum(it.vatAmount),
        total: toNum(it.total),
      })) ?? [],
  };
}

export type BillOut = ReturnType<typeof buildBillOut>;
