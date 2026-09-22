CREATE TABLE "asset_tax_pool_declarations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"income_tax_group" smallint NOT NULL,
	"tax_year" integer NOT NULL,
	"closing_balance_declared" numeric(15, 2),
	"additions_declared" numeric(15, 2),
	"disposals_declared" numeric(15, 2),
	"repairs_declared" numeric(15, 2),
	"elect_small_balance_write_off" boolean DEFAULT false NOT NULL,
	"elect_group_closed_write_off" boolean DEFAULT false NOT NULL,
	"note" text,
	"declared_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_tax_pool_declarations_company_group_year_unq" UNIQUE("company_id","income_tax_group","tax_year"),
	-- Art. 17(b) names exactly five groups; a sixth is not a group the Law has.
	CONSTRAINT "asset_tax_pool_declarations_group_chk" CHECK (income_tax_group BETWEEN 1 AND 5),
	-- Art. 17(e) never lets a balance go negative, and neither a declared balance
	-- nor a declared figure of additions, disposals or repairs can be.
	CONSTRAINT "asset_tax_pool_declarations_money_chk" CHECK (
		(closing_balance_declared IS NULL OR closing_balance_declared >= 0)
		AND (additions_declared IS NULL OR additions_declared >= 0)
		AND (disposals_declared IS NULL OR disposals_declared >= 0)
		AND (repairs_declared IS NULL OR repairs_declared >= 0)),
	-- An ANCHOR is a complete statement of the year it closes: the balance AND
	-- the two figures Art. 17(e) reaches back for. A balance without them would
	-- silently contribute nothing to the next year's halves, which reads as a
	-- year with no additions rather than as a half-declared anchor.
	CONSTRAINT "asset_tax_pool_declarations_anchor_complete_chk" CHECK (
		closing_balance_declared IS NULL
		OR (additions_declared IS NOT NULL AND disposals_declared IS NOT NULL)),
	-- A row that states nothing is not a declaration.
	CONSTRAINT "asset_tax_pool_declarations_not_empty_chk" CHECK (
		closing_balance_declared IS NOT NULL OR repairs_declared IS NOT NULL
		OR elect_small_balance_write_off OR elect_group_closed_write_off)
);
--> statement-breakpoint
ALTER TABLE "asset_tax_pool_declarations" ADD CONSTRAINT "asset_tax_pool_declarations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tax_pool_declarations" ADD CONSTRAINT "asset_tax_pool_declarations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tax_pool_declarations" ADD CONSTRAINT "asset_tax_pool_declarations_declared_by_users_id_fk" FOREIGN KEY ("declared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_tax_pool_declarations_org_idx" ON "asset_tax_pool_declarations" USING btree ("organization_id","company_id");

-- Tenancy exactly as every other business table (CLAUDE.md §4): RLS
-- tenant_isolation with the N1 company arm, the narrowed grants, and the
-- explicit REVOKE of TRUNCATE/REFERENCES/TRIGGER — Supabase's base
-- ALTER DEFAULT PRIVILEGES re-grants them on every CREATE TABLE, and TRUNCATE
-- bypasses RLS (M14).
ALTER TABLE "asset_tax_pool_declarations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."asset_tax_pool_declarations"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "asset_tax_pool_declarations" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "asset_tax_pool_declarations_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.asset_tax_pool_declarations FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- A declaration is CORRECTABLE — unlike a posted row, it states what the
-- taxpayer filed, and a taxpayer who mis-keys last year's balance must be able
-- to say so. What must not be silent is WHEN it last changed, because every
-- later year of the chain moves with it.
CREATE OR REPLACE FUNCTION touch_asset_tax_pool_declaration() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER asset_tax_pool_declarations_touch
  BEFORE UPDATE ON public."asset_tax_pool_declarations"
  FOR EACH ROW EXECUTE FUNCTION touch_asset_tax_pool_declaration();
