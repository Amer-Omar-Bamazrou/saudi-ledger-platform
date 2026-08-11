CREATE TABLE "einvoice_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"einvoice_document_id" uuid NOT NULL,
	"invoice_id" integer NOT NULL,
	"artifact" text NOT NULL,
	"file_name" text NOT NULL,
	"object_path" text NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_bucket" text,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retain_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zatca_credential_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"threshold_days" integer NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"email_delivered" text DEFAULT 'false' NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "einvoice_archive" ADD CONSTRAINT "einvoice_archive_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einvoice_archive" ADD CONSTRAINT "einvoice_archive_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einvoice_archive" ADD CONSTRAINT "einvoice_archive_einvoice_document_id_einvoice_documents_id_fk" FOREIGN KEY ("einvoice_document_id") REFERENCES "public"."einvoice_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einvoice_archive" ADD CONSTRAINT "einvoice_archive_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zatca_credential_reminders" ADD CONSTRAINT "zatca_credential_reminders_credential_id_zatca_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."zatca_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "einvoice_archive_document_artifact_unq" ON "einvoice_archive" USING btree ("einvoice_document_id","artifact");--> statement-breakpoint
CREATE UNIQUE INDEX "einvoice_archive_object_path_unq" ON "einvoice_archive" USING btree ("object_path");--> statement-breakpoint
CREATE INDEX "einvoice_archive_org_idx" ON "einvoice_archive" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "einvoice_archive_retain_idx" ON "einvoice_archive" USING btree ("retain_until");--> statement-breakpoint
CREATE UNIQUE INDEX "zatca_credential_reminders_unq" ON "zatca_credential_reminders" USING btree ("credential_id","threshold_days");--> statement-breakpoint
CREATE INDEX "zatca_credential_reminders_company_idx" ON "zatca_credential_reminders" USING btree ("company_id");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- M12.8 — e-invoice archive: TENANT-SCOPED and APPEND-ONLY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `einvoice_archive` is business data, not identity data: the tenant is legally
-- required to retain and produce their own invoices, so they must be able to
-- read it. RLS + app-role grants, exactly like `einvoice_documents`.
ALTER TABLE "einvoice_archive" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "einvoice_archive"
  USING (organization_id::text = current_setting('app.current_org_id', true))
  WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- 🔴 APPEND-ONLY: SELECT + INSERT only. No UPDATE, no DELETE.
--
-- ZATCA §5.5 requires that generated invoices "should not be deleted or altered
-- by any user" and that the solution protect them "from any alteration or
-- undetected deletion". That is enforced here the way `audit_logs` (M6) and
-- `security_audit_logs` (M11.1) enforce it — in the database, not by convention,
-- because a convention protects nothing against a compromised app role.
GRANT SELECT, INSERT ON TABLE "einvoice_archive" TO authenticated;--> statement-breakpoint

-- 🔴 AND REVOKE THE SUPABASE DEFAULTS — do not delete this block.
--
-- Creating a table is not sufficient. Supabase's base `ALTER DEFAULT PRIVILEGES`
-- silently grants REFERENCES, TRIGGER and **TRUNCATE** on every new table to
-- anon/authenticated/service_role. TRUNCATE needs no DELETE privilege and
-- **bypasses row-level security**, so the GRANT above would be cosmetic: one
-- statement could erase every tenant's archive index, across organizations,
-- while the `tenant_isolation` policy looked on. For a 6–11 year legal retention
-- obligation that is exactly the "undetected deletion" §5.5 names.
--
-- Guarded per role: CI bootstraps only `authenticated`, so a bare REVOKE against
-- a missing role would abort the migration.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.einvoice_archive FROM %I', r);
    END IF;
  END LOOP;
  -- Re-grant the two the app role legitimately needs, in case the loop above
  -- ran against a role that had them via a broader default.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.einvoice_archive TO authenticated';
  END IF;
END $$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- M12.8 — credential reminders: OWNER-ONLY, like the vault it points at
-- ═══════════════════════════════════════════════════════════════════════════
--
-- No RLS and no app-role grants. It holds no key material, but it is keyed to
-- `zatca_credentials`, written only by a background job on the owner connection
-- and read only by the operator surface — no business route is on its path.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.zatca_credential_reminders FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- M12.8 — drop the dead `companies.zatca_onboarding_status` column
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Declared in M12.1a and NEVER WRITTEN by any code: a repository-wide search
-- found exactly one reference, the schema declaration itself. Every row has
-- read 'not_started' since the column was created, so anything trusting it
-- would conclude that no company has ever onboarded.
--
-- M12.4 tracks onboarding through `zatca_credentials.status`
-- (pending_csr → active → superseded | revoked), which is the real state and is
-- what M12.8's operator view derives from. Two sources of truth for one fact is
-- how the M11.6 production blocker happened; a column nothing writes is worse
-- than no column, because it reads as authoritative. Dropped rather than
-- back-filled: the vault already answers the question.
ALTER TABLE "companies" DROP COLUMN IF EXISTS "zatca_onboarding_status";
