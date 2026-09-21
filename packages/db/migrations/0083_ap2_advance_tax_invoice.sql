CREATE TABLE "invoice_prepayments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"invoice_id" integer NOT NULL,
	"advance_invoice_id" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"taxable_amount" numeric(15, 2) NOT NULL,
	"tax_amount" numeric(15, 2) NOT NULL,
	"tax_category_code" text NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"allocation_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_prepayments_amount_positive_chk" CHECK (amount > 0),
	CONSTRAINT "invoice_prepayments_split_chk" CHECK (amount = taxable_amount + tax_amount AND taxable_amount >= 0 AND tax_amount >= 0),
	CONSTRAINT "invoice_prepayments_category_chk" CHECK (tax_category_code IN ('S', 'Z', 'E')),
	CONSTRAINT "invoice_prepayments_not_self_chk" CHECK (invoice_id <> advance_invoice_id)
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "advance_payment_id" integer;--> statement-breakpoint
ALTER TABLE "invoice_prepayments" ADD CONSTRAINT "invoice_prepayments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_prepayments" ADD CONSTRAINT "invoice_prepayments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_prepayments" ADD CONSTRAINT "invoice_prepayments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_prepayments" ADD CONSTRAINT "invoice_prepayments_advance_invoice_id_invoices_id_fk" FOREIGN KEY ("advance_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_prepayments" ADD CONSTRAINT "invoice_prepayments_allocation_id_payment_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."payment_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_prepayments_pair_unq" ON "invoice_prepayments" USING btree ("invoice_id","advance_invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_prepayments_advance_idx" ON "invoice_prepayments" USING btree ("advance_invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_advance_payment_idx" ON "invoices" USING btree ("advance_payment_id");;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- AP-2 (2026-09-21) — hand-written tail. THE ADVANCE TAX INVOICE (type 386)
-- AND THE FINAL INVOICE'S PREPAYMENT ADJUSTMENT.
-- Decision record: docs/product/advance-payments-decision-pack.md §6 (E2/E3,
-- accountant A2), §14 (as built). Authority: ZATCA XML Implementation
-- Standard v1.2 ¶9.5, BR-KSA-73…82; GCC VAT Agreement Art. 23(1); IR Art.
-- 53(1)(a)(2).
--
-- 1. `invoices.advance_payment_id` — a real FK to `payments` (RESTRICT: the
--    receipt an issued 386 declares VAT for is never deleted; payments are
--    append-only anyway). Declared as a plain integer in Drizzle because the
--    schema import would be circular (the 0081 pattern).
-- 2. The 0020 pairing CHECK `invoices_note_reference_chk` is REPLACED so an
--    `advance_invoice` row can exist at all: it carries no original and no
--    note reason (it is not a correction document), exactly like an
--    ordinary invoice. A new CHECK `invoices_advance_reference_chk` makes the
--    receipt link mandatory on a 386 and impossible on anything else — the
--    wrong pairing cannot be SAID.
-- 3. `invoice_prepayments`: tenant isolation (org + N1 company arm); the app
--    role may SELECT/INSERT/UPDATE/DELETE (a DRAFT's selection is edited and
--    deleted like its lines; `allocation_id` is set at approval), owner-only
--    REVOKE of TRUNCATE/REFERENCES/TRIGGER (the M14 pattern).
-- 4. Trigger `refuse_issued_prepayment_change`: once the FINAL invoice is
--    ISSUED (it carries a hash) its adjustment rows are FROZEN — the
--    signed XML says what was adjusted, and the folded allocation is
--    corrected by a credit note on that invoice, never by an edit. The one
--    permitted change is the approval's own act: setting `allocation_id`
--    from NULL, once. No row of an issued invoice is ever deleted; a row
--    can only be inserted while the invoice is a draft.
-- No data is written by this migration.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_advance_payment_id_payments_id_fk"
  FOREIGN KEY ("advance_payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "invoices" DROP CONSTRAINT "invoices_note_reference_chk";--> statement-breakpoint
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_note_reference_chk" CHECK (
    (
      "document_type" IN ('invoice', 'advance_invoice')
      AND "original_invoice_id" IS NULL
      AND "note_reason" IS NULL
    )
    OR (
      "document_type" IN ('credit_note', 'debit_note')
      AND "original_invoice_id" IS NOT NULL
      AND "note_reason" IS NOT NULL
    )
  );--> statement-breakpoint
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_advance_reference_chk" CHECK (
    ("document_type" = 'advance_invoice') = ("advance_payment_id" IS NOT NULL)
  );--> statement-breakpoint

ALTER TABLE "invoice_prepayments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "invoice_prepayments"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "invoice_prepayments" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "invoice_prepayments_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.invoice_prepayments FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION refuse_issued_prepayment_change() RETURNS trigger AS $$
DECLARE
  issued boolean;
  old_j jsonb;
  new_j jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT (i.invoice_hash IS NOT NULL) INTO issued FROM invoices i WHERE i.id = NEW.invoice_id;
    IF coalesce(issued, false) THEN
      RAISE EXCEPTION 'invoice % is issued; a prepayment adjustment is stated on the draft and frozen by the signed document', NEW.invoice_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'prepayment_issued_frozen';
    END IF;
    RETURN NEW;
  END IF;
  SELECT (i.invoice_hash IS NOT NULL) INTO issued FROM invoices i WHERE i.id = OLD.invoice_id;
  IF NOT coalesce(issued, false) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prepayment adjustment % of issued invoice % is frozen: the signed document states it; correct with a credit note', OLD.id, OLD.invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'prepayment_issued_frozen';
  END IF;
  -- The approval's own act: allocation_id NULL → set, once. Every other column is frozen.
  old_j := to_jsonb(OLD) - 'allocation_id'; new_j := to_jsonb(NEW) - 'allocation_id';
  IF old_j <> new_j OR (OLD.allocation_id IS NOT NULL AND NEW.allocation_id IS DISTINCT FROM OLD.allocation_id) THEN
    RAISE EXCEPTION 'prepayment adjustment % of issued invoice % is frozen: the signed document states it; correct with a credit note', OLD.id, OLD.invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'prepayment_issued_frozen';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER invoice_prepayments_issued_frozen_trg BEFORE INSERT OR UPDATE OR DELETE ON "invoice_prepayments" FOR EACH ROW EXECUTE FUNCTION refuse_issued_prepayment_change();
