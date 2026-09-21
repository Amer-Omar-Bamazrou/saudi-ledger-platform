-- ═══════════════════════════════════════════════════════════════════════════
-- AP-3 (2026-09-21) — hand-written. THE CREDIT NOTE AGAINST AN ADVANCE TAX
-- INVOICE: `document_type = 'advance_credit_note'`, an `invoices` row whose
-- ORIGINAL (`original_invoice_id`) is a 386 and whose reason (`note_reason`)
-- is BR-KSA-17's KSA-10 — exactly the pairing the 0020 CHECK already
-- enforces for credit and debit notes, now admitting the new type in the
-- SAME arm. No new table, no new column: the 386 → note → refund chain is
-- already representable (invoices.original_invoice_id; customer_refunds.
-- payment_id names the receipt). Decision record:
-- docs/product/advance-payments-decision-pack.md §15.
-- No data is written by this migration.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_note_reference_chk";--> statement-breakpoint
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_note_reference_chk" CHECK (
    (
      "document_type" IN ('invoice', 'advance_invoice')
      AND "original_invoice_id" IS NULL
      AND "note_reason" IS NULL
    )
    OR (
      "document_type" IN ('credit_note', 'debit_note', 'advance_credit_note')
      AND "original_invoice_id" IS NOT NULL
      AND "note_reason" IS NOT NULL
    )
  );
