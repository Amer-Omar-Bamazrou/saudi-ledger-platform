-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 H-9 — DR-19 / DR-21 (2026-10-27; register §11.56).
--  · company_control_settings: a company's CONTROL SETTINGS, a TYPED table —
--    each control a column with its own type and CHECK, one row per company,
--    written on the first change (no row = every slot empty).
--  · Its first slot, bank_change_payment_window_days (DR-23's finding: a
--    payment within N days of a supplier's bank-detail change), ships EMPTY:
--    NULL, with no default number. 1 to 365 when set.
--  · Settings change, so the request's role may SELECT, INSERT and UPDATE —
--    never DELETE; every change is audited by the service.
-- New table; no existing row is changed. The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'company_control_settings') THEN
    RAISE EXCEPTION 'pre-check REFUSED: company_control_settings already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: company_control_settings does not exist yet';
END $$;--> statement-breakpoint
CREATE TABLE "company_control_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"bank_change_payment_window_days" integer,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_control_settings_bank_window_chk" CHECK ("company_control_settings"."bank_change_payment_window_days" is null or "company_control_settings"."bank_change_payment_window_days" between 1 and 365)
);
--> statement-breakpoint
ALTER TABLE "company_control_settings" ADD CONSTRAINT "company_control_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_control_settings" ADD CONSTRAINT "company_control_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_control_settings_company_unq" ON "company_control_settings" USING btree ("company_id");--> statement-breakpoint
-- ── Tenancy and grants (the 0130 pattern) ───────────────────────────────────
ALTER TABLE public.company_control_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.company_control_settings
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
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.company_control_settings FROM %I', r);
      IF current_setting('server_version_num')::int >= 170000 THEN
        EXECUTE format('REVOKE MAINTAIN ON TABLE public.company_control_settings FROM %I', r);
      END IF;
      IF r <> 'authenticated' THEN
        EXECUTE format('REVOKE ALL ON TABLE public.company_control_settings FROM %I', r);
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- Settings change: read, written once, then updated — never deleted by the request's role.
    GRANT SELECT, INSERT, UPDATE ON TABLE public.company_control_settings TO authenticated;
    GRANT USAGE, SELECT ON SEQUENCE public.company_control_settings_id_seq TO authenticated;
    REVOKE DELETE ON TABLE public.company_control_settings FROM authenticated;
  END IF;
END $$;
