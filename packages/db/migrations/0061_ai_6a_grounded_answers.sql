-- ═══════════════════════════════════════════════════════════════════════════
-- AI-6a — GROUNDED ANSWERS: the stored, auditable record of what the AI told
-- the tenant.
--
-- Owner decisions (2026-08-24): register A only (FACT + PROJECTION — no
-- opinion register exists; B is queued post-C10); answers are STORED —
-- "what did the AI tell the tenant" must be answerable, and the record must
-- exist BEFORE any unverifiable register ever does.
--
-- One row per exchange, refusals included (an honest refusal is an answer).
-- A REJECTED model output is recorded as a refusal WITHOUT the rejected
-- text — unverified model prose is never persisted, only the fact that it
-- was refused and why.
--
-- APPEND-ONLY for the app role (SELECT + INSERT): the record of what was
-- said is exactly the row someone would want to quietly amend.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "grounded_answers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"question" text NOT NULL,
	"tool" text,
	"tool_args" jsonb,
	"answer" jsonb,
	"refused" boolean DEFAULT false NOT NULL,
	"refusal_reason" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grounded_answers_answer_or_refusal" CHECK (refused OR answer IS NOT NULL)
);--> statement-breakpoint

ALTER TABLE "grounded_answers" ADD CONSTRAINT "grounded_answers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grounded_answers_org_created_idx" ON "grounded_answers" USING btree ("organization_id","created_at");--> statement-breakpoint

ALTER TABLE "grounded_answers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "grounded_answers"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE "grounded_answers" TO authenticated;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "grounded_answers_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.grounded_answers FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.grounded_answers FROM authenticated';
  END IF;
END $$;--> statement-breakpoint
