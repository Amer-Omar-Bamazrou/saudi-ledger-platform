CREATE TABLE "supplier_payment_allocation_reversals" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"allocation_id" integer NOT NULL,
	"reason" text NOT NULL,
	"journal_entry_id" integer NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_payment_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"supplier_payment_id" integer,
	"supplier_credit_note_id" integer,
	"bill_id" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"journal_entry_id" integer,
	"idempotency_key" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payment_allocations_amount_positive_chk" CHECK (amount > 0),
	CONSTRAINT "supplier_payment_allocations_one_source_chk" CHECK ((supplier_payment_id IS NOT NULL) <> (supplier_credit_note_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "supplier_payment_classifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"supplier_payment_id" integer NOT NULL,
	"classification" text NOT NULL,
	"note" text,
	"effective_date" date,
	"journal_entry_id" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payment_classifications_kind_chk" CHECK (classification IN ('advance', 'security_deposit', 'erroneous', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"vendor_id" integer NOT NULL,
	"bank_account_id" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"paid_at" date NOT NULL,
	"method" text,
	"reference" text,
	"notes" text,
	"classification" text DEFAULT 'unknown' NOT NULL,
	"source" text NOT NULL,
	"journal_entry_id" integer NOT NULL,
	"idempotency_key" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payments_amount_positive_chk" CHECK (amount > 0),
	CONSTRAINT "supplier_payments_classification_chk" CHECK (classification IN ('advance', 'security_deposit', 'erroneous', 'unknown')),
	CONSTRAINT "supplier_payments_source_chk" CHECK (source IN ('manual', 'bill_pay', 'opening'))
);
--> statement-breakpoint
CREATE TABLE "supplier_refunds" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"supplier_payment_id" integer NOT NULL,
	"vendor_id" integer NOT NULL,
	"bank_account_id" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"refunded_at" date NOT NULL,
	"reason" text NOT NULL,
	"journal_entry_id" integer NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_refunds_amount_positive_chk" CHECK (amount > 0)
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "document_type" text DEFAULT 'bill' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "credit_note_against_bill_id" integer;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocation_reversals" ADD CONSTRAINT "supplier_payment_allocation_reversals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocation_reversals" ADD CONSTRAINT "supplier_payment_allocation_reversals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocation_reversals" ADD CONSTRAINT "supplier_payment_allocation_reversals_allocation_id_supplier_payment_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."supplier_payment_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocation_reversals" ADD CONSTRAINT "supplier_payment_allocation_reversals_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_supplier_payment_id_supplier_payments_id_fk" FOREIGN KEY ("supplier_payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_supplier_credit_note_id_bills_id_fk" FOREIGN KEY ("supplier_credit_note_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_classifications" ADD CONSTRAINT "supplier_payment_classifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_classifications" ADD CONSTRAINT "supplier_payment_classifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_classifications" ADD CONSTRAINT "supplier_payment_classifications_supplier_payment_id_supplier_payments_id_fk" FOREIGN KEY ("supplier_payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_classifications" ADD CONSTRAINT "supplier_payment_classifications_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_supplier_payment_id_supplier_payments_id_fk" FOREIGN KEY ("supplier_payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payment_allocation_reversals_allocation_unq" ON "supplier_payment_allocation_reversals" USING btree ("allocation_id");--> statement-breakpoint
CREATE INDEX "supplier_payment_allocations_bill_idx" ON "supplier_payment_allocations" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "supplier_payment_allocations_payment_idx" ON "supplier_payment_allocations" USING btree ("supplier_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payment_allocations_idempotency_unq" ON "supplier_payment_allocations" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "supplier_payment_classifications_payment_idx" ON "supplier_payment_classifications" USING btree ("supplier_payment_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_vendor_idx" ON "supplier_payments" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_company_idx" ON "supplier_payments" USING btree ("company_id","paid_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payments_idempotency_unq" ON "supplier_payments" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "supplier_refunds_payment_idx" ON "supplier_refunds" USING btree ("supplier_payment_id");

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 11 Part 2 — the AP subledger.
-- Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §9–§12.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The AP on-account assets, and the WHT liability ─────────────────────
-- 🔴 A customer advance is a LIABILITY; a supplier advance is an ASSET. Three
-- accounts because their exits differ: an advance leaves by being applied to a
-- bill, a security deposit by being returned or forfeited, an unidentified
-- payment by being identified. Collapsing them would make "what is this money"
-- unanswerable from the ledger.
INSERT INTO "system_account_templates" (code, name, name_ar, type, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, sort_order)
VALUES
  ('SUPPLIER_ADVANCES',      'Supplier advances',                   'دفعات مقدمة للموردين',            'asset',     true, false, 'O', false, 'current', 149),
  ('SECURITY_DEPOSITS_PAID', 'Refundable security deposits paid',   'تأمينات مستردة مدفوعة',           'asset',     true, false, 'O', false, 'current', 150),
  ('UNIDENTIFIED_PAYMENTS',  'Unidentified and erroneous payments', 'مدفوعات غير محددة أو خاطئة',      'asset',     true, false, 'O', false, 'current', 151),
  ('WHT_PAYABLE',            'Withholding tax payable',             'ضريبة استقطاع مستحقة',            'liability', true, false, 'O', false, 'current', 269)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, is_posting)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class, true
  FROM organizations o
  CROSS JOIN system_account_templates t
 WHERE t.code IN ('SUPPLIER_ADVANCES', 'SECURITY_DEPOSITS_PAID', 'UNIDENTIFIED_PAYMENTS', 'WHT_PAYABLE')
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

-- ── 2. B7: the purchase-side document type ─────────────────────────────────
ALTER TABLE "bills" ADD CONSTRAINT "bills_document_type_chk" CHECK (document_type IN ('bill', 'credit_note', 'debit_note'));--> statement-breakpoint
-- A note adjusts a bill and says which; an ordinary bill adjusts nothing. Both
-- halves, so neither a note without its source nor a bill pretending to have
-- one can be stored.
ALTER TABLE "bills" ADD CONSTRAINT "bills_note_against_chk"
  CHECK ((document_type = 'bill') = (credit_note_against_bill_id IS NULL));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_note_against_fk"
  FOREIGN KEY ("credit_note_against_bill_id") REFERENCES "public"."bills"("id") ON DELETE restrict;--> statement-breakpoint

-- ── 3. Tenancy (CLAUDE.md §4) ──────────────────────────────────────────────
-- 🔴 No DELETE grant anywhere in this subledger: a payment, an allocation,
-- its correction, a classification and a refund are all records of something
-- that happened. UPDATE is granted only because an allocation's journal entry
-- id is filled in after the entry exists, inside the same transaction.
ALTER TABLE "supplier_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."supplier_payments"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "supplier_payments" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "supplier_payments_id_seq" TO authenticated;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."supplier_payment_allocations"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "supplier_payment_allocations" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "supplier_payment_allocations_id_seq" TO authenticated;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocation_reversals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."supplier_payment_allocation_reversals"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "supplier_payment_allocation_reversals" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "supplier_payment_allocation_reversals_id_seq" TO authenticated;--> statement-breakpoint
ALTER TABLE "supplier_payment_classifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."supplier_payment_classifications"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "supplier_payment_classifications" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "supplier_payment_classifications_id_seq" TO authenticated;--> statement-breakpoint
ALTER TABLE "supplier_refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."supplier_refunds"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "supplier_refunds" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "supplier_refunds_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_payments', 'supplier_payment_allocations', 'supplier_payment_allocation_reversals', 'supplier_payment_classifications', 'supplier_refunds'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
        EXECUTE format('REVOKE DELETE ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint

-- ── 4. A POSTED AP RECORD IS IMMUTABLE ─────────────────────────────────────
-- The money moved. A correction is a SUPERSEDING record (an allocation
-- reversal, a refund, a reclassification) and never an edit — the same rule
-- the AR side and the fixed-asset schedule carry, enforced at the write
-- boundary because per-path enforcement is per-path review.
CREATE OR REPLACE FUNCTION refuse_supplier_payment_change() RETURNS trigger AS $$
BEGIN
  IF pg_has_role(current_user, 'authenticated', 'MEMBER') AND (
       NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
    OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
    OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
    OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id) THEN
    RAISE EXCEPTION 'A posted supplier payment is a fact of record (payment %) — correct it with a reversal or a refund, not an edit.', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER supplier_payments_immutable
  BEFORE UPDATE ON public."supplier_payments"
  FOR EACH ROW EXECUTE FUNCTION refuse_supplier_payment_change();--> statement-breakpoint

CREATE OR REPLACE FUNCTION refuse_supplier_allocation_change() RETURNS trigger AS $$
BEGIN
  IF pg_has_role(current_user, 'authenticated', 'MEMBER') AND OLD.journal_entry_id IS NOT NULL AND (
       NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.bill_id IS DISTINCT FROM OLD.bill_id
    OR NEW.supplier_payment_id IS DISTINCT FROM OLD.supplier_payment_id
    OR NEW.supplier_credit_note_id IS DISTINCT FROM OLD.supplier_credit_note_id
    OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id) THEN
    RAISE EXCEPTION 'A posted allocation is a fact of record (allocation %) — reverse it instead of editing it.', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER supplier_payment_allocations_immutable
  BEFORE UPDATE ON public."supplier_payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION refuse_supplier_allocation_change();
