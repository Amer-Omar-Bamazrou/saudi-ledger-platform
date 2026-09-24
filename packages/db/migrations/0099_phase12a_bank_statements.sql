CREATE TABLE "bank_statements" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"bank_account_id" integer NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"opening_balance" numeric(15, 2),
	"closing_balance" numeric(15, 2),
	"source" text NOT NULL,
	"file_name" text,
	"file_sha256" text,
	"line_count" integer NOT NULL,
	"file_credit_total" numeric(15, 2) NOT NULL,
	"file_debit_total" numeric(15, 2) NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statements_period_chk" CHECK (period_from <= period_to),
	CONSTRAINT "bank_statements_balances_both_chk" CHECK ((opening_balance IS NULL) = (closing_balance IS NULL)),
	CONSTRAINT "bank_statements_source_chk" CHECK (source IN ('file_upload', 'manual_entry')),
	CONSTRAINT "bank_statements_sha_chk" CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "bank_statements_file_needs_sha_chk" CHECK (source <> 'file_upload' OR file_sha256 IS NOT NULL),
	CONSTRAINT "bank_statements_totals_chk" CHECK (line_count >= 0 AND file_credit_total >= 0 AND file_debit_total >= 0)
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "bank_statement_id" integer;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_statements_bank_idx" ON "bank_statements" USING btree ("company_id","bank_account_id","period_from");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statements_file_unq" ON "bank_statements" USING btree ("company_id","bank_account_id","file_sha256") WHERE file_sha256 IS NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bank_statement_id_bank_statements_id_fk" FOREIGN KEY ("bank_statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_statement_idx" ON "transactions" USING btree ("bank_statement_id");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 12A — bank statements as records (decision pack §3).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Tenancy (CLAUDE.md §4): RLS with the N1 company arm ────────────────────
ALTER TABLE "bank_statements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."bank_statements"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint

-- 🔴 APPEND-ONLY: a statement is a fact about what the bank sent. SELECT and
-- INSERT only — no UPDATE, no DELETE, and none of Supabase's default extras.
GRANT SELECT, INSERT ON TABLE "bank_statements" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "bank_statements_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.bank_statements FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- ── A line's provenance is fixed, and agrees with its statement ────────────
-- A line imported under a statement belongs to the statement's bank; and once
-- a line names its statement, that is what it came from — it cannot be moved
-- to another statement or lose it. Enforced here because transactions has
-- several writers (upload, review edits, settle, categorize).
CREATE OR REPLACE FUNCTION check_transaction_statement_provenance() RETURNS trigger AS $$
DECLARE stmt_bank integer;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.bank_statement_id IS NOT NULL
     AND NEW.bank_statement_id IS DISTINCT FROM OLD.bank_statement_id THEN
    RAISE EXCEPTION 'Bank line % was imported under statement %; its provenance cannot change.', OLD.id, OLD.bank_statement_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.bank_statement_id IS NOT NULL THEN
    SELECT s.bank_account_id INTO stmt_bank FROM bank_statements s WHERE s.id = NEW.bank_statement_id;
    IF stmt_bank IS DISTINCT FROM NEW.bank_account_id THEN
      RAISE EXCEPTION 'Bank line % names bank % but its statement % is for bank %.', NEW.id, NEW.bank_account_id, NEW.bank_statement_id, stmt_bank
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER transactions_statement_provenance
  BEFORE INSERT OR UPDATE OF bank_statement_id, bank_account_id ON public."transactions"
  FOR EACH ROW EXECUTE FUNCTION check_transaction_statement_provenance();
