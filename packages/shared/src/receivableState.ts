/**
 * Batch 1C — Issue 1 (decision pack §16.13; 2026-09-20): WHAT IS A RECEIVABLE
 * THAT CAN BE SETTLED.
 *
 * Until Issue 1, three places (the D-4 allocation validator, the review
 * queue's settlement candidates, the web allocation-target filter) each
 * defined "issued" as "has an invoice hash". That was a PROXY: it was true
 * of every invoice until the migration created an opening receivable — in
 * the books, on the customer's statement, ageing — that by design never has
 * a hash, an ICV or a QR (R7: a migrated balance is not a tax invoice and
 * mints no ZATCA artefact, ever). The proxy then read "not issued" and no
 * receipt could be allocated to it through any path.
 *
 * The question the predicate answers is an ACCOUNTING one — "is this row a
 * live receivable in the books?" — and its answer is a business state, not
 * a tax artefact:
 *
 *   document_type = 'invoice'          (a note is applied, never paid)
 *   AND status IN ('sent', 'paid')     (in the books: issued by this system
 *                                       at approval, or migrated as an
 *                                       opening item, which is created `sent`)
 *   AND reversed_at IS NULL            (Policy C: a reversed opening item is
 *                                       history — repositories/openingReversal)
 *
 * The outstanding balance is a separate condition each caller applies with
 * its own tolerance. ZATCA artefacts appear nowhere in the predicate, and
 * nothing that consumes it may mint one: collecting a receivable is a cash
 * event against AR, whichever way the receivable came to be in the books.
 *
 * 🔴 ONE DEFINITION, shared by the API (`repositories/receivableInBooks.ts`,
 * `services/creditNotes.ts`) and the web (`lib/openInvoice.ts`) — the
 * §3 two-definitions rule; a status added to one side and not the other is
 * the drift this file exists to make inexpressible.
 */
export const INVOICE_IN_BOOKS_STATUSES = ["sent", "paid"] as const;

export type ReceivableStateRow = {
  documentType: string;
  status: string;
  reversedAt?: Date | string | null;
};

/** Is this invoice row a receivable in the books — one a receipt may settle, subject to its outstanding balance? */
export function isReceivableInBooks(row: ReceivableStateRow): boolean {
  return (
    row.documentType === "invoice" &&
    (INVOICE_IN_BOOKS_STATUSES as readonly string[]).includes(row.status) &&
    row.reversedAt == null
  );
}
