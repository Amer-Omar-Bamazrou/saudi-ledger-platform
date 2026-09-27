ALTER TABLE "bills" ADD COLUMN "supplier_document_kind" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "vat_evidence_status" text DEFAULT 'not_evaluated' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "vat_evidence_basis" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "vat_evidence_flags" jsonb;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "vat_evidence_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "recorded_as_expense" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "expense_paid_from_bank_account_id" integer;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "expense_paid_at" text;--> statement-breakpoint
ALTER TABLE "captured_documents" ADD COLUMN "review_corrections" jsonb;--> statement-breakpoint
CREATE INDEX "bills_company_vendor_ref_idx" ON "bills" USING btree ("company_id","vendor_id","vendor_reference");--> statement-breakpoint
CREATE INDEX "bills_company_evidence_idx" ON "bills" USING btree ("company_id","vat_evidence_status");--> statement-breakpoint
CREATE INDEX "captured_documents_company_sha_idx" ON "captured_documents" USING btree ("company_id","sha256");--> statement-breakpoint

-- ── Phase 13A/13C (2026-09-24) — hand-written; drizzle does not track CHECKs,
-- ── triggers or this FK. Do not drop on a snapshot diff.
-- Record: docs/product/phase-13-expenses-accountant-questions.md (what is NOT
-- decided here) and services/purchaseEvidence/vatEvidence.ts (the verdict).

ALTER TABLE "bills" ADD CONSTRAINT "bills_supplier_document_kind_chk"
  CHECK (supplier_document_kind IS NULL OR supplier_document_kind IN ('tax_invoice', 'simplified_tax_invoice', 'no_tax_invoice'));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_vat_evidence_status_chk"
  CHECK (vat_evidence_status IN ('not_evaluated', 'not_required', 'evidenced', 'awaiting_evidence', 'not_deductible'));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_vat_evidence_basis_chk"
  CHECK (vat_evidence_basis IS NULL OR vat_evidence_basis IN ('qr_signature_verified', 'qr_unsigned', 'document_attached', 'attested'));--> statement-breakpoint

-- 13C: an EXPENSE is a plain bill that names the bank it was paid from and the
-- date; a bill that is not an expense names neither. Both halves enforced.
ALTER TABLE "bills" ADD CONSTRAINT "bills_expense_chk"
  CHECK (
    (recorded_as_expense AND document_type = 'bill' AND expense_paid_from_bank_account_id IS NOT NULL
       AND expense_paid_at ~ '^\d{4}-\d{2}-\d{2}$')
    OR (NOT recorded_as_expense AND expense_paid_from_bank_account_id IS NULL AND expense_paid_at IS NULL)
  );--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_expense_bank_fk" FOREIGN KEY ("expense_paid_from_bank_account_id")
  REFERENCES "public"."bank_accounts"("id") ON DELETE RESTRICT ON UPDATE no action;--> statement-breakpoint

-- 🔴 THE EVIDENCE GATE, AT THE WRITE BOUNDARY. A bill becomes POSTED only by
-- the approval transition (draft/submitted → anything else), and it may make
-- that transition only when the server's verdict supports the input VAT the
-- entry claims:
--   not_required    nothing to claim (no VAT, a credit note, fully prepaid);
--   evidenced       the claim is supported;
--   not_deductible  ONLY for a bill that capitalises a fixed asset at 0 %
--                   recovery — the existing FA treatment, which claims no VAT.
-- `awaiting_evidence`, an Art. 50 `not_deductible` and `not_evaluated` are
-- refused: a path that forgets to evaluate cannot post. Limit, stated: this
-- guards the TRANSITION; a row INSERTED already posted (migration opening
-- items, test fixtures) never passes through approval and is not seen here.
CREATE OR REPLACE FUNCTION bills_vat_evidence_gate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('draft', 'submitted') AND NEW.status NOT IN ('draft', 'submitted') THEN
    IF NOT (
         NEW.vat_evidence_status IN ('not_required', 'evidenced')
      OR (NEW.vat_evidence_status = 'not_deductible' AND NEW.capitalises_asset_id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'bill % (%) cannot be posted: its VAT evidence verdict is %', NEW.id, NEW.bill_number, NEW.vat_evidence_status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bills_vat_evidence_gate';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER bills_vat_evidence_gate BEFORE UPDATE OF status ON "bills"
  FOR EACH ROW EXECUTE FUNCTION bills_vat_evidence_gate();
