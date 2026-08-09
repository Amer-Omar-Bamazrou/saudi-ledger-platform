-- M12.1b · Credit and debit notes as first-class documents.
--
-- Notes are `invoices` rows carrying `document_type` = credit_note | debit_note
-- (the column landed in M12.1a). Reusing the row is deliberate: ZATCA requires
-- notes in the SAME per-EGS hash chain and ICV sequence as invoices, so a
-- separate table would be actively wrong.
--
-- 🔴 AMOUNTS ARE STORED POSITIVE on notes; the direction is carried by
-- `document_type`, and reports apply the sign explicitly. Storing negatives
-- looks tempting (balance-sheet AR and the customer ledger would net for free)
-- but SILENTLY breaks the other two:
--   * AR aging skips them  — `if (outstanding < 0.01) continue`
--   * the VAT return misroutes them — a negative vat_amount computes rate 0, so
--     the note lands in the ZERO-RATED box and never reduces output VAT, which
--     is a silent filing error against ZATCA.
-- Two of four netting correctly is exactly what makes negatives dangerous.
ALTER TABLE "invoices" ADD COLUMN "original_invoice_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "note_reason" text;--> statement-breakpoint
CREATE INDEX "invoices_original_idx" ON "invoices" USING btree ("original_invoice_id");--> statement-breakpoint

-- A REAL foreign key, not the invoice-number string: the ZATCA
-- `cac:BillingReference` is derived from this row at assembly time, so it can
-- never drift from the document it names. RESTRICT because deleting an invoice
-- that a note corrects would orphan a legal document.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_original_invoice_id_fk"
  FOREIGN KEY ("original_invoice_id") REFERENCES "public"."invoices"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;--> statement-breakpoint

-- The pairing cannot be wrong by construction: an ordinary invoice has no
-- original and no reason; a note must have BOTH.
--
-- `note_reason` is in the constraint because **BR-KSA-17** requires the reason
-- (KSA-10) on every credit and debit note — without it ZATCA rejects the
-- document, so it belongs at entry rather than at submission.
--
-- Existing rows are all document_type='invoice' with both columns NULL, so this
-- validates against the current table without a backfill.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_note_reference_chk" CHECK (
    (
      "document_type" = 'invoice'
      AND "original_invoice_id" IS NULL
      AND "note_reason" IS NULL
    )
    OR (
      "document_type" IN ('credit_note', 'debit_note')
      AND "original_invoice_id" IS NOT NULL
      AND "note_reason" IS NOT NULL
    )
  );--> statement-breakpoint

-- A note may not reference itself.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_note_not_self_chk"
  CHECK ("original_invoice_id" IS NULL OR "original_invoice_id" <> "id");
