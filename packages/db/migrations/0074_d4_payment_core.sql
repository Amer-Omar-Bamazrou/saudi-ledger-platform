-- D-4 / Batch 1B Part 1 (2026-09-17) — the customer payment core.
-- Generated part: payments, payment_allocations, invoices.credited_amount.
-- Hand-written tail: the two customer-credit liabilities, the credited_amount
-- backfill, RLS, append-only grants. See docs/product/batch-1b-decision-pack.md.
CREATE TABLE "payment_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"payment_id" integer,
	"credit_note_id" integer,
	"invoice_id" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"journal_entry_id" integer,
	"idempotency_key" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_amount_positive_chk" CHECK (amount > 0),
	CONSTRAINT "payment_allocations_one_source_chk" CHECK ((payment_id IS NOT NULL) <> (credit_note_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"direction" text NOT NULL,
	"party_type" text NOT NULL,
	"customer_id" integer,
	"bank_account_id" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"paid_at" date NOT NULL,
	"method" text,
	"reference" text,
	"idempotency_key" text,
	"source" text NOT NULL,
	"journal_entry_id" integer NOT NULL,
	"source_transaction_id" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_positive_chk" CHECK (amount > 0),
	CONSTRAINT "payments_direction_chk" CHECK (direction IN ('in', 'out')),
	CONSTRAINT "payments_party_chk" CHECK ((party_type = 'customer' AND customer_id IS NOT NULL) OR (party_type = 'none' AND customer_id IS NULL)),
	CONSTRAINT "payments_source_chk" CHECK (source IN ('manual', 'invoice_pay', 'settlement'))
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "credited_amount" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_credit_note_id_invoices_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_source_transaction_id_transactions_id_fk" FOREIGN KEY ("source_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_payment_invoice_unq" ON "payment_allocations" USING btree ("payment_id","invoice_id") WHERE payment_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_note_invoice_unq" ON "payment_allocations" USING btree ("credit_note_id","invoice_id") WHERE credit_note_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_idempotency_unq" ON "payment_allocations" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_unq" ON "payments" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_customer_idx" ON "payments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "payments_company_idx" ON "payments" USING btree ("company_id");
-- ═══════════════════════════════════════════════════════════════════════════
-- D-4 / Batch 1B Part 1 (2026-09-17) — hand-written tail.
--
-- Above (generated): `payments`, `payment_allocations`, `invoices.credited_amount`.
-- Below: the two customer-credit liability accounts, the credited_amount
-- backfill from the credit notes already in the books, RLS and the
-- append-only grants. Decision record: docs/product/batch-1b-decision-pack.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Two customer-credit LIABILITIES, party-carrying (batch-1b pack §1.2) ──
-- CUSTOMER_DEPOSITS: cash received that no invoice yet explains — a contract
-- liability, never a credit inside AR (accountant-confirmed).
-- CUSTOMER_CREDITS: the part of a credit note beyond its original invoice's
-- open balance — a refund liability. Two accounts because the natures, VAT
-- states and exits differ; the origin → account mapping lives in ONE place
-- in code (customerCreditPolicy.ts) so the policy can change later.
INSERT INTO "system_account_templates" (code, name, name_ar, type, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, sort_order)
VALUES
  ('CUSTOMER_DEPOSITS', 'Customer deposits and advances', 'ودائع ودفعات مقدمة من العملاء', 'liability', true, false, 'O', false, 'current', 72),
  ('CUSTOMER_CREDITS',  'Customer credit balances',       'أرصدة دائنة للعملاء',           'liability', true, false, 'O', false, 'current', 74)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- Existing organizations get the accounts too (the org-seed trigger fires only
-- for NEW orgs — the M13 lesson; a fail-closed posting path would refuse the
-- next unapplied receipt on every existing tenant otherwise).
INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, is_posting)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class, true
  FROM organizations o
  CROSS JOIN system_account_templates t
 WHERE t.code IN ('CUSTOMER_DEPOSITS', 'CUSTOMER_CREDITS')
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

-- ── 2. credited_amount backfill — history as it was posted, not re-decided ──
-- Every approved credit note in the books today credited AR for its FULL
-- total against its original (the pre-D-4 rule). The cache and the
-- allocation rows record exactly that, so `total − paid − credited` reads
-- the same number the old derivation read, and Σ allocations = the cache
-- from the first day. A historical note that exceeded its original's open
-- balance therefore still shows that invoice negative — the pre-D-4 state,
-- left visible for the D-4 backfill to classify rather than silently moved
-- to the new liability (no journal line is touched here).
INSERT INTO "payment_allocations" (organization_id, company_id, credit_note_id, invoice_id, amount, journal_entry_id, created_at)
SELECT n.organization_id, n.company_id, n.id, n.original_invoice_id, n.total::numeric,
       (SELECT e.id FROM journal_entries e
         WHERE e.company_id = n.company_id AND e.entry_number = 'GL-' || n.invoice_number
         ORDER BY e.id LIMIT 1),
       COALESCE(n.issued_at, n.created_at, now())
  FROM invoices n
 WHERE n.document_type = 'credit_note'
   AND n.invoice_hash IS NOT NULL
   AND n.original_invoice_id IS NOT NULL
   AND n.total::numeric > 0
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE "invoices" i
   SET credited_amount = s.credited
  FROM (SELECT invoice_id, sum(amount) AS credited FROM payment_allocations WHERE credit_note_id IS NOT NULL GROUP BY invoice_id) s
 WHERE s.invoice_id = i.id;--> statement-breakpoint

-- ── 3. Tenant isolation (org + N1 company arm), append-only for the app role ──
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "payments"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "payment_allocations"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE "payments" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "payment_allocations" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "payments_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "payment_allocations_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payments', 'payment_allocations'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.payments FROM authenticated';
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.payment_allocations FROM authenticated';
  END IF;
END $$;
