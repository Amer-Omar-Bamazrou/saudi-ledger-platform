-- M12.5 · ZATCA credential vault.
--
-- 🔴 The most sensitive table in the platform: a leaked private key lets someone
-- issue legally-valid tax invoices in a tenant's name.
--
-- Owner-only: NO RLS and NO app-role grants. Reachable only from
-- services/einvoice/signing/ on the base (owner) connection.
-- Design: docs/zatca/m12-5-credential-vault-design.md
CREATE TABLE "zatca_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"status" text DEFAULT 'pending_csr' NOT NULL,
	"kms_provider" text NOT NULL,
	"kms_key_id" text NOT NULL,
	"wrapped_data_key" "bytea" NOT NULL,
	"encrypted_private_key" "bytea" NOT NULL,
	"private_key_iv" "bytea" NOT NULL,
	"private_key_auth_tag" "bytea" NOT NULL,
	"encrypted_csid_secret" "bytea",
	"csid_secret_iv" "bytea",
	"csid_secret_auth_tag" "bytea",
	"csr_pem" text,
	"certificate_pem" text,
	"egs_serial_number" text,
	"not_before" timestamp with time zone,
	"not_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
ALTER TABLE "zatca_credentials" ADD CONSTRAINT "zatca_credentials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "zatca_credentials_company_idx" ON "zatca_credentials" USING btree ("company_id","environment");--> statement-breakpoint
CREATE INDEX "zatca_credentials_not_after_idx" ON "zatca_credentials" USING btree ("not_after");--> statement-breakpoint

-- At most ONE active credential per (company, environment). The DATABASE is the
-- guarantee, not application logic: two concurrent onboardings cannot both win.
-- A partial unique index (Drizzle cannot express one) — same idiom as M11.7's
-- pending-invitation index. Superseded/revoked rows are retained as history.
CREATE UNIQUE INDEX "zatca_credentials_one_active_unq"
  ON "zatca_credentials" ("company_id", "environment")
  WHERE "status" = 'active';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 EXPLICIT REVOKE — do not delete this block.
--
-- Creating a table is NOT sufficient to keep the app role out. Supabase's base
-- setup carries `ALTER DEFAULT PRIVILEGES` that automatically grant
-- REFERENCES, TRIGGER and **TRUNCATE** on every newly created table to `anon`,
-- `authenticated` and `service_role` — verified on the local stack against the
-- five existing owner-only tables, which all carry exactly those three.
--
-- SELECT/INSERT/UPDATE/DELETE are not granted, so the usual boundary tests pass
-- and the leak risk is closed. **TRUNCATE is the problem.** It needs no DELETE
-- privilege and bypasses RLS, so without this REVOKE the app role — reachable
-- from any of the ~18 business routes via SQL injection — could wipe EVERY
-- tenant's signing keys in one statement. That is unrecoverable: each tenant
-- would have to re-onboard with a new key, CSR and OTP.
--
-- This is the platform-wide MEDIUM finding recorded in CLAUDE.md, fixed here for
-- the one table where destruction is catastrophic rather than merely bad.
-- Guarded per role: CI bootstraps only `authenticated`, so a bare REVOKE against
-- `anon`/`service_role` would abort the migration with "role does not exist".
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.zatca_credentials FROM %I', r);
    END IF;
  END LOOP;
END $$;