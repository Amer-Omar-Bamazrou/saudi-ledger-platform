/**
 * AP-2 (2026-09-21) — THE DOCUMENT TYPES an `invoices` row can be, and which
 * of them carry a RECEIVABLE. One definition, shared by the API's readers
 * and the web (the §3 two-definitions rule).
 *
 *   invoice          388 — a tax invoice; a receivable (AR) at issue
 *   debit_note       383 — an additional charge; a receivable at issue
 *   credit_note      381 — a reversal; never a receivable (applied, refunded)
 *   advance_invoice  386 — the ADVANCE TAX INVOICE for consideration already
 *                    RECEIVED before a taxable supply (GCC VAT Agreement
 *                    Art. 23(1); IR Art. 53(1)(a)(2); ZATCA XML
 *                    Implementation Standard v1.2 ¶9.5). It declares VAT on
 *                    cash the customer has ALREADY paid, so it is NEVER a
 *                    receivable: it moves no AR, no revenue, no ageing,
 *                    no "outstanding"; its only ledger effect is the VAT
 *                    split of the deposit (decision pack §6 E2, accountant A2).
 *
 * 🔴 A reader that computes "what the customer owes" from `invoices` rows
 * must exclude every type in NON_RECEIVABLE_DOCUMENT_TYPES — the old shape
 * `document_type = 'credit_note' ? 0 : outstanding` silently admits the
 * advance invoice through its ELSE branch, which is the trap this constant
 * exists to close (`ap2-advance-tax-invoice.test.ts` asserts each reader).
 */
export const DOCUMENT_TYPES = ["invoice", "credit_note", "debit_note", "advance_invoice"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const ADVANCE_INVOICE_TYPE = "advance_invoice" as const;

/** Types whose `total` is NOT a receivable — excluded from every AR / outstanding / ageing / billed reader. */
export const NON_RECEIVABLE_DOCUMENT_TYPES = ["credit_note", "advance_invoice"] as const;

export function isAdvanceInvoiceType(documentType: string | null | undefined): boolean {
  return documentType === ADVANCE_INVOICE_TYPE;
}

/** Does a document of this type carry a receivable at issue (an invoice or a debit note)? */
export function isReceivableDocumentType(documentType: string | null | undefined): boolean {
  return documentType === "invoice" || documentType === "debit_note";
}
