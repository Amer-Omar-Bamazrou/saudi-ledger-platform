ALTER TABLE "invoices" ADD COLUMN "written_off_amount" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bad_debt_relief_claimed_on" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bad_debt_relief_vat_amount" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bad_debt_relief_return_period" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bad_debt_relief_certificate_ref" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bad_debt_relief_legal_ref" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bad_debt_relief_source" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bad_debt_relief_journal_entry_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "recovers_invoice_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "recovery_payment_id" integer;--> statement-breakpoint
ALTER TABLE "payment_classifications" ADD COLUMN "effective_date" text;--> statement-breakpoint
ALTER TABLE "payment_classifications" ADD COLUMN "journal_entry_id" integer;--> statement-breakpoint
CREATE INDEX "invoices_recovers_idx" ON "invoices" USING btree ("recovers_invoice_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- Advance-payment accounting correction + bad-debt relief (2026-09-22), on the
-- accountant's answers: (2) unidentified/erroneous receipts, customer advances,
-- refundable security deposits and credit-note balances are FOUR liabilities;
-- (4) an Art. 40(9) recovery is a NEW tax document (`recovery_invoice`, a 388);
-- the Art. 40(7) relief is a structured fact, never a note.
-- Decision record: docs/product/advance-payments-decision-pack.md §17.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Two customer-money liabilities and the bad-debt expense ──────────────
INSERT INTO "system_account_templates" (code, name, name_ar, type, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, sort_order)
VALUES
  ('UNIDENTIFIED_RECEIPTS',  'Unidentified and erroneous receipts', 'مقبوضات غير محددة أو خاطئة', 'liability', true, false, 'O', false, 'current', 73),
  ('SECURITY_DEPOSITS_HELD', 'Refundable security deposits held',   'تأمينات مستردة محتفظ بها',    'liability', true, false, 'O', false, 'current', 75),
  ('BAD_DEBT_EXPENSE',       'Bad debts',                           'ديون معدومة',                 'expense',   true, false, 'O', false, NULL,      93)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- Existing organizations get the accounts too (the org-seed trigger fires only
-- for NEW orgs — the M13 lesson).
INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, is_posting)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class, true
  FROM organizations o
  CROSS JOIN system_account_templates t
 WHERE t.code IN ('UNIDENTIFIED_RECEIPTS', 'SECURITY_DEPOSITS_HELD', 'BAD_DEBT_EXPENSE')
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

-- ── 2. The Art. 40(9) document type, constrained ─────────────────────────────
-- A recovery invoice is an invoice-shaped row (no original, no reason) that
-- names BOTH the receivable it recovers and the receipt it declares; no other
-- type may carry either.
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_note_reference_chk";--> statement-breakpoint
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_note_reference_chk" CHECK (
    (
      "document_type" IN ('invoice', 'advance_invoice', 'recovery_invoice')
      AND "original_invoice_id" IS NULL
      AND "note_reason" IS NULL
    )
    OR (
      "document_type" IN ('credit_note', 'debit_note', 'advance_credit_note')
      AND "original_invoice_id" IS NOT NULL
      AND "note_reason" IS NOT NULL
    )
  );--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recovery_shape_chk" CHECK (
  ("document_type" = 'recovery_invoice') = ("recovers_invoice_id" IS NOT NULL AND "recovery_payment_id" IS NOT NULL)
  AND ("document_type" = 'recovery_invoice' OR ("recovers_invoice_id" IS NULL AND "recovery_payment_id" IS NULL))
);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recovers_invoice_id_fk" FOREIGN KEY ("recovers_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recovery_payment_id_fk" FOREIGN KEY ("recovery_payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT;--> statement-breakpoint
-- the relief is either absent or complete: a date, a VAT amount, a source
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_bad_debt_relief_chk" CHECK (
  ("bad_debt_relief_claimed_on" IS NULL AND "bad_debt_relief_vat_amount" IS NULL AND "bad_debt_relief_source" IS NULL)
  OR ("bad_debt_relief_claimed_on" IS NOT NULL AND "bad_debt_relief_vat_amount" IS NOT NULL AND "bad_debt_relief_vat_amount" >= 0 AND "bad_debt_relief_source" IN ('recorded', 'migrated'))
);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_written_off_chk" CHECK ("written_off_amount" >= 0);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_bad_debt_relief_journal_entry_id_fk" FOREIGN KEY ("bad_debt_relief_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment_classifications" ADD CONSTRAINT "payment_classifications_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;
