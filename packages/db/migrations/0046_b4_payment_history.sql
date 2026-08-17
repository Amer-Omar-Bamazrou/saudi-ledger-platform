-- ═══════════════════════════════════════════════════════════════════════════
-- B4 — PAYMENT HISTORY: one row per payment, with its own date.
--
-- The expiring fact the queue named: paid_amount is a running total and
-- paid_at only the LAST payment's date — a second partial payment destroyed
-- the first one's date permanently. These tables record each payment; the
-- pay paths write them from now on.
--
-- 🔴 The backfill at the bottom is honest about what is NOT recoverable: a
-- pre-B4 invoice's history collapses to ONE row flagged `backfilled = true`,
-- meaning "one or more payments totalling this amount, the LAST on this
-- date". The instalment split is gone and no later care recovers it.
-- Consumers that would be wrong on aggregates (DSO, instalment analytics)
-- MUST filter backfilled = false.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "invoice_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"invoice_id" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"paid_at" date NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "bill_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"bill_id" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"paid_at" date NOT NULL,
	"backfilled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_payments_invoice_idx" ON "invoice_payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_payments_org_idx" ON "invoice_payments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bill_payments_bill_idx" ON "bill_payments" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "bill_payments_org_idx" ON "bill_payments" USING btree ("organization_id");--> statement-breakpoint

ALTER TABLE "invoice_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bill_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "invoice_payments"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "bill_payments"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- 🔴 APPEND-ONLY for the app role (the recurring_runs / audit_logs
-- discipline): the record of when money actually arrived is exactly the row
-- someone would want to quietly amend. SELECT + INSERT, no UPDATE or DELETE.
GRANT SELECT, INSERT ON TABLE "invoice_payments" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "bill_payments" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice_payments', 'bill_payments'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.invoice_payments FROM authenticated';
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.bill_payments FROM authenticated';
  END IF;
END $$;--> statement-breakpoint

-- ── Backfill: what IS derivable from the running totals ────────────────────
INSERT INTO "invoice_payments" (organization_id, company_id, invoice_id, amount, paid_at, backfilled)
SELECT i.organization_id, i.company_id, i.id, i.paid_amount,
       COALESCE(NULLIF(i.paid_at, '')::date, i.date::date), true
  FROM invoices i
 WHERE COALESCE(i.paid_amount, 0) > 0;--> statement-breakpoint

INSERT INTO "bill_payments" (organization_id, company_id, bill_id, amount, paid_at, backfilled)
SELECT b.organization_id, b.company_id, b.id, b.paid_amount,
       COALESCE(NULLIF(b.paid_at, '')::date, b.date::date), true
  FROM bills b
 WHERE COALESCE(b.paid_amount, 0) > 0;--> statement-breakpoint
