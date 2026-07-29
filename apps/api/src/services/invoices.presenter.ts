/**
 * Invoice presenter — the single place an invoice (+ customer + items) is shaped
 * into the API/audit response object, including the ZATCA fields (null until the
 * invoice is approved). Extracted from the service so both the service and the
 * approval adapter share one shape without a circular import.
 */
import type { invoicesTable, invoiceItemsTable, customersTable } from "@workspace/db";

type Invoice = typeof invoicesTable.$inferSelect;
type InvoiceItem = typeof invoiceItemsTable.$inferSelect;
type Customer = typeof customersTable.$inferSelect;

export const toNum = (v: unknown) => (v != null ? Number(v) : 0);

export function buildInvoiceOut(inv: Invoice, customer?: Customer | null, items?: InvoiceItem[]) {
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    date: inv.date,
    dueDate: inv.dueDate,
    customerId: inv.customerId,
    customerName: customer?.name ?? null,
    status: inv.status,
    subtotal: toNum(inv.subtotal),
    vatAmount: toNum(inv.vatAmount),
    discount: toNum(inv.discount),
    total: toNum(inv.total),
    currency: inv.currency,
    paidAmount: toNum(inv.paidAmount),
    paidAt: inv.paidAt,
    reviewNote: inv.reviewNote,
    notes: inv.notes,
    // ZATCA e-invoicing fields — null on a draft/submitted invoice; populated
    // only at approval (the hash chain is built then, so drafts consume no
    // sequence number).
    invoiceHash: inv.invoiceHash,
    previousHash: inv.previousHash,
    qrCode: inv.qrCode,
    items:
      items?.map((it) => ({
        id: it.id,
        invoiceId: it.invoiceId,
        productId: it.productId,
        description: it.description,
        descriptionAr: it.descriptionAr,
        quantity: toNum(it.quantity),
        unitPrice: toNum(it.unitPrice),
        vatRate: toNum(it.vatRate),
        vatAmount: toNum(it.vatAmount),
        discount: toNum(it.discount),
        total: toNum(it.total),
      })) ?? [],
    createdAt: inv.createdAt.toISOString(),
  };
}

export type InvoiceOut = ReturnType<typeof buildInvoiceOut>;
