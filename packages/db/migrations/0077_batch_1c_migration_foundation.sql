-- Batch 1C (2026-09-18): migration batches, chart mapping rows, parties, open items, advances; opening markers; journal source; account codes; bank opening journal link.
CREATE TABLE "migration_advances" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"batch_id" integer NOT NULL,
	"source_system" text NOT NULL,
	"source_id" text NOT NULL,
	"party_source_id" text NOT NULL,
	"bank_source_code" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"received_at" date NOT NULL,
	"reference" text,
	"vat_position" text NOT NULL,
	"advance_invoice_number" text,
	"advance_invoice_date" date,
	"advance_invoice_time" text,
	"vat_category" text,
	"vat_rate" numeric(5, 2),
	"vat_amount" numeric(15, 2),
	"resolved_payment_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_advances_amount_chk" CHECK (amount > 0),
	CONSTRAINT "migration_advances_vat_position_chk" CHECK (vat_position IN ('invoiced', 'unknown')),
	CONSTRAINT "migration_advances_invoiced_chk" CHECK (vat_position <> 'invoiced' OR advance_invoice_number IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "migration_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"source_system" text NOT NULL,
	"source_version" text,
	"cutover_date" date NOT NULL,
	"opening_date" date NOT NULL,
	"notes" text,
	"idempotency_key" text,
	"content_hash" text,
	"validation" jsonb,
	"reconciliation" jsonb,
	"opening_journal_entry_id" integer,
	"clearing_journal_entry_id" integer,
	"reversal_journal_entry_id" integer,
	"period_lock_id" integer,
	"created_by" integer,
	"validated_at" timestamp with time zone,
	"committed_by" integer,
	"committed_at" timestamp with time zone,
	"reversed_by" integer,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_batches_status_chk" CHECK (status IN ('draft', 'validated', 'committed', 'reversed', 'discarded')),
	CONSTRAINT "migration_batches_opening_date_chk" CHECK (opening_date = cutover_date - INTERVAL '1 day')
);
--> statement-breakpoint
CREATE TABLE "migration_chart_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"batch_id" integer NOT NULL,
	"source_system" text NOT NULL,
	"source_code" text NOT NULL,
	"source_name" text NOT NULL,
	"source_name_ar" text,
	"source_parent_code" text,
	"source_type" text NOT NULL,
	"source_is_group" boolean DEFAULT false NOT NULL,
	"source_currency" text DEFAULT 'SAR' NOT NULL,
	"opening_debit" numeric(15, 2) DEFAULT '0' NOT NULL,
	"opening_credit" numeric(15, 2) DEFAULT '0' NOT NULL,
	"source_role" text,
	"evidence_note" text,
	"decision" text,
	"target_system_code" text,
	"target_bank_account_id" integer,
	"target_category_id" integer,
	"skip_reason" text,
	"decided_by" integer,
	"decided_at" timestamp with time zone,
	"resolved_category_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_chart_rows_type_chk" CHECK (source_type IN ('asset', 'liability', 'equity', 'income', 'expense')),
	CONSTRAINT "migration_chart_rows_decision_chk" CHECK (decision IS NULL OR decision IN ('map_to_system', 'map_to_bank', 'create', 'merge_into', 'skip')),
	CONSTRAINT "migration_chart_rows_amounts_chk" CHECK (opening_debit >= 0 AND opening_credit >= 0),
	CONSTRAINT "migration_chart_rows_currency_chk" CHECK (source_currency = 'SAR')
);
--> statement-breakpoint
CREATE TABLE "migration_open_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"batch_id" integer NOT NULL,
	"source_system" text NOT NULL,
	"source_id" text NOT NULL,
	"item_type" text NOT NULL,
	"party_source_id" text NOT NULL,
	"document_number" text NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"original_amount" numeric(15, 2) NOT NULL,
	"outstanding_amount" numeric(15, 2) NOT NULL,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"composition_unknown" boolean DEFAULT false NOT NULL,
	"historical_vat" jsonb,
	"description" text,
	"resolved_invoice_id" integer,
	"resolved_bill_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_open_items_type_chk" CHECK (item_type IN ('ar', 'ap')),
	CONSTRAINT "migration_open_items_amounts_chk" CHECK (outstanding_amount > 0 AND original_amount >= outstanding_amount),
	CONSTRAINT "migration_open_items_currency_chk" CHECK (currency = 'SAR')
);
--> statement-breakpoint
CREATE TABLE "migration_parties" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"batch_id" integer NOT NULL,
	"source_system" text NOT NULL,
	"party_type" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"tax_number" text,
	"cr_number" text,
	"phone" text,
	"email" text,
	"address" text,
	"city" text,
	"decision" text DEFAULT 'create' NOT NULL,
	"existing_customer_id" integer,
	"existing_vendor_id" integer,
	"resolved_customer_id" integer,
	"resolved_vendor_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_parties_type_chk" CHECK (party_type IN ('customer', 'vendor')),
	CONSTRAINT "migration_parties_decision_chk" CHECK (decision IN ('create', 'use_existing'))
);
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_source_chk";--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "account_code" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "is_opening" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "migration_open_item_id" integer;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "is_opening" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "migration_open_item_id" integer;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "migration_batch_id" integer;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "opening_journal_entry_id" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "migration_advance_id" integer;--> statement-breakpoint
ALTER TABLE "migration_advances" ADD CONSTRAINT "migration_advances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_advances" ADD CONSTRAINT "migration_advances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_advances" ADD CONSTRAINT "migration_advances_batch_id_migration_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_advances" ADD CONSTRAINT "migration_advances_resolved_payment_id_payments_id_fk" FOREIGN KEY ("resolved_payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_batches" ADD CONSTRAINT "migration_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_batches" ADD CONSTRAINT "migration_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_batches" ADD CONSTRAINT "migration_batches_opening_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("opening_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_batches" ADD CONSTRAINT "migration_batches_clearing_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("clearing_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_batches" ADD CONSTRAINT "migration_batches_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_batches" ADD CONSTRAINT "migration_batches_period_lock_id_period_locks_id_fk" FOREIGN KEY ("period_lock_id") REFERENCES "public"."period_locks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_chart_rows" ADD CONSTRAINT "migration_chart_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_chart_rows" ADD CONSTRAINT "migration_chart_rows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_chart_rows" ADD CONSTRAINT "migration_chart_rows_batch_id_migration_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_chart_rows" ADD CONSTRAINT "migration_chart_rows_target_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("target_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_chart_rows" ADD CONSTRAINT "migration_chart_rows_target_category_id_categories_id_fk" FOREIGN KEY ("target_category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_chart_rows" ADD CONSTRAINT "migration_chart_rows_resolved_category_id_categories_id_fk" FOREIGN KEY ("resolved_category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_open_items" ADD CONSTRAINT "migration_open_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_open_items" ADD CONSTRAINT "migration_open_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_open_items" ADD CONSTRAINT "migration_open_items_batch_id_migration_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_open_items" ADD CONSTRAINT "migration_open_items_resolved_invoice_id_invoices_id_fk" FOREIGN KEY ("resolved_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_open_items" ADD CONSTRAINT "migration_open_items_resolved_bill_id_bills_id_fk" FOREIGN KEY ("resolved_bill_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_parties" ADD CONSTRAINT "migration_parties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_parties" ADD CONSTRAINT "migration_parties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_parties" ADD CONSTRAINT "migration_parties_batch_id_migration_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_parties" ADD CONSTRAINT "migration_parties_existing_customer_id_customers_id_fk" FOREIGN KEY ("existing_customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_parties" ADD CONSTRAINT "migration_parties_existing_vendor_id_vendors_id_fk" FOREIGN KEY ("existing_vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_parties" ADD CONSTRAINT "migration_parties_resolved_customer_id_customers_id_fk" FOREIGN KEY ("resolved_customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_parties" ADD CONSTRAINT "migration_parties_resolved_vendor_id_vendors_id_fk" FOREIGN KEY ("resolved_vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_advances_identity_unq" ON "migration_advances" USING btree ("company_id","source_system","source_id");--> statement-breakpoint
CREATE INDEX "migration_advances_batch_idx" ON "migration_advances" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "migration_batches_company_idx" ON "migration_batches" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_batches_company_committed_unq" ON "migration_batches" USING btree ("company_id") WHERE status = 'committed';--> statement-breakpoint
CREATE UNIQUE INDEX "migration_batches_idempotency_unq" ON "migration_batches" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_chart_rows_batch_code_unq" ON "migration_chart_rows" USING btree ("batch_id","source_code");--> statement-breakpoint
CREATE INDEX "migration_chart_rows_batch_idx" ON "migration_chart_rows" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_open_items_identity_unq" ON "migration_open_items" USING btree ("company_id","source_system","source_id");--> statement-breakpoint
CREATE INDEX "migration_open_items_batch_idx" ON "migration_open_items" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_parties_identity_unq" ON "migration_parties" USING btree ("company_id","source_system","party_type","source_id");--> statement-breakpoint
CREATE INDEX "migration_parties_batch_idx" ON "migration_parties" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_org_account_code_unq" ON "categories" USING btree ("organization_id","account_code") WHERE account_code IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_source_chk" CHECK (source IN ('manual', 'invoice_pay', 'settlement', 'opening'));--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- Batch 1C (2026-09-18) — hand-written tail. Decision record:
-- docs/product/batch-1c-migration-opening-balances-decision-pack.md §15.
--
-- 1. Two equity system accounts. OPENING_BALANCE_EQUITY is the TEMPORARY
--    landing side of a migration's opening journal — never a plug (an
--    unbalanced opening is refused by the service), cleared to
--    RETAINED_EARNINGS only by the accountant's explicit dated journal.
--    RETAINED_EARNINGS is the STORED brought-forward equity of a migrated
--    company (retained earnings was computed-only before this batch).
--    Templates first (the org-seed trigger reads them for NEW orgs), then the
--    rows for EXISTING orgs (the M13 lesson). The trigger itself needs no
--    redefinition: `account_code` was added to categories only, and the seed
--    copies the columns the two tables SHARE (tests/org-seed-trigger.test.ts).
-- 2. Foreign keys for the columns declared as plain integers in Drizzle (to
--    avoid a circular schema import): invoices/bills → migration_open_items
--    (one item → one document, UNIQUE), payments → migration_advances (UNIQUE),
--    journal_entries → migration_batches, bank_accounts → journal_entries.
-- 3. `journal_entries.source` is constrained to the values readers key on.
-- 4. Tenant isolation, grants (staging rows are edited while a batch is a
--    draft; batches are never deleted — a draft is DISCARDED by status), and
--    the owner-only REVOKE pattern.
-- 5. IMMUTABILITY: once a batch is committed, its staging rows cannot change
--    and the batch itself may only move to `reversed` / gain its clearing or
--    reversal journal ids — enforced by trigger, so no service path can edit
--    a committed migration.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO "system_account_templates" (code, name, name_ar, type, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, sort_order)
VALUES
  ('OPENING_BALANCE_EQUITY', 'Opening balance equity (migration)', 'حقوق الملكية الافتتاحية (ترحيل)', 'equity', true, false, 'O', false, NULL, 82),
  ('RETAINED_EARNINGS',      'Retained earnings',                  'الأرباح المبقاة',                'equity', true, false, 'O', false, NULL, 84)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, is_posting)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class, true
  FROM organizations o
  CROSS JOIN system_account_templates t
 WHERE t.code IN ('OPENING_BALANCE_EQUITY', 'RETAINED_EARNINGS')
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_migration_open_item_id_fk" FOREIGN KEY ("migration_open_item_id") REFERENCES "public"."migration_open_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_migration_open_item_id_fk" FOREIGN KEY ("migration_open_item_id") REFERENCES "public"."migration_open_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_migration_advance_id_fk" FOREIGN KEY ("migration_advance_id") REFERENCES "public"."migration_advances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_migration_batch_id_fk" FOREIGN KEY ("migration_batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_opening_journal_entry_id_fk" FOREIGN KEY ("opening_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_migration_open_item_unq" ON "invoices" USING btree ("migration_open_item_id") WHERE migration_open_item_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bills_migration_open_item_unq" ON "bills" USING btree ("migration_open_item_id") WHERE migration_open_item_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_migration_advance_unq" ON "payments" USING btree ("migration_advance_id") WHERE migration_advance_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "journal_entries_source_idx" ON "journal_entries" USING btree ("company_id", "source") WHERE source IS NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_chk" CHECK (source IS NULL OR source IN ('opening', 'opening_clearing', 'opening_reversal'));--> statement-breakpoint
-- An opening item is amount-only: no VAT is ever posted for it (pack §14.1.8).
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_opening_no_vat_chk" CHECK (is_opening = false OR (vat_amount = 0 AND icv IS NULL AND invoice_hash IS NULL AND qr_code IS NULL));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_opening_no_vat_chk" CHECK (is_opening = false OR vat_amount = 0);--> statement-breakpoint

ALTER TABLE "migration_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "migration_chart_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "migration_parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "migration_open_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "migration_advances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['migration_batches', 'migration_chart_rows', 'migration_parties', 'migration_open_items', 'migration_advances'] LOOP
    EXECUTE format($p$
      CREATE POLICY "tenant_isolation" ON public.%I
        USING ( (organization_id)::text = current_setting('app.current_org_id', true)
                AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                      OR (company_id)::text = current_setting('app.current_company_id', true) ) )
        WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
                AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                      OR (company_id)::text = current_setting('app.current_company_id', true) ) )
    $p$, t);
  END LOOP;
END $$;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "migration_batches" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "migration_chart_rows" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "migration_parties" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "migration_open_items" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "migration_advances" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "migration_batches_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "migration_chart_rows_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "migration_parties_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "migration_open_items_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "migration_advances_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['migration_batches', 'migration_chart_rows', 'migration_parties', 'migration_open_items', 'migration_advances'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE DELETE ON TABLE public.migration_batches FROM authenticated';
  END IF;
END $$;--> statement-breakpoint

-- 5. Immutability of a committed migration.
CREATE OR REPLACE FUNCTION refuse_committed_migration_change() RETURNS trigger AS $$
DECLARE b_status text;
BEGIN
  IF TG_TABLE_NAME = 'migration_batches' THEN
    IF OLD.status IN ('committed', 'reversed') THEN
      -- The only movements a committed batch may make: committed → reversed
      -- (with its reversal journal), and gaining its clearing journal id.
      IF NEW.status NOT IN ('committed', 'reversed')
         OR NEW.source_system IS DISTINCT FROM OLD.source_system
         OR NEW.cutover_date IS DISTINCT FROM OLD.cutover_date
         OR NEW.opening_date IS DISTINCT FROM OLD.opening_date
         OR NEW.opening_journal_entry_id IS DISTINCT FROM OLD.opening_journal_entry_id
         OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
         OR NEW.committed_at IS DISTINCT FROM OLD.committed_at
         OR NEW.committed_by IS DISTINCT FROM OLD.committed_by
         OR (OLD.status = 'reversed' AND NEW.status <> 'reversed')
         OR (OLD.clearing_journal_entry_id IS NOT NULL AND NEW.clearing_journal_entry_id IS DISTINCT FROM OLD.clearing_journal_entry_id)
      THEN
        RAISE EXCEPTION 'migration batch % is % and cannot be modified', OLD.id, OLD.status USING ERRCODE = 'check_violation', CONSTRAINT = 'migration_batch_immutable';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO b_status FROM migration_batches WHERE id = COALESCE(NEW.batch_id, OLD.batch_id);
  IF b_status IN ('committed', 'reversed') THEN
    -- Resolved-id columns are written INSIDE the commit transaction, while the
    -- batch is still 'validated'; after commit nothing on a staging row moves.
    RAISE EXCEPTION 'migration batch % is % — staging rows are immutable', COALESCE(NEW.batch_id, OLD.batch_id), b_status USING ERRCODE = 'check_violation', CONSTRAINT = 'migration_rows_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER migration_batches_immutable BEFORE UPDATE ON migration_batches FOR EACH ROW EXECUTE FUNCTION refuse_committed_migration_change();--> statement-breakpoint
CREATE TRIGGER migration_chart_rows_immutable BEFORE INSERT OR UPDATE OR DELETE ON migration_chart_rows FOR EACH ROW EXECUTE FUNCTION refuse_committed_migration_change();--> statement-breakpoint
CREATE TRIGGER migration_parties_immutable BEFORE INSERT OR UPDATE OR DELETE ON migration_parties FOR EACH ROW EXECUTE FUNCTION refuse_committed_migration_change();--> statement-breakpoint
CREATE TRIGGER migration_open_items_immutable BEFORE INSERT OR UPDATE OR DELETE ON migration_open_items FOR EACH ROW EXECUTE FUNCTION refuse_committed_migration_change();--> statement-breakpoint
CREATE TRIGGER migration_advances_immutable BEFORE INSERT OR UPDATE OR DELETE ON migration_advances FOR EACH ROW EXECUTE FUNCTION refuse_committed_migration_change();
--> statement-breakpoint
-- 6. The permission matrix rows for the new `migration` resource (the matrix
--    is DATA — `seedPermissions()` is idempotent, but a deployment that runs
--    migrations without the seed must not 403 the admin on a working feature).
-- 6. Opening balance equity is written ONLY by an entry that carries a
-- migration source (the opening journal, the accountant's clearing journal,
-- the reversal). The seam refuses it to every ordinary caller; this trigger
-- refuses it beneath every writer, so a new posting path starts guarded.
-- A reversal mirror of a migration entry (reversal_of set) is allowed, as
-- the D-3 header trigger allows it.
CREATE OR REPLACE FUNCTION refuse_migration_only_account_line() RETURNS trigger AS $$
DECLARE
  sys_code text;
  acct_name text;
  entry_source text;
  is_reversal boolean;
BEGIN
  IF NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT system_code, name INTO sys_code, acct_name FROM categories WHERE id = NEW.account_id;
  IF sys_code IS DISTINCT FROM 'OPENING_BALANCE_EQUITY' THEN
    RETURN NEW;
  END IF;
  SELECT source, (reversal_of IS NOT NULL) INTO entry_source, is_reversal FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF entry_source IS NOT NULL OR coalesce(is_reversal, false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% (OPENING_BALANCE_EQUITY) is a migration-only account: only the migration''s opening journal and the accountant''s clearing journal write it.', acct_name
    USING ERRCODE = 'check_violation', CONSTRAINT = 'migration_only_account';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS refuse_migration_only_account_line_trg ON "journal_entry_lines";--> statement-breakpoint
CREATE TRIGGER refuse_migration_only_account_line_trg
  BEFORE INSERT OR UPDATE OF account_id, journal_entry_id ON "journal_entry_lines"
  FOR EACH ROW EXECUTE FUNCTION refuse_migration_only_account_line();--> statement-breakpoint

INSERT INTO "permissions" (role, resource, action) VALUES
  ('admin', 'migration', 'read'), ('accountant', 'migration', 'read'),
  ('admin', 'migration', 'create'), ('admin', 'migration', 'update'),
  ('admin', 'migration', 'approve'), ('admin', 'migration', 'delete')
ON CONFLICT DO NOTHING;
