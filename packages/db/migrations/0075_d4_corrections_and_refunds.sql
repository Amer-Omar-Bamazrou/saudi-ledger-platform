-- Batch 1B Part 2 (2026-09-17): allocation corrections (Phase A) and customer refunds (Phase C).
CREATE TABLE "customer_refunds" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"customer_id" integer NOT NULL,
	"bank_account_id" integer NOT NULL,
	"origin" text NOT NULL,
	"payment_id" integer,
	"credit_note_id" integer,
	"amount" numeric(15, 2) NOT NULL,
	"refunded_at" date NOT NULL,
	"reason" text NOT NULL,
	"reference" text,
	"journal_entry_id" integer NOT NULL,
	"idempotency_key" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_refunds_amount_positive_chk" CHECK (amount > 0),
	CONSTRAINT "customer_refunds_origin_chk" CHECK ((origin = 'deposit' AND payment_id IS NOT NULL AND credit_note_id IS NULL) OR (origin = 'credit_note' AND credit_note_id IS NOT NULL AND payment_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "payment_allocation_reversals" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"allocation_id" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"journal_entry_id" integer NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocation_reversals_amount_positive_chk" CHECK (amount > 0)
);
--> statement-breakpoint
DROP INDEX "payment_allocations_payment_invoice_unq";--> statement-breakpoint
DROP INDEX "payment_allocations_note_invoice_unq";--> statement-breakpoint
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_credit_note_id_invoices_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_reversals" ADD CONSTRAINT "payment_allocation_reversals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_reversals" ADD CONSTRAINT "payment_allocation_reversals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_reversals" ADD CONSTRAINT "payment_allocation_reversals_allocation_id_payment_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."payment_allocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocation_reversals" ADD CONSTRAINT "payment_allocation_reversals_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_refunds_idempotency_unq" ON "customer_refunds" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_refunds_customer_idx" ON "customer_refunds" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_refunds_payment_idx" ON "customer_refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "customer_refunds_note_idx" ON "customer_refunds" USING btree ("credit_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocation_reversals_allocation_unq" ON "payment_allocation_reversals" USING btree ("allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocation_reversals_idempotency_unq" ON "payment_allocation_reversals" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;
-- ═══════════════════════════════════════════════════════════════════════════
-- Batch 1B Part 2, Phases A + C (2026-09-17) — hand-written tail.
-- Above (generated): payment_allocation_reversals, customer_refunds, and the
-- removal of the (payment, invoice) / (note, invoice) pair-unique indexes
-- (a corrected allocation may be re-made to the same invoice; the service
-- enforces one ACTIVE allocation per pair under the source lock).
-- Below: tenant isolation (org + N1 company arm) and append-only grants.
-- 0074 is untouched. No data is written by this migration.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "payment_allocation_reversals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "payment_allocation_reversals"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "customer_refunds"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE "payment_allocation_reversals" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "customer_refunds" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "payment_allocation_reversals_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "customer_refunds_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_allocation_reversals', 'customer_refunds'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.payment_allocation_reversals FROM authenticated';
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.customer_refunds FROM authenticated';
  END IF;
END $$;
