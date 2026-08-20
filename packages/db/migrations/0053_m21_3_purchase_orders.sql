-- ═══════════════════════════════════════════════════════════════════════════
-- M21.3 — Purchase orders, and PO → bill conversion.
--
-- The mirror of 0051 + 0052. Same invariants: invisible to every aggregate by
-- construction, approval axis in `status`, conversion axis DERIVED, tenant's
-- terminal act in `outcome`, conversions recorded as DATED APPEND-ONLY events.
--
-- 🔴 Three deliberate differences from the quotation side, each verified
-- against what a BILL can actually represent rather than assumed from
-- symmetry:
--   1. NO discount column anywhere. `bill_items` has none and neither does
--      `bills` (invoices have both) — a discount here would be silently
--      dropped at conversion, which is the "partial data is not lenient data"
--      failure. A supplier discount goes in the agreed unit price.
--   2. NO tax_category_code. `bill_items` has none; bills carry VAT as rate +
--      amount.
--   3. The vocabulary is BILLING, never delivery — `billed_on`, not
--      `received_on`. There is no goods-receipt concept, so we cannot tell
--      "shipped half" from "billed half", and no column may imply we can.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "purchase_orders" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
  "company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
  "order_number" text NOT NULL,
  "vendor_id" integer,
  "date" text NOT NULL,
  "valid_until" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "outcome" text,
  "subtotal" numeric(15, 2) DEFAULT '0' NOT NULL,
  "vat_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
  "total" numeric(15, 2) DEFAULT '0' NOT NULL,
  "currency" text DEFAULT 'SAR',
  "review_note" text,
  "notes" text,
  "created_by" integer,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "purchase_order_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
  "company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
  "purchase_order_id" integer NOT NULL,
  "product_id" integer,
  "description" text NOT NULL,
  "description_ar" text DEFAULT '(not yet translated)' NOT NULL,
  "quantity" numeric(15, 3) DEFAULT '1' NOT NULL,
  "unit_price" numeric(15, 2) NOT NULL,
  "vat_rate" numeric(5, 2) DEFAULT '15',
  "vat_amount" numeric(15, 2) DEFAULT '0',
  "total" numeric(15, 2) DEFAULT '0' NOT NULL,
  "unit_code" text DEFAULT 'PCE' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "purchase_order_conversions" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
  "company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
  "purchase_order_id" integer NOT NULL,
  "bill_id" integer NOT NULL,
  "billed_on" text NOT NULL,
  "converted_by" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "purchase_order_conversion_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
  "company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
  "conversion_id" integer NOT NULL,
  "purchase_order_item_id" integer NOT NULL,
  "quantity" numeric(15, 3) NOT NULL,
  -- The price the supplier ACTUALLY billed. The ordered price stays on the PO
  -- line; the variance is derived from the two, so it is a recorded fact
  -- rather than a recomputation that a later bill edit would invalidate.
  "unit_price" numeric(15, 2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "purchase_order_conversions" ADD CONSTRAINT "purchase_order_conversions_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_conversions" ADD CONSTRAINT "purchase_order_conversions_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_conversions" ADD CONSTRAINT "purchase_order_conversions_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_conversions" ADD CONSTRAINT "purchase_order_conversions_bill_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "purchase_order_conversion_items" ADD CONSTRAINT "purchase_order_conversion_items_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_conversion_items" ADD CONSTRAINT "purchase_order_conversion_items_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_conversion_items" ADD CONSTRAINT "purchase_order_conversion_items_conversion_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."purchase_order_conversions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_conversion_items" ADD CONSTRAINT "purchase_order_conversion_items_order_item_id_fk" FOREIGN KEY ("purchase_order_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "purchase_orders_org_status_idx" ON "purchase_orders" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "purchase_orders_vendor_idx" ON "purchase_orders" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_company_number_unq" ON "purchase_orders" USING btree ("company_id","order_number");--> statement-breakpoint
CREATE INDEX "purchase_order_items_org_order_idx" ON "purchase_order_items" USING btree ("organization_id","purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_conversions_order_idx" ON "purchase_order_conversions" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_conversions_bill_idx" ON "purchase_order_conversions" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "purchase_order_conversion_items_conversion_idx" ON "purchase_order_conversion_items" USING btree ("conversion_id");--> statement-breakpoint

-- ── Write-boundary invariants ──────────────────────────────────────────────
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_status_check"
  CHECK ("status" IN ('draft', 'submitted', 'approved'));--> statement-breakpoint

-- 🔴 `cancelled`, not `declined`. A purchase order is withdrawn by US; saying
-- the supplier declined it would assert a fact we have no way to know.
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_outcome_check"
  CHECK ("outcome" IS NULL OR "outcome" IN ('cancelled', 'closed'));--> statement-breakpoint

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_outcome_needs_approval_check"
  CHECK ("outcome" IS NULL OR "status" = 'approved');--> statement-breakpoint

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_amounts_check"
  CHECK ("subtotal" >= 0 AND "vat_amount" >= 0 AND "total" >= 0);--> statement-breakpoint

ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_quantity_check"
  CHECK ("quantity" > 0);--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_amounts_check"
  CHECK ("unit_price" >= 0 AND COALESCE("vat_amount", 0) >= 0 AND "total" >= 0);--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_vat_rate_check"
  CHECK ("vat_rate" IS NULL OR ("vat_rate" >= 0 AND "vat_rate" <= 100));--> statement-breakpoint

ALTER TABLE "purchase_order_conversion_items" ADD CONSTRAINT "purchase_order_conversion_items_quantity_check"
  CHECK ("quantity" > 0);--> statement-breakpoint
-- A billed price of zero is legitimate (a free replacement line); a negative
-- one is not — that would be a credit, which is a different document.
ALTER TABLE "purchase_order_conversion_items" ADD CONSTRAINT "purchase_order_conversion_items_price_check"
  CHECK ("unit_price" >= 0);--> statement-breakpoint

-- ── Tenancy ────────────────────────────────────────────────────────────────
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "purchase_order_conversions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "purchase_order_conversion_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "purchase_orders"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "purchase_order_items"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "purchase_order_conversions"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "purchase_order_conversion_items"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "purchase_orders" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "purchase_order_items" TO authenticated;--> statement-breakpoint
-- Append-only: what was billed against an order, and when.
GRANT SELECT, INSERT ON TABLE "purchase_order_conversions" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "purchase_order_conversion_items" TO authenticated;--> statement-breakpoint

GRANT USAGE, SELECT ON SEQUENCE "purchase_orders_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "purchase_order_items_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "purchase_order_conversions_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "purchase_order_conversion_items_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_orders', 'purchase_order_items', 'purchase_order_conversions', 'purchase_order_conversion_items'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.purchase_order_conversions FROM authenticated';
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.purchase_order_conversion_items FROM authenticated';
  END IF;
END $$;--> statement-breakpoint
