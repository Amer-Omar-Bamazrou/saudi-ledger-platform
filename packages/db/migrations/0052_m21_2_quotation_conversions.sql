-- ═══════════════════════════════════════════════════════════════════════════
-- M21.2 — quotation → invoice conversion, recorded as DATED EVENTS.
--
-- 🔴 There is deliberately NO `quotation_items.converted_quantity` column.
-- A running total carries one date, so the second conversion destroys the
-- first one's — the exact loss B4 had to admit in its backfill. Converted
-- quantity is derived (`SUM` over `quotation_conversion_items`) so the
-- instalment history survives, and so a stored aggregate cannot drift from
-- the lines it claims to sum.
--
-- These tables still move NOTHING on their own. The ledger effect belongs
-- entirely to the invoice this produces, created through the EXISTING
-- `invoicesService.create` path — one writer per effect.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "quotation_conversions" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
  "company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
  "quotation_id" integer NOT NULL,
  "invoice_id" integer NOT NULL,
  "converted_on" text NOT NULL,
  "converted_by" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quotation_conversion_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
  "company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
  "conversion_id" integer NOT NULL,
  "quotation_item_id" integer NOT NULL,
  "quantity" numeric(15, 3) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "quotation_conversions" ADD CONSTRAINT "quotation_conversions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_conversions" ADD CONSTRAINT "quotation_conversions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- RESTRICT: a quotation that produced an invoice cannot be deleted out from
-- under the record of what was agreed.
ALTER TABLE "quotation_conversions" ADD CONSTRAINT "quotation_conversions_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_conversions" ADD CONSTRAINT "quotation_conversions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "quotation_conversion_items" ADD CONSTRAINT "quotation_conversion_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_conversion_items" ADD CONSTRAINT "quotation_conversion_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_conversion_items" ADD CONSTRAINT "quotation_conversion_items_conversion_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."quotation_conversions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- RESTRICT again: this is what stops the quotation's own item CASCADE from
-- erasing a converted line.
ALTER TABLE "quotation_conversion_items" ADD CONSTRAINT "quotation_conversion_items_quotation_item_id_fk" FOREIGN KEY ("quotation_item_id") REFERENCES "public"."quotation_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "quotation_conversions_quotation_idx" ON "quotation_conversions" USING btree ("quotation_id");--> statement-breakpoint
CREATE INDEX "quotation_conversions_invoice_idx" ON "quotation_conversions" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "quotation_conversion_items_conversion_idx" ON "quotation_conversion_items" USING btree ("conversion_id");--> statement-breakpoint

-- A conversion of nothing is not a conversion. The service refuses this with a
-- named 400 first; this is the backstop for any writer that forgets.
ALTER TABLE "quotation_conversion_items" ADD CONSTRAINT "quotation_conversion_items_quantity_check"
  CHECK ("quantity" > 0);--> statement-breakpoint

ALTER TABLE "quotation_conversions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quotation_conversion_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "quotation_conversions"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "quotation_conversion_items"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- 🔴 APPEND-ONLY (the invoice_payments / B4 discipline). What was agreed, and
-- when, is exactly the row someone would want to quietly adjust later. SELECT
-- + INSERT only: no UPDATE, no DELETE.
--
-- Consequence worth stating: a conversion recorded in error is corrected the
-- way the ledger corrects things — by a credit note against the invoice it
-- produced — not by editing history. That is deliberate.
GRANT SELECT, INSERT ON TABLE "quotation_conversions" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "quotation_conversion_items" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "quotation_conversions_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "quotation_conversion_items_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotation_conversions', 'quotation_conversion_items'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.quotation_conversions FROM authenticated';
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.quotation_conversion_items FROM authenticated';
  END IF;
END $$;--> statement-breakpoint
