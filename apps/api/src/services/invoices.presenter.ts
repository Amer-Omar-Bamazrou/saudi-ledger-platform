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

export type PrepaymentOut = {
  id: number;
  advanceInvoiceId: number;
  advanceInvoiceNumber: string;
  advanceInvoiceDate: string;
  amount: number;
  taxableAmount: number;
  taxAmount: number;
  taxCategoryCode: string;
  vatRate: number;
  allocationId: number | null;
};

export function buildInvoiceOut(inv: Invoice, customer?: Customer | null, items?: InvoiceItem[], prepayments?: PrepaymentOut[]) {
  // AP-2: BT-113 — the VAT-inclusive advance this invoice adjusts (Σ its
  // prepayment rows; 0.00 unless it names an advance tax invoice), and the
  // amount due after it. Never `paid_amount` — that is cash, a different
  // fact (Guideline §8(c): populated only when a separate advance invoice
  // was issued).
  const prepaidAmount = Math.round((prepayments ?? []).reduce((s, p) => s + p.amount, 0) * 100) / 100;
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
    // D-4: the part settled by credit notes (cache of credit allocations); outstanding = total − paid − credited.
    creditedAmount: toNum(inv.creditedAmount),
    paidAt: inv.paidAt,
    reviewNote: inv.reviewNote,
    notes: inv.notes,
    // Batch 1C / Policy C: an opening item, and whether the migration reversed it (frozen, excluded from figures) or it replaces a reversed one.
    isOpening: inv.isOpening,
    reversedAt: inv.reversedAt ? inv.reversedAt.toISOString() : null,
    reversedByMigrationBatchId: inv.reversedByMigrationBatchId ?? null,
    replacesInvoiceId: inv.replacesInvoiceId ?? null,
    // ZATCA e-invoicing fields — null on a draft/submitted invoice; populated
    // only at approval (the hash chain is built then, so drafts consume no
    // sequence number).
    invoiceHash: inv.invoiceHash,
    previousHash: inv.previousHash,
    qrCode: inv.qrCode,
    // ZATCA sequence position, assigned at approval (M12.1b).
    icv: inv.icv,
    zatcaUuid: inv.zatcaUuid,
    // Credit/debit notes (M12.1b). `documentType` is what carries the DIRECTION —
    // amounts are stored positive on every document type, so a consumer must
    // read this rather than infer from the sign.
    documentType: inv.documentType,
    originalInvoiceId: inv.originalInvoiceId,
    noteReason: inv.noteReason,
    // AP-2: the receipt an ADVANCE TAX INVOICE declares VAT for (null otherwise).
    advancePaymentId: inv.advancePaymentId ?? null,
    // 2026-09-22: an opening item's previous-system e-invoicing identity, and the item-level correction entry (A4 + answer 5).
    openingEinvoicingStatus: inv.openingEinvoicingStatus ?? null,
    openingSourceUuid: inv.openingSourceUuid ?? null,
    openingCorrectionJournalEntryId: inv.openingCorrectionJournalEntryId ?? null,
    // 2026-09-22: the bad-debt facts (Art. 40(7)) and the Art. 40(9) links.
    writtenOffAmount: toNum(inv.writtenOffAmount),
    badDebtRelief: inv.badDebtReliefSource
      ? {
          claimedOn: inv.badDebtReliefClaimedOn ?? null,
          vatAmount: toNum(inv.badDebtReliefVatAmount),
          returnPeriod: inv.badDebtReliefReturnPeriod ?? null,
          certificateRef: inv.badDebtReliefCertificateRef ?? null,
          legalRef: inv.badDebtReliefLegalRef ?? null,
          source: (inv.badDebtReliefSource ?? "recorded") as "recorded" | "migrated",
          journalEntryId: inv.badDebtReliefJournalEntryId ?? null,
        }
      : null,
    recoversInvoiceId: inv.recoversInvoiceId ?? null,
    recoveryPaymentId: inv.recoveryPaymentId ?? null,
    prepayments: prepayments ?? [],
    prepaidAmount,
    amountDue: Math.round((toNum(inv.total) - prepaidAmount) * 100) / 100,
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
