/**
 * 🔴 Phase 18 (the PR C correction route, owner decision 2 of 2026-10-27): an
 * invoice ZATCA rejected stays in the books until its correction is ISSUED —
 * its entry is posted, and the correction's issue mirrors it. From that moment
 * the correction carries the sale and the receivable, so the rejected invoice
 * leaves every document report: the VAT return (the supply counted once, in its
 * tax point's month), AR ageing, the customer ledger and balance-sheet AR.
 *
 * Read from the correction's own row (`corrects_invoice_id`, on the NEW
 * invoice): nothing on the frozen rejected invoice is ever written.
 */
import { invoicesTable } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

export const invoiceNotSuperseded = (): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM invoices superseding WHERE superseding.corrects_invoice_id = ${invoicesTable}."id" AND invoice_is_issued(superseding.status, superseding.is_opening))`;
