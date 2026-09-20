/**
 * Batch 1C — Issue 1: the query-side forms of `@workspace/shared`
 * `isReceivableInBooks` (the ONE definition; read its header). Consumed by
 * the review queue's settlement candidates (`invoices.repository.ts`
 * `openForSettlement`) and by `scripts/ledgerInvariants.ts`.
 */
import { invoicesTable } from "@workspace/db";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { INVOICE_IN_BOOKS_STATUSES } from "@workspace/shared";
import { invoiceNotReversed } from "./openingReversal";

/** Drizzle form — an invoice row that is a receivable in the books (outstanding NOT included; the caller adds its own tolerance). */
export const receivableInBooks = (): SQL =>
  and(
    eq(invoicesTable.documentType, "invoice"),
    inArray(invoicesTable.status, [...INVOICE_IN_BOOKS_STATUSES]),
    invoiceNotReversed(),
  ) as SQL;

/**
 * Plain-string form for the ledger invariants: the rows the INVOICE
 * invariants (outstanding never negative; the paid cache equals the
 * allocations) must hold on — every invoice this system ISSUED (it carries
 * a hash) OR migrated as an OPENING item (it never will). Reversed opening
 * rows stay IN this set on purpose: they are frozen, and a frozen row that
 * fails an invariant is a defect the sweep must still report.
 */
export const INVOICE_ISSUED_OR_OPENING_TEXT = (alias: string) =>
  `${alias}.document_type = 'invoice' AND (${alias}.invoice_hash IS NOT NULL OR ${alias}.is_opening)`;
