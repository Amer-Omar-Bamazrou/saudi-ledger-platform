CREATE TABLE "migration_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"batch_id" integer NOT NULL,
	"source_system" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"serial_number" text,
	"category_name" text NOT NULL,
	"acquisition_date" date NOT NULL,
	"available_for_use_date" date NOT NULL,
	"cost" numeric(15, 2) NOT NULL,
	"residual_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"useful_life_months" integer NOT NULL,
	"depreciation_method" text DEFAULT 'straight_line' NOT NULL,
	"opening_accumulated_depreciation" numeric(15, 2) NOT NULL,
	"opening_periods_booked" integer NOT NULL,
	"vat_input_tax_amount" numeric(15, 2),
	"vat_initial_recovery_pct" numeric(5, 2),
	"vat_non_deductible_reason" text,
	"location" text,
	"description" text,
	"resolved_asset_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_assets_money_chk" CHECK (cost >= 0 AND residual_value >= 0 AND residual_value <= cost AND opening_accumulated_depreciation >= 0 AND opening_accumulated_depreciation <= cost - residual_value),
	CONSTRAINT "migration_assets_life_chk" CHECK (useful_life_months > 0 AND opening_periods_booked >= 0 AND opening_periods_booked <= useful_life_months),
	CONSTRAINT "migration_assets_method_chk" CHECK (depreciation_method IN ('straight_line', 'declining_balance', 'units_of_production')),
	CONSTRAINT "migration_assets_dates_chk" CHECK (available_for_use_date >= acquisition_date),
	CONSTRAINT "migration_assets_vat_chk" CHECK ((vat_input_tax_amount IS NULL OR vat_input_tax_amount >= 0) AND (vat_initial_recovery_pct IS NULL OR vat_initial_recovery_pct BETWEEN 0 AND 100))
);
--> statement-breakpoint
ALTER TABLE "migration_assets" ADD CONSTRAINT "migration_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_assets" ADD CONSTRAINT "migration_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_assets" ADD CONSTRAINT "migration_assets_batch_id_migration_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_assets_identity_unq" ON "migration_assets" USING btree ("batch_id","source_id");--> statement-breakpoint
CREATE INDEX "migration_assets_batch_idx" ON "migration_assets" USING btree ("batch_id");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- FIXED ASSETS — FA-D: MIGRATED ASSETS (2026-09-22). Record:
-- docs/product/fixed-assets-decision-pack.md §10, §23.
--
-- Staging for the assets the previous system held at cut-off. It creates NO
-- journal line: the cost and the accumulated depreciation are already in the
-- staged trial balance (A5 — ONE balanced opening position, never a plug), so
-- the register RECONCILES to those mapped balances (a control, exactly as
-- open items reconcile to AR/AP). The register rows are created at commit,
-- carry the opening journal as their capitalisation entry, and their schedule
-- resumes the month AFTER the opening date.
--
-- Tenant isolation, grants and the owner-only REVOKE follow Batch 1C's own
-- pattern for staging tables (edited while a batch is a draft; frozen once it
-- is committed by `refuse_committed_migration_change`).
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "migration_assets" ADD CONSTRAINT "migration_assets_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_assets" ADD CONSTRAINT "migration_assets_resolved_asset_id_fk" FOREIGN KEY ("resolved_asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_assets_migration_asset_unq" ON "fixed_assets" USING btree ("migration_batch_id", "source_reference") WHERE migration_batch_id IS NOT NULL AND source_reference IS NOT NULL;--> statement-breakpoint

ALTER TABLE "migration_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."migration_assets"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "migration_assets" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "migration_assets_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.migration_assets FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- A committed migration's staging rows are immutable — the same trigger every
-- other staging table carries (Batch 1C, migration 0077).
CREATE TRIGGER migration_assets_immutable BEFORE INSERT OR UPDATE OR DELETE ON "migration_assets" FOR EACH ROW EXECUTE FUNCTION refuse_committed_migration_change();
