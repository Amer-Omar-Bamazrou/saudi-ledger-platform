CREATE TABLE "recurring_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"entity" text NOT NULL,
	"template" jsonb NOT NULL,
	"frequency" text NOT NULL,
	"day_of_month" integer NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"next_run_on" date NOT NULL,
	"auto_issue" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"scheduled_for" date NOT NULL,
	"outcome" text NOT NULL,
	"document_id" integer,
	"error_code" text,
	"error_detail" text,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_runs" ADD CONSTRAINT "recurring_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_runs" ADD CONSTRAINT "recurring_runs_rule_id_recurring_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."recurring_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_rules_due_idx" ON "recurring_rules" USING btree ("status","next_run_on");--> statement-breakpoint
CREATE INDEX "recurring_rules_org_idx" ON "recurring_rules" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_runs_rule_occurrence_unq" ON "recurring_runs" USING btree ("rule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "recurring_runs_rule_idx" ON "recurring_runs" USING btree ("rule_id","ran_at");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- A3 — recurring rules and their run history: tenant-scoped business data
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "recurring_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "recurring_rules"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "recurring_runs"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "recurring_rules" TO authenticated;--> statement-breakpoint

-- 🔴 Run history is APPEND-ONLY for the app role: SELECT + INSERT, no UPDATE or
-- DELETE. It is the record of whether a customer was billed, so a tenant must
-- not be able to quietly erase a failed run — the same discipline as
-- `audit_logs` (M6) and `einvoice_archive` (M12.8). A run that failed because a
-- period was locked is exactly the row someone would want to make disappear.
GRANT SELECT, INSERT ON TABLE "recurring_runs" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recurring_rules', 'recurring_runs'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.recurring_runs FROM authenticated';
  END IF;
END $$;
