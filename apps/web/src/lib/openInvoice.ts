/**
 * Batch 1C — Issue 1 (2026-09-20): which invoice a receipt or a credit note
 * can be allocated to. The state test is the ONE definition in
 * `@workspace/shared` (`isReceivableInBooks`: an invoice, in the books,
 * not a reversed opening item); the balance test is the server's own
 * outstanding (D-4: total − paid − credited, never total − paid alone).
 *
 * This used to read `invoiceHash != null`, which refused every OPENING
 * receivable — a migrated balance never carries a hash, an ICV or a QR, and
 * is exactly what the migration exists to let the tenant collect. A pure
 * module (no React, no DOM) so the web unit runner can pin it.
 */
import { isReceivableInBooks } from "@workspace/shared";
import type { Invoice } from "@workspace/api-client-react";

type OutstandingFields = Pick<Invoice, "total" | "paidAmount" | "creditedAmount">;
type StateFields = Pick<Invoice, "documentType" | "status"> & { reversedAt?: string | null };

/** Outstanding as the server defines it — never `total − paid` alone (D-4). */
export const outstandingOf = (inv: OutstandingFields) =>
  Math.round((Number(inv.total ?? 0) - Number(inv.paidAmount ?? 0) - Number(inv.creditedAmount ?? 0)) * 100) / 100;

/** A receivable in the books with a balance still open — the only allocation target. */
export const isOpenInvoice = (inv: OutstandingFields & StateFields) => isReceivableInBooks(inv) && outstandingOf(inv) > 0.005;
