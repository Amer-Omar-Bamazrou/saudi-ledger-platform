CREATE TABLE "payment_classifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"payment_id" integer NOT NULL,
	"classification" text NOT NULL,
	"vat_category" text,
	"note" text,
	"idempotency_key" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_classifications_kind_chk" CHECK (classification IN ('advance', 'erroneous', 'security_deposit', 'unknown')),
	CONSTRAINT "payment_classifications_vat_category_chk" CHECK (vat_category IS NULL OR vat_category IN ('S', 'Z', 'E')),
	CONSTRAINT "payment_classifications_vat_category_advance_chk" CHECK (vat_category IS NULL OR classification = 'advance')
);
--> statement-breakpoint
ALTER TABLE "payment_classifications" ADD CONSTRAINT "payment_classifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_classifications" ADD CONSTRAINT "payment_classifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_classifications" ADD CONSTRAINT "payment_classifications_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_classifications_payment_idx" ON "payment_classifications" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_classifications_idempotency_unq" ON "payment_classifications" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;-- ═══════════════════════════════════════════════════════════════════════════
-- AP-1 (2026-09-20) — hand-written tail. Above (generated): the
-- payment_classifications table — a dated, attributed statement of what a
-- deposit IS (advance / erroneous / security_deposit / unknown), one NEW row
-- per change, the latest current. Informational: nothing posts from it.
-- Below: tenant isolation (org + N1 company arm) and append-only grants —
-- the 0075 pattern. No data is written by this migration.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "payment_classifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "payment_classifications"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE "payment_classifications" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "payment_classifications_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.payment_classifications FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.payment_classifications FROM authenticated';
  END IF;
END $$;
