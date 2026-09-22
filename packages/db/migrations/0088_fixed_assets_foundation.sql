CREATE TABLE "asset_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"cost_account_id" integer NOT NULL,
	"accumulated_depreciation_account_id" integer NOT NULL,
	"depreciation_expense_account_id" integer NOT NULL,
	"default_useful_life_months" integer NOT NULL,
	"default_method" text DEFAULT 'straight_line' NOT NULL,
	"default_residual_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"income_tax_group" smallint NOT NULL,
	"vat_capital_asset_class" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_categories_company_name_unq" UNIQUE("company_id","name")
);
--> statement-breakpoint
CREATE TABLE "asset_depreciation_schedule" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"asset_id" integer NOT NULL,
	"period" text NOT NULL,
	"sequence" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"accumulated_after" numeric(15, 2) NOT NULL,
	"carrying_after" numeric(15, 2) NOT NULL,
	"journal_entry_id" integer,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_depreciation_schedule_asset_period_unq" UNIQUE("asset_id","period")
);
--> statement-breakpoint
CREATE TABLE "asset_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"asset_id" integer NOT NULL,
	"kind" text NOT NULL,
	"occurred_on" date NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"journal_entry_id" integer,
	"document_ref" text,
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"asset_number" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"description" text,
	"serial_number" text,
	"category_id" integer NOT NULL,
	"location" text,
	"department" text,
	"custodian_user_id" integer,
	"acquisition_date" date NOT NULL,
	"available_for_use_date" date,
	"disposal_date" date,
	"cost" numeric(15, 2) NOT NULL,
	"residual_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"useful_life_months" integer NOT NULL,
	"depreciation_method" text DEFAULT 'straight_line' NOT NULL,
	"opening_accumulated_depreciation" numeric(15, 2) DEFAULT '0' NOT NULL,
	"opening_periods_booked" integer DEFAULT 0 NOT NULL,
	"vat_input_tax_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"vat_initial_recovery_pct" numeric(5, 2) DEFAULT '100' NOT NULL,
	"vat_capital_asset_class" text NOT NULL,
	"vat_non_deductible_reason" text,
	"income_tax_group" smallint NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"bill_id" integer,
	"transaction_id" integer,
	"migration_batch_id" integer,
	"source_reference" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"capitalisation_journal_entry_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_assets_company_number_unq" UNIQUE("company_id","asset_number")
);
--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_cost_account_id_categories_id_fk" FOREIGN KEY ("cost_account_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_accumulated_depreciation_account_id_categories_id_fk" FOREIGN KEY ("accumulated_depreciation_account_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_depreciation_expense_account_id_categories_id_fk" FOREIGN KEY ("depreciation_expense_account_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation_schedule" ADD CONSTRAINT "asset_depreciation_schedule_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation_schedule" ADD CONSTRAINT "asset_depreciation_schedule_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation_schedule" ADD CONSTRAINT "asset_depreciation_schedule_asset_id_fixed_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation_schedule" ADD CONSTRAINT "asset_depreciation_schedule_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_asset_id_fixed_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_category_id_asset_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."asset_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_custodian_user_id_users_id_fk" FOREIGN KEY ("custodian_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_capitalisation_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("capitalisation_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_categories_org_idx" ON "asset_categories" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "asset_depreciation_schedule_asset_idx" ON "asset_depreciation_schedule" USING btree ("asset_id","sequence");--> statement-breakpoint
CREATE INDEX "asset_events_asset_idx" ON "asset_events" USING btree ("asset_id","id");--> statement-breakpoint
CREATE INDEX "fixed_assets_org_idx" ON "fixed_assets" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "fixed_assets_category_idx" ON "fixed_assets" USING btree ("category_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- FIXED ASSETS — FA-A foundation (2026-09-22). Decision record:
-- docs/product/fixed-assets-decision-pack.md §3, §6, §8, §13, §17.
-- 1. Three system accounts (the category's default triple's contra-asset and
--    expense, and the IAS 16.68 disposal gain/loss — never SALES).
-- 2. The register's CHECKs: the Saudi enumerations, the money relations, the
--    state's preconditions.
-- 3. Tenant isolation + grants + the owner-only REVOKE pattern.
-- 4. IMMUTABILITY: a POSTED schedule row is frozen (the invoice-prepayments
--    pattern, 0083); asset_events is append-only; a capitalised asset's
--    facts of record (cost, dates, group, class, source) cannot change — a
--    correction is a new act (estimate change, reversal), never an edit.
-- 5. The company's income-tax share, pinned to its ownership type.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. System accounts ──────────────────────────────────────────────────────
INSERT INTO "system_account_templates" (code, name, name_ar, type, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, sort_order)
VALUES
  ('ACCUMULATED_DEPRECIATION', 'Accumulated depreciation',                    'مجمع الإهلاك',                              'asset',   true, false, 'O', false, 'non_current', 425),
  ('ASSET_DISPOSAL_GAIN_LOSS', 'Gain (loss) on disposal of fixed assets',     'أرباح (خسائر) استبعاد الأصول الثابتة',      'income',  true, false, 'O', false, NULL,          86),
  ('DEPRECIATION_EXPENSE',     'Depreciation expense',                        'مصروف الإهلاك',                             'expense', true, false, 'O', false, NULL,          94)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- Existing organizations get the accounts too (the org-seed trigger fires only for NEW orgs — the M13 lesson).
INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, is_posting)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class, true
  FROM organizations o
  CROSS JOIN system_account_templates t
 WHERE t.code IN ('ACCUMULATED_DEPRECIATION', 'ASSET_DISPOSAL_GAIN_LOSS', 'DEPRECIATION_EXPENSE')
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

-- ── 2. The register CHECKs ──────────────────────────────────────────────────
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_life_chk" CHECK (default_useful_life_months > 0);--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_method_chk" CHECK (default_method IN ('straight_line', 'declining_balance', 'units_of_production'));--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_residual_pct_chk" CHECK (default_residual_pct >= 0 AND default_residual_pct < 100);--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_income_tax_group_chk" CHECK (income_tax_group BETWEEN 1 AND 5);--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_vat_class_chk" CHECK (vat_capital_asset_class IN ('movable', 'immovable', 'not_capital'));--> statement-breakpoint

ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_money_chk" CHECK (cost >= 0 AND residual_value >= 0 AND residual_value <= cost AND opening_accumulated_depreciation >= 0 AND opening_accumulated_depreciation <= cost - residual_value);--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_life_chk" CHECK (useful_life_months > 0 AND opening_periods_booked >= 0 AND opening_periods_booked <= useful_life_months);--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_method_chk" CHECK (depreciation_method IN ('straight_line', 'declining_balance', 'units_of_production'));--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_status_chk" CHECK (status IN ('draft', 'in_service', 'disposed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_source_chk" CHECK (source IN ('manual', 'bill', 'transaction', 'migration'));--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_vat_chk" CHECK (vat_input_tax_amount >= 0 AND vat_initial_recovery_pct BETWEEN 0 AND 100 AND vat_capital_asset_class IN ('movable', 'immovable', 'not_capital'));--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_income_tax_group_chk" CHECK (income_tax_group BETWEEN 1 AND 5);--> statement-breakpoint
-- an opening position belongs to a migrated asset only; every other schedule starts at zero
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_opening_chk" CHECK (source = 'migration' OR (opening_accumulated_depreciation = 0 AND opening_periods_booked = 0));--> statement-breakpoint
-- in service: an available-for-use date and a capitalisation entry (a migrated asset carries the opening journal); disposed: a disposal date, and it was in service
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_state_chk" CHECK (
  (status IN ('draft', 'cancelled') AND capitalisation_journal_entry_id IS NULL AND disposal_date IS NULL)
  OR (status = 'in_service' AND available_for_use_date IS NOT NULL AND capitalisation_journal_entry_id IS NOT NULL AND disposal_date IS NULL)
  OR (status = 'disposed' AND available_for_use_date IS NOT NULL AND capitalisation_journal_entry_id IS NOT NULL AND disposal_date IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_dates_chk" CHECK (available_for_use_date IS NULL OR available_for_use_date >= acquisition_date);--> statement-breakpoint

ALTER TABLE "asset_depreciation_schedule" ADD CONSTRAINT "asset_depreciation_schedule_period_chk" CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');--> statement-breakpoint
ALTER TABLE "asset_depreciation_schedule" ADD CONSTRAINT "asset_depreciation_schedule_money_chk" CHECK (amount >= 0 AND accumulated_after >= 0 AND carrying_after >= 0 AND sequence > 0);--> statement-breakpoint
ALTER TABLE "asset_depreciation_schedule" ADD CONSTRAINT "asset_depreciation_schedule_posted_chk" CHECK ((journal_entry_id IS NULL) = (posted_at IS NULL));--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_kind_chk" CHECK (kind IN ('created', 'updated', 'capitalised', 'addition', 'depreciated', 'estimate_changed', 'transferred', 'disposed', 'reversed', 'vat_use_recorded', 'vat_adjusted', 'cancelled'));--> statement-breakpoint

-- ── 3. Tenant isolation, grants, the owner-only REVOKE pattern ──────────────
ALTER TABLE "asset_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fixed_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asset_depreciation_schedule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asset_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['asset_categories', 'fixed_assets', 'asset_depreciation_schedule', 'asset_events'] LOOP
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
GRANT SELECT, INSERT, UPDATE ON TABLE "asset_categories" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "fixed_assets" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "asset_depreciation_schedule" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "asset_events" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "asset_categories_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "fixed_assets_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "asset_depreciation_schedule_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "asset_events_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['asset_categories', 'fixed_assets', 'asset_depreciation_schedule', 'asset_events'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  -- an asset row and a category are never hard-deleted (VAT IR Art. 66 retention; a draft is CANCELLED by status); an event is never changed
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE DELETE ON TABLE public.fixed_assets FROM authenticated';
    EXECUTE 'REVOKE DELETE ON TABLE public.asset_categories FROM authenticated';
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.asset_events FROM authenticated';
  END IF;
END $$;--> statement-breakpoint

-- ── 4. Immutability ─────────────────────────────────────────────────────────
-- 4a. A POSTED schedule row is frozen: the one act allowed on a planned row is
--     posting it (journal_entry_id NULL -> set, posted_at NULL -> set, once);
--     a planned row may be re-planned or removed (an estimate change
--     regenerates the unposted tail); a posted row can neither change nor go.
--     The app role needs DELETE for planned rows, so the DELETE arm is the
--     trigger's: refused for every role but the table OWNER, whose only
--     legitimate delete is purging an organisation whole.
CREATE OR REPLACE FUNCTION refuse_posted_depreciation_change() RETURNS trigger AS $$
DECLARE old_j jsonb; new_j jsonb; owner_name text;
BEGIN
  IF OLD.journal_entry_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT tableowner INTO owner_name FROM pg_tables WHERE schemaname = 'public' AND tablename = 'asset_depreciation_schedule';
    IF current_user = owner_name THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'depreciation of asset % for % is posted (entry %) and frozen: correct it by reversing the entry, never by removing the row', OLD.asset_id, OLD.period, OLD.journal_entry_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'depreciation_posted_frozen';
  END IF;
  old_j := to_jsonb(OLD); new_j := to_jsonb(NEW);
  IF old_j <> new_j THEN
    RAISE EXCEPTION 'depreciation of asset % for % is posted (entry %) and frozen: a correction is a reversal and a new row, never an edit', OLD.asset_id, OLD.period, OLD.journal_entry_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'depreciation_posted_frozen';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER asset_depreciation_schedule_frozen_trg BEFORE UPDATE OR DELETE ON "asset_depreciation_schedule" FOR EACH ROW EXECUTE FUNCTION refuse_posted_depreciation_change();--> statement-breakpoint

-- 4b. asset_events is append-only. The app role holds neither UPDATE nor
--     DELETE (the REVOKE above); the trigger binds the OWNER role too against
--     an UPDATE (an event, once written, is never rewritten). A DELETE by the
--     owner is left to it — the only legitimate one is purging an organisation
--     whole (tests, offboarding), and a purge that must first drop a trigger
--     is a purge nobody runs.
CREATE OR REPLACE FUNCTION refuse_asset_event_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'asset_events is append-only (event % of asset %)', OLD.id, OLD.asset_id USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_events_append_only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER asset_events_append_only_trg BEFORE UPDATE ON "asset_events" FOR EACH ROW EXECUTE FUNCTION refuse_asset_event_change();--> statement-breakpoint

-- 4c. A capitalised asset's facts of record are frozen. Once in service the
--     cost, the dates, the provenance, the Art. 17 group, the VAT class and
--     input-tax facts, the category, the number and the capitalisation entry
--     cannot change; what MAY change is the descriptive (name, location,
--     custodian, notes), the estimate (residual, life, method — through the
--     audited estimate-change act, which regenerates the unposted schedule),
--     and the transition to disposed with its date. A cancelled draft and a
--     disposed asset are frozen whole.
CREATE OR REPLACE FUNCTION refuse_capitalised_asset_fact_change() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'cancelled' OR OLD.status = 'disposed' THEN
    IF (to_jsonb(OLD) - 'updated_at') <> (to_jsonb(NEW) - 'updated_at') THEN
      RAISE EXCEPTION 'asset % is % and frozen', OLD.id, OLD.status USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'in_service' THEN
    IF NEW.cost <> OLD.cost OR NEW.acquisition_date <> OLD.acquisition_date OR NEW.available_for_use_date IS DISTINCT FROM OLD.available_for_use_date
       OR NEW.source <> OLD.source OR NEW.bill_id IS DISTINCT FROM OLD.bill_id OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
       OR NEW.migration_batch_id IS DISTINCT FROM OLD.migration_batch_id
       OR NEW.income_tax_group <> OLD.income_tax_group OR NEW.vat_capital_asset_class <> OLD.vat_capital_asset_class
       OR NEW.vat_input_tax_amount <> OLD.vat_input_tax_amount OR NEW.vat_initial_recovery_pct <> OLD.vat_initial_recovery_pct
       OR NEW.opening_accumulated_depreciation <> OLD.opening_accumulated_depreciation OR NEW.opening_periods_booked <> OLD.opening_periods_booked
       OR NEW.capitalisation_journal_entry_id IS DISTINCT FROM OLD.capitalisation_journal_entry_id
       OR NEW.category_id <> OLD.category_id OR NEW.asset_number <> OLD.asset_number
       OR NEW.status NOT IN ('in_service', 'disposed') THEN
      RAISE EXCEPTION 'asset % is in service: its cost, dates, provenance, tax group, VAT facts, category, number and entry are facts of record (a correction is a new act, never an edit)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_capitalised_facts_frozen';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER fixed_assets_facts_frozen_trg BEFORE UPDATE ON "fixed_assets" FOR EACH ROW EXECUTE FUNCTION refuse_capitalised_asset_fact_change();--> statement-breakpoint

-- ── 5. The company income-tax share, pinned to its ownership type ───────────
ALTER TABLE "companies" ADD CONSTRAINT "companies_foreign_ownership_pct_chk" CHECK (
  foreign_ownership_pct IS NULL
  OR (ownership_type = 'SAUDI_GCC' AND foreign_ownership_pct = 0)
  OR (ownership_type = 'FOREIGN' AND foreign_ownership_pct = 100)
  OR (ownership_type = 'MIXED' AND foreign_ownership_pct > 0 AND foreign_ownership_pct < 100)
);
