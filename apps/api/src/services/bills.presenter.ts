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

export function buildBillOut(bill: Bill, vendor?: Vendor | null, items?: BillItem[]) {
  return {
    id: bill.id,
    billNumber: bill.billNumber,
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
    paidAt: bill.paidAt,
    reviewNote: bill.reviewNote,
    notes: bill.notes,
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
