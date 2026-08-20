-- ═══════════════════════════════════════════════════════════════════════════
-- M21.1 — Quotations. An OFFER to a customer; not a supply.
--
-- 🔴 These tables are invisible to every aggregate BY CONSTRUCTION: reports
-- and statements query invoices/bills/transactions/journal_entries by table,
-- so a quotation cannot reach the income statement, balance sheet, VAT return,
-- AR aging, cash flow or a budget at any status. Nothing here needs a filter,
-- and nothing here may ever gain one — if a future report wants quotations, it
-- is a PIPELINE figure and must be labelled as such, never mixed into a
-- financial statement.
--
-- Conversion tables land in M21.2, deliberately: this migration builds the
-- document, the next one builds what it becomes.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "quotations" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
  "company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
  "quotation_number" text NOT NULL,
  "customer_id" integer,
  "date" text NOT NULL,
  "valid_until" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "outcome" text,
  "subtotal" numeric(15, 2) DEFAULT '0' NOT NULL,
  "vat_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
  "discount" numeric(15, 2) DEFAULT '0',
  "total" numeric(15, 2) DEFAULT '0' NOT NULL,
  "currency" text DEFAULT 'SAR',
  "review_note" text,
  "notes" text,
  "terms_and_conditions" text,
  "created_by" integer,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quotation_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
  "company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
  "quotation_id" integer NOT NULL,
  "product_id" integer,
  "description" text NOT NULL,
  "description_ar" text DEFAULT '(not yet translated)' NOT NULL,
  "quantity" numeric(15, 3) DEFAULT '1' NOT NULL,
  "unit_price" numeric(15, 2) NOT NULL,
  "vat_rate" numeric(5, 2) DEFAULT '15',
  "vat_amount" numeric(15, 2) DEFAULT '0',
  "discount" numeric(15, 2) DEFAULT '0',
  "total" numeric(15, 2) DEFAULT '0' NOT NULL,
  "tax_category_code" text,
  "unit_code" text DEFAULT 'PCE' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "quotations_org_status_idx" ON "quotations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "quotations_customer_idx" ON "quotations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "quotation_items_org_quotation_idx" ON "quotation_items" USING btree ("organization_id","quotation_id");--> statement-breakpoint

-- 🔴 THE REAL UNIQUENESS GUARANTEE, not the allocator.
--
-- The number is allocated server-side as max+1 inside the creating
-- transaction. That read-then-write is a race by nature; this index is what
-- turns a lost race into a failed INSERT the caller retries, rather than two
-- quotations quietly sharing a number.
--
-- Stated because the sibling document gets this WRONG today: `invoice_number`
-- is minted in the browser from a truncated millisecond clock and has NO
-- unique constraint at all (queue item C12), on a value that becomes the
-- ZATCA document's cbc:ID.
CREATE UNIQUE INDEX "quotations_company_number_unq" ON "quotations" USING btree ("company_id","quotation_number");--> statement-breakpoint

-- ── Write-boundary invariants (the migration 0049 posture) ─────────────────
-- Each of these is reachable by more than one writer (create, update, and the
-- decline/close actions), so it belongs in the schema rather than in whichever
-- service path happened to be reviewed.

-- The APPROVAL axis vocabulary. Kept separate from `outcome` on purpose: a
-- single status column cannot express "approved AND partially converted".
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_status_check"
  CHECK ("status" IN ('draft', 'submitted', 'approved'));--> statement-breakpoint

-- The tenant's terminal act. NULL = live, and NULL is first-class: the
-- platform never decides on the tenant's behalf that a remainder is dead.
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_outcome_check"
  CHECK ("outcome" IS NULL OR "outcome" IN ('declined', 'closed'));--> statement-breakpoint

-- A quotation that was never issued cannot have been declined or closed by a
-- customer who never saw it.
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_outcome_needs_approval_check"
  CHECK ("outcome" IS NULL OR "status" = 'approved');--> statement-breakpoint

ALTER TABLE "quotations" ADD CONSTRAINT "quotations_amounts_check"
  CHECK ("subtotal" >= 0 AND "vat_amount" >= 0 AND "total" >= 0 AND COALESCE("discount", 0) >= 0);--> statement-breakpoint

-- Quantity > 0: a zero-quantity line is not a line. (Conversion in M21.2 reads
-- these quantities as the ceiling on what may be converted, so a zero or
-- negative here would corrupt the remaining-quantity arithmetic.)
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quantity_check"
  CHECK ("quantity" > 0);--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_amounts_check"
  CHECK ("unit_price" >= 0 AND COALESCE("vat_amount", 0) >= 0 AND COALESCE("discount", 0) >= 0 AND "total" >= 0);--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_vat_rate_check"
  CHECK ("vat_rate" IS NULL OR ("vat_rate" >= 0 AND "vat_rate" <= 100));--> statement-breakpoint

-- ── Tenancy ────────────────────────────────────────────────────────────────
ALTER TABLE "quotations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quotation_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "quotations"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "quotation_items"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- Ordinary tenant tables: the app role reads and writes them (a quotation is
-- editable while it is a draft, unlike the append-only payment history).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "quotations" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "quotation_items" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "quotations_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "quotation_items_id_seq" TO authenticated;--> statement-breakpoint

-- M14's rule: Supabase's base ALTER DEFAULT PRIVILEGES re-grants
-- TRUNCATE/REFERENCES/TRIGGER on every CREATE TABLE, and TRUNCATE bypasses
-- RLS. Narrow them explicitly for each new table.
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotations', 'quotation_items'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint

-- ── Permission grants are NOT here, deliberately ───────────────────────────
-- `packages/db/src/permissions.ts` declares itself "the source of truth for
-- policy data" and every existing resource lives there and nowhere else.
-- Seeding the same grants from a migration as well would be two writers for
-- one fact, which drift silently the first time the matrix is edited.
--
-- 🔴 The consequence, stated because it is a real deployment step: RBAC is
-- FAIL-CLOSED, so applying this migration WITHOUT re-running `seedPermissions`
-- leaves every /quotations route returning 403. `pnpm --filter @workspace/db
-- run seed` is idempotent and is what supplies them.
