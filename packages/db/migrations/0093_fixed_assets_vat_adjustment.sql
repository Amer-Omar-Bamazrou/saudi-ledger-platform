CREATE TABLE "asset_vat_use_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"asset_id" integer NOT NULL,
	"period_index" integer NOT NULL,
	"actual_use_pct" numeric(5, 2) NOT NULL,
	"basis" text NOT NULL,
	"note" text,
	"declared_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_vat_use_records_asset_period_unq" UNIQUE("asset_id","period_index"),
	-- Art. 52(5): the periods are counted from the first, and there is no period 0.
	CONSTRAINT "asset_vat_use_records_period_chk" CHECK (period_index >= 1),
	-- A share of use is a share: outside 0–100 it is not a use percentage at all.
	CONSTRAINT "asset_vat_use_records_pct_chk" CHECK (actual_use_pct BETWEEN 0 AND 100),
	CONSTRAINT "asset_vat_use_records_basis_chk" CHECK (basis IN ('exclusive_use', 'approved_alternative_method', 'year_end_true_up', 'other'))
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "vat_tax_period" varchar(20);--> statement-breakpoint
ALTER TABLE "asset_vat_use_records" ADD CONSTRAINT "asset_vat_use_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_vat_use_records" ADD CONSTRAINT "asset_vat_use_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_vat_use_records" ADD CONSTRAINT "asset_vat_use_records_asset_id_fixed_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_vat_use_records" ADD CONSTRAINT "asset_vat_use_records_declared_by_users_id_fk" FOREIGN KEY ("declared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_vat_use_records_asset_idx" ON "asset_vat_use_records" USING btree ("asset_id","period_index");

-- Art. 58 sets two tax periods and no others; NULL stays NOT DECLARED.
ALTER TABLE "companies" ADD CONSTRAINT "companies_vat_tax_period_chk" CHECK (vat_tax_period IS NULL OR vat_tax_period IN ('monthly', 'quarterly'));--> statement-breakpoint

-- Tenancy exactly as every other business table (CLAUDE.md §4).
ALTER TABLE "asset_vat_use_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."asset_vat_use_records"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "asset_vat_use_records" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "asset_vat_use_records_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.asset_vat_use_records FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- A use record is a STATEMENT, correctable like the pool's declarations; what
-- must not be silent is when it last changed, because the adjustment moves with it.
CREATE OR REPLACE FUNCTION touch_asset_vat_use_record() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER asset_vat_use_records_touch
  BEFORE UPDATE ON public."asset_vat_use_records"
  FOR EACH ROW EXECUTE FUNCTION touch_asset_vat_use_record();
