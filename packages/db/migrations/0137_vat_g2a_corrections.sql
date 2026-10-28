-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 G2a — VAT corrections: owner decisions 9–12 (2026-10-27).
-- Register §11.39.
--  · vat_corrections: an error found in a FILED VAT return, append-only for the
--    request's role (SELECT, INSERT), like the filing it names by ZATCA
--    reference (T1e's convention: no tenant→tenant key). The net tax
--    difference is signed and never 0; the ACTUAL discovery date is required,
--    an earlier "arguably apparent" date is kept separately (decision 10).
-- A new table: no existing row is touched. The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'vat_return_filings') THEN
    RAISE EXCEPTION 'pre-check REFUSED: vat_return_filings (T1e, 0130) does not exist; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'vat_corrections') THEN
    RAISE EXCEPTION 'pre-check REFUSED: vat_corrections already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: the filed-return record exists; vat_corrections does not yet';
END $$;--> statement-breakpoint
CREATE TABLE "vat_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"corrects_zatca_reference" text NOT NULL,
	"description" text NOT NULL,
	"net_tax_difference" numeric(15, 2) NOT NULL,
	"discovered_on" date NOT NULL,
	"apparent_on" date,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vat_corrections_difference_chk" CHECK ("vat_corrections"."net_tax_difference" <> 0),
	CONSTRAINT "vat_corrections_description_chk" CHECK (length(btrim("vat_corrections"."description")) > 0),
	CONSTRAINT "vat_corrections_apparent_chk" CHECK ("vat_corrections"."apparent_on" is null or "vat_corrections"."apparent_on" <= "vat_corrections"."discovered_on")
);
--> statement-breakpoint
ALTER TABLE "vat_corrections" ADD CONSTRAINT "vat_corrections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_corrections" ADD CONSTRAINT "vat_corrections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vat_corrections_company_reference_idx" ON "vat_corrections" USING btree ("company_id","corrects_zatca_reference");--> statement-breakpoint
-- ── Tenancy and grants (the 0130 pattern) ───────────────────────────────────
ALTER TABLE public.vat_corrections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.vat_corrections
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.vat_corrections FROM %I', r);
      IF current_setting('server_version_num')::int >= 170000 THEN
        EXECUTE format('REVOKE MAINTAIN ON TABLE public.vat_corrections FROM %I', r);
      END IF;
      IF r <> 'authenticated' THEN
        EXECUTE format('REVOKE ALL ON TABLE public.vat_corrections FROM %I', r);
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- 🔴 APPEND-ONLY for the request's role: an error found is recorded and read, never changed or deleted.
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.vat_corrections TO authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.vat_corrections_id_seq TO authenticated';
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.vat_corrections FROM authenticated';
  END IF;
END $$;
