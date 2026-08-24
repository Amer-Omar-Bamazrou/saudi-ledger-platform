-- ═══════════════════════════════════════════════════════════════════════════
-- AI-5 — SCHEDULED FINDINGS: the delivery record and the cadence.
--
-- Owner decisions (2026-08-24): escalation is on the WHOLE RUN, not per
-- finding (one condition, one owner); recipients are ACTIVE ADMINS only;
-- escalate IN PLACE, never auto-acknowledge — email escalating into more
-- email is a longer parking space, so the escalation is a persistent
-- Dashboard marker, and exactly ONE email is ever sent per run.
--
-- 🔴 The honest limit, recorded rather than implied: with no external
-- escalation target, the chain ends where the tenant's attention ends. The
-- product makes ignoring harder (the marker) and records that it was never
-- opened (viewed_at stays NULL) — it cannot make someone read.
--
-- finding_runs: one row per run. For SCHEDULED runs, (org, period_key) is
-- UNIQUE and the row is the CLAIM (the recurring-job discipline: claim
-- before work; a concurrent instance's insert conflicts and stops).
-- viewed_at/viewed_by make "we told them and they saw it" a queryable fact.
-- On-demand runs get rows too (period_key NULL — Postgres uniques treat
-- NULLs as distinct, so they never conflict).
--
-- finding_schedules: one optional row per org. ABSENT = quarterly (the
-- default needs no row); a row exists only to opt into monthly (or to state
-- quarterly explicitly). NO DELETE either table: runs are the who-was-told
-- record, and a schedule change should supersede, not erase.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "finding_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"period_key" text,
	"trigger" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"reopened" integer DEFAULT 0 NOT NULL,
	"refreshed" integer DEFAULT 0 NOT NULL,
	"resolved" integer DEFAULT 0 NOT NULL,
	"open_after" integer DEFAULT 0 NOT NULL,
	"emailed_at" timestamp with time zone,
	"emailed_count" integer,
	"viewed_at" timestamp with time zone,
	"viewed_by" integer,
	CONSTRAINT "finding_runs_org_period_key" UNIQUE("organization_id","period_key"),
	CONSTRAINT "finding_runs_trigger_valid" CHECK (trigger IN ('scheduled','on_demand'))
);--> statement-breakpoint

CREATE TABLE "finding_schedules" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"cadence" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "finding_schedules_cadence_valid" CHECK (cadence IN ('quarterly','monthly'))
);--> statement-breakpoint

ALTER TABLE "finding_runs" ADD CONSTRAINT "finding_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_schedules" ADD CONSTRAINT "finding_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_runs_org_ran_idx" ON "finding_runs" USING btree ("organization_id","ran_at");--> statement-breakpoint

ALTER TABLE "finding_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finding_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "finding_runs"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "finding_schedules"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE "finding_runs" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "finding_schedules" TO authenticated;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "finding_runs_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finding_runs', 'finding_schedules'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE DELETE ON TABLE public.%I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
