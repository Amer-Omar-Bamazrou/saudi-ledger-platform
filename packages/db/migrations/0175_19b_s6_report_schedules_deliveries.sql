-- 🔴 19B S6 (v4 §6.2, §9 D7) — REPORT SCHEDULES, THEIR RUNS, AND THE IN-APP DELIVERY STORE.
--  · report_schedules / report_schedule_recipients: a saved report on a cadence, run as its owner, for members.
--  · report_runs: one row per (schedule, period) — the unique key is the claim that makes one run per period true.
--  · report_deliveries: ONE STORED COPY PER RECIPIENT, its SHA-256 and its expiry. The request's role holds SELECT
--    only; the job writes and expires on the owner connection. At expiry the content is cleared, the tombstone kept.
-- New tables; no existing row is read or changed.
CREATE TABLE "report_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" integer NOT NULL,
	"definition_id" integer NOT NULL,
	"recipient_user_id" integer NOT NULL,
	"report_name" varchar(120) NOT NULL,
	"dataset" varchar(64) NOT NULL,
	"window_from" date,
	"window_to" date,
	"row_count" integer NOT NULL,
	"content" jsonb,
	"content_sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"expired_at" timestamp with time zone,
	CONSTRAINT "report_deliveries_run_recipient_unq" UNIQUE("run_id","recipient_user_id"),
	CONSTRAINT "report_deliveries_tombstone_chk" CHECK (("report_deliveries"."content" is null) = ("report_deliveries"."expired_at" is not null)),
	CONSTRAINT "report_deliveries_expiry_chk" CHECK ("report_deliveries"."expires_at" > "report_deliveries"."created_at")
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"schedule_id" integer NOT NULL,
	"period_key" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'claimed' NOT NULL,
	"outcome_code" varchar(64),
	"window_from" date,
	"window_to" date,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "report_runs_schedule_period_unq" UNIQUE("schedule_id","period_key"),
	CONSTRAINT "report_runs_id_org_unq" UNIQUE("id","organization_id"),
	CONSTRAINT "report_runs_status_chk" CHECK ("report_runs"."status" in ('claimed', 'delivered', 'refused', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "report_schedule_recipients" (
	"schedule_id" integer NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" integer NOT NULL,
	CONSTRAINT "report_schedule_recipients_pk" PRIMARY KEY("schedule_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"definition_id" integer NOT NULL,
	"owner_user_id" integer NOT NULL,
	"cadence" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "report_schedules_id_org_unq" UNIQUE("id","organization_id"),
	CONSTRAINT "report_schedules_cadence_chk" CHECK ("report_schedules"."cadence" in ('daily', 'weekly', 'monthly'))
);
--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_run_fk" FOREIGN KEY ("run_id","organization_id") REFERENCES "public"."report_runs"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_definition_fk" FOREIGN KEY ("definition_id","organization_id") REFERENCES "public"."report_definitions"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_recipient_member_fk" FOREIGN KEY ("recipient_user_id","organization_id") REFERENCES "public"."organization_memberships"("user_id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_schedule_fk" FOREIGN KEY ("schedule_id","organization_id") REFERENCES "public"."report_schedules"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule_recipients" ADD CONSTRAINT "report_schedule_recipients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule_recipients" ADD CONSTRAINT "report_schedule_recipients_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule_recipients" ADD CONSTRAINT "report_schedule_recipients_schedule_fk" FOREIGN KEY ("schedule_id","organization_id") REFERENCES "public"."report_schedules"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule_recipients" ADD CONSTRAINT "report_schedule_recipients_member_fk" FOREIGN KEY ("user_id","organization_id") REFERENCES "public"."organization_memberships"("user_id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_definition_fk" FOREIGN KEY ("definition_id","organization_id") REFERENCES "public"."report_definitions"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_owner_member_fk" FOREIGN KEY ("owner_user_id","organization_id") REFERENCES "public"."organization_memberships"("user_id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_deliveries_recipient_idx" ON "report_deliveries" USING btree ("company_id","recipient_user_id","created_at");--> statement-breakpoint
CREATE INDEX "report_deliveries_expiry_idx" ON "report_deliveries" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "report_schedules_company_idx" ON "report_schedules" USING btree ("company_id","owner_user_id");--> statement-breakpoint
-- ── Tenancy: the organization and the company, both arms (the 0154 pattern) ──
ALTER TABLE public.report_schedules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.report_schedules
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
ALTER TABLE public.report_schedule_recipients ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.report_schedule_recipients
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
ALTER TABLE public.report_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.report_runs
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
ALTER TABLE public.report_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.report_deliveries
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['report_schedules', 'report_schedule_recipients', 'report_runs', 'report_deliveries'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['report_schedules_id_seq', 'report_runs_id_seq', 'report_deliveries_id_seq'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- a schedule is created, read and ENDED by the request's role; never deleted
    GRANT SELECT, INSERT, UPDATE ON TABLE public.report_schedules TO authenticated;
    GRANT USAGE, SELECT ON SEQUENCE public.report_schedules_id_seq TO authenticated;
    -- recipients are set when the schedule is created
    GRANT SELECT, INSERT ON TABLE public.report_schedule_recipients TO authenticated;
    -- the job claims and finishes a run on the owner connection; the request's role only reads it
    GRANT SELECT ON TABLE public.report_runs TO authenticated;
    -- 🔴 D7: the request's role READS a copy, through the one endpoint that re-checks grants. No route inserts, changes or deletes one
    GRANT SELECT ON TABLE public.report_deliveries TO authenticated;
  END IF;
END $$;
