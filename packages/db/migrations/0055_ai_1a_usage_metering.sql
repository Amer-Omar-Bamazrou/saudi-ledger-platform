-- ═══════════════════════════════════════════════════════════════════════════
-- AI-1a — per-tenant AI usage metering.
--
-- Owner decision (design-ai-layer): AI usage is metered per tenant and likely
-- billable. This table is the meter: one row per model call, recorded by the
-- provider wrapper beside the call it measures. On the free tier it measures
-- REAL token consumption per operation — the numbers that turn the spec's
-- "estimated cost" into a measured one.
--
-- Tenant-scoped and RLS'd like any business table: a tenant's usage is that
-- tenant's data. Append-only at the grants (the invoice_payments discipline):
-- a usage meter someone can quietly edit is not a meter.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "ai_usage" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
  "company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
  -- What the call was FOR — "categorize_second_opinion", "benchmark_categorizer",
  -- "benchmark_vision", later "cfo_answer" / "auditor_finding". Free text by
  -- design: operations are code-defined, and an enum here would need a
  -- migration for every new feature.
  "operation" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "prompt_tokens" integer NOT NULL DEFAULT 0,
  "completion_tokens" integer NOT NULL DEFAULT 0,
  "latency_ms" integer NOT NULL DEFAULT 0,
  -- 🔴 Failures are metered too. A provider outage that vanished from the
  -- meter would make the usage curve lie about what the feature attempted,
  -- and rate-limit failures are exactly what free-tier measurement is for.
  "ok" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "ai_usage_org_created_idx" ON "ai_usage" USING btree ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_operation_idx" ON "ai_usage" USING btree ("operation");--> statement-breakpoint

ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_tokens_check"
  CHECK ("prompt_tokens" >= 0 AND "completion_tokens" >= 0 AND "latency_ms" >= 0);--> statement-breakpoint

ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "ai_usage"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- Append-only: SELECT + INSERT, no UPDATE or DELETE.
GRANT SELECT, INSERT ON TABLE "ai_usage" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "ai_usage_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.ai_usage FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.ai_usage FROM authenticated';
  END IF;
END $$;--> statement-breakpoint
