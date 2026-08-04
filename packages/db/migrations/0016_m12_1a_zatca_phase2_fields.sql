-- M12.1a · ZATCA Phase 2 data model.
--
-- Additive and nullable throughout: existing invoices are pre-ZATCA legacy and
-- are deliberately NOT backfilled with uuid/icv. The ZATCA hash chain starts
-- fresh at first onboarding, so a legacy invoice has no place in it and leaving
-- these NULL is the correct representation, not an omission.
--
-- Adds:
--   * invoices           — zatca_uuid, icv, issued_at, document_type
--   * invoice_items      — tax_category_code, exemption reason, unit_code
--   * customers          — structured buyer national short address
--   * companies          — EGS serial number + onboarding status
--   * einvoice_documents — NEW: signed/cleared XML + transmission state
--
-- einvoice_documents is a tenant-scoped BUSINESS table (RLS + app-role grants,
-- like invoices) — NOT owner-only. The tenant is legally required to retain and
-- access their own cleared XML. Key material is different and lands in M12.5's
-- owner-only encrypted vault.

CREATE TABLE "einvoice_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"invoice_id" integer NOT NULL,
	"flow" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invoice_hash" text,
	"previous_invoice_hash" text,
	"qr_code" text,
	"signed_xml" text,
	"cleared_xml" text,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"zatca_status" text,
	"zatca_warnings" jsonb,
	"last_error" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "building_number" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "street" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "district" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "tax_category_code" text;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "tax_exemption_reason_code" text;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "tax_exemption_reason_text" text;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "unit_code" text DEFAULT 'PCE' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "zatca_uuid" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "icv" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "document_type" text DEFAULT 'invoice' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "egs_serial_number" varchar(255);--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "zatca_onboarding_status" varchar(50) DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "einvoice_documents" ADD CONSTRAINT "einvoice_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einvoice_documents" ADD CONSTRAINT "einvoice_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einvoice_documents" ADD CONSTRAINT "einvoice_documents_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "einvoice_documents_invoice_unq" ON "einvoice_documents" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "einvoice_documents_org_status_idx" ON "einvoice_documents" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "einvoice_documents_due_idx" ON "einvoice_documents" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_company_icv_unq" ON "invoices" USING btree ("company_id","icv");
--> statement-breakpoint
-- ── RLS (M3/M4 pattern) ─────────────────────────────────────────────────────
ALTER TABLE "einvoice_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "einvoice_documents";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "einvoice_documents"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- Explicit per-object GRANT — never `ON ALL TABLES` (that crashes this Supabase
-- build into recovery; see 0004 and the supabase-local-rls-testing note).
GRANT SELECT, INSERT, UPDATE, DELETE ON "einvoice_documents" TO authenticated;--> statement-breakpoint

-- ── Backfill: line tax category ─────────────────────────────────────────────
-- ONLY the unambiguous case. A 15% line is unambiguously standard-rated ('S').
-- A 0% line is NOT: it could be zero-rated ('Z') or exempt ('E'), which are
-- different tax treatments the existing data cannot distinguish. Those stay
-- NULL so issuance fails closed and demands an explicit answer, rather than the
-- migration silently guessing a tax fact. (Same principle as M11.6's fail-closed
-- seller VAT number.)
UPDATE "invoice_items" SET "tax_category_code" = 'S' WHERE "vat_rate" = 15;
