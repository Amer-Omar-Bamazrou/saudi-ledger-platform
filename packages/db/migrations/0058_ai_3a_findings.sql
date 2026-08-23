-- ═══════════════════════════════════════════════════════════════════════════
-- AI-3a — FINDINGS: the deterministic internal-consistency checks, as rows.
--
-- Commissioned by the owner's build-order answers (2026-08-24, Q1+Q3):
-- findings-first because this phase makes NO model call and asserts NO tax
-- position; scope is internal-consistency ONLY until C10 closes (Q2 = (a)).
--
-- Identity (organization_id, kind, ref_key) makes re-runs UPSERT, so status
-- survives: open → acknowledged (human; survives re-detection) → resolved
-- (machine-set when the condition vanishes; the row is KEPT as the record).
-- `delivered` records where each finding was sent (Q3: "otherwise 'we told
-- them' is unfalsifiable") — in_app now; AI-5's email/escalation writes the
-- same column.
--
-- No severity column, deliberately: the status palette is reserved for real
-- STATES (CLAUDE.md §4); a finding is a kind plus facts, rendered in words.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "findings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid,
	"kind" text NOT NULL,
	"ref_key" text NOT NULL,
	"facts" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" integer,
	"resolved_at" timestamp with time zone,
	"delivered" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "findings_org_kind_ref_key" UNIQUE("organization_id","kind","ref_key"),
	CONSTRAINT "findings_status_valid" CHECK (status IN ('open','acknowledged','resolved'))
);--> statement-breakpoint

ALTER TABLE "findings" ADD CONSTRAINT "findings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "findings_org_status_idx" ON "findings" USING btree ("organization_id","status");--> statement-breakpoint

ALTER TABLE "findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "findings"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- SELECT + INSERT + UPDATE (re-runs refresh rows; acknowledge/resolve are
-- status updates). NO DELETE: a resolved finding is the record that it was
-- found — the who-finds-out trail must not be quietly emptied.
GRANT SELECT, INSERT, UPDATE ON TABLE "findings" TO authenticated;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "findings_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.findings FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE DELETE ON TABLE public.findings FROM authenticated';
  END IF;
END $$;--> statement-breakpoint
