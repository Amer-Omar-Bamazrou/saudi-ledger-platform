CREATE TABLE "captured_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"staging_path" text,
	"archive_path" text,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"source" text NOT NULL,
	"field_sources" jsonb,
	"extraction" jsonb,
	"qr_payload" text,
	"signature_status" text,
	"signature_detail" text,
	"bill_id" integer,
	"retain_until" timestamp with time zone,
	"captured_by" integer,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone,
	"discarded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "categories" DROP CONSTRAINT "categories_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "captured_documents" ADD CONSTRAINT "captured_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captured_documents" ADD CONSTRAINT "captured_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captured_documents" ADD CONSTRAINT "captured_documents_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "captured_documents_org_status_idx" ON "captured_documents" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "captured_documents_bill_idx" ON "captured_documents" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "captured_documents_captured_at_idx" ON "captured_documents" USING btree ("status","captured_at");--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- A1 — captured documents: tenant-scoped, and MUTABLE while staged
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Tenant business data: RLS + app-role grants, like `einvoice_documents`.
--
-- 🔴 UNLIKE `einvoice_archive`, THIS TABLE IS NOT APPEND-ONLY, AND THAT IS
-- DELIBERATE.
--
-- The archive holds documents WE generated, which ZATCA §5.5 forbids deleting
-- or altering. This table holds documents a USER PHOTOGRAPHED. A capture may be
-- the wrong receipt, a blurry frame, a duplicate, or — the case that decides it
-- — an accidental photograph containing a third party's personal data. It must
-- be possible to correct and to discard one.
--
-- Immutability attaches at PROMOTION, not at capture: once a document is posted
-- to a bill it becomes evidence for an input-VAT deduction, and the promoted
-- copy lives in `ArchiveStore`, which has no delete method at all.
--
-- See queue items C7 (must we keep it?) and C8 (must we be able to delete it?),
-- which may conflict and must be answered together.
ALTER TABLE "captured_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "captured_documents"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "captured_documents" TO authenticated;--> statement-breakpoint

-- The M14 revoke applies here too: TRUNCATE bypasses RLS, and REFERENCES/TRIGGER
-- are owner-only concerns. Migration 0026 narrowed the DEFAULT privileges so a
-- new table inherits none of these, but revoke explicitly so this does not
-- depend on the order migrations happen to run in.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.captured_documents FROM %I', r);
    END IF;
  END LOOP;
END $$;
