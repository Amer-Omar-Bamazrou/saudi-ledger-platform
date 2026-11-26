-- 🔴 19B S6 (v4 §4, §6.2) — SAVED REPORT DEFINITIONS: a dataset, its columns in order, a period, the dataset's declared
--    filters and sort. Owned by a MEMBER (the key carries the organization, G04), company-scoped (N1), shared with
--    roles of the same organization. Archived, never deleted. A new table; no existing row is read or changed.
CREATE TABLE "report_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_user_id" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"dataset" varchar(64) NOT NULL,
	"columns" text[] DEFAULT '{}'::text[] NOT NULL,
	"period_kind" varchar(32) NOT NULL,
	"date_from" date,
	"date_to" date,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort" varchar(64),
	"shared_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "report_definitions_id_org_unq" UNIQUE("id","organization_id"),
	CONSTRAINT "report_definitions_period_chk" CHECK ("report_definitions"."period_kind" in ('fixed', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year')),
	CONSTRAINT "report_definitions_fixed_window_chk" CHECK (("report_definitions"."period_kind" = 'fixed') = ("report_definitions"."date_from" is not null and "report_definitions"."date_to" is not null) and ("report_definitions"."date_from" is null) = ("report_definitions"."date_to" is null) and ("report_definitions"."date_from" is null or "report_definitions"."date_from" <= "report_definitions"."date_to")),
	CONSTRAINT "report_definitions_shared_roles_chk" CHECK ("report_definitions"."shared_roles" <@ array['admin', 'accountant', 'bookkeeper', 'viewer']::text[])
);
--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_owner_member_fk" FOREIGN KEY ("owner_user_id","organization_id") REFERENCES "public"."organization_memberships"("user_id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_definitions_company_idx" ON "report_definitions" USING btree ("company_id","owner_user_id");--> statement-breakpoint
-- ── Tenancy and grants (the 0154 pattern): the organization and the company, both arms ──
ALTER TABLE public.report_definitions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.report_definitions
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
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.report_definitions FROM %I', r);
      IF current_setting('server_version_num')::int >= 170000 THEN
        EXECUTE format('REVOKE MAINTAIN ON TABLE public.report_definitions FROM %I', r);
      END IF;
      IF r <> 'authenticated' THEN
        EXECUTE format('REVOKE ALL ON TABLE public.report_definitions FROM %I', r);
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- 🔴 ARCHIVED, NEVER DELETED: the request's role reads, saves and changes a definition; it cannot remove one.
    GRANT SELECT, INSERT, UPDATE ON TABLE public.report_definitions TO authenticated;
    GRANT USAGE, SELECT ON SEQUENCE public.report_definitions_id_seq TO authenticated;
    REVOKE DELETE ON TABLE public.report_definitions FROM authenticated;
  END IF;
END $$;
