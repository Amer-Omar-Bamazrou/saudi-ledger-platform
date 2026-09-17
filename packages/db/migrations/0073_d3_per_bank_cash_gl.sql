CREATE TABLE "cash_cutover_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"counts" jsonb NOT NULL,
	"report" jsonb NOT NULL,
	"cash_before" numeric(15, 2) NOT NULL,
	"cash_after" numeric(15, 2) NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_line_bank_attributions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"run_id" integer,
	"line_id" integer NOT NULL,
	"journal_entry_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"account_name" text NOT NULL,
	"bank_account_id" integer NOT NULL,
	"gl_account_id" integer NOT NULL,
	"classification" text NOT NULL,
	"rule" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "parent_id" integer;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "bank_account_id" integer;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "is_posting" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD COLUMN "bank_account_id" integer;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "bank_account_id" integer;--> statement-breakpoint
ALTER TABLE "cash_cutover_runs" ADD CONSTRAINT "cash_cutover_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_cutover_runs" ADD CONSTRAINT "cash_cutover_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_line_bank_attributions" ADD CONSTRAINT "cash_line_bank_attributions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_line_bank_attributions" ADD CONSTRAINT "cash_line_bank_attributions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_line_bank_attributions" ADD CONSTRAINT "cash_line_bank_attributions_run_id_cash_cutover_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."cash_cutover_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_line_bank_attributions" ADD CONSTRAINT "cash_line_bank_attributions_line_id_journal_entry_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."journal_entry_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_line_bank_attributions" ADD CONSTRAINT "cash_line_bank_attributions_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_line_bank_attributions" ADD CONSTRAINT "cash_line_bank_attributions_account_id_categories_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_line_bank_attributions" ADD CONSTRAINT "cash_line_bank_attributions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_line_bank_attributions" ADD CONSTRAINT "cash_line_bank_attributions_gl_account_id_categories_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_cutover_runs_company_idx" ON "cash_cutover_runs" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_line_bank_attributions_line_unq" ON "cash_line_bank_attributions" USING btree ("line_id");--> statement-breakpoint
CREATE INDEX "cash_line_bank_attributions_run_idx" ON "cash_line_bank_attributions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "cash_line_bank_attributions_bank_idx" ON "cash_line_bank_attributions" USING btree ("bank_account_id");--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_bank_account_unq" ON "categories" USING btree ("bank_account_id");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- D-3 / G3 — PER-BANK CASH GL (2026-09-16, annotation model 2026-09-17). Hand-written half.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Decision record: docs/product/accounting-architecture-decision-pack.md §D-3;
-- as-built: docs/product/design-per-bank-cash.md. The generated DDL above adds
-- the columns and the evidence tables; everything below is the part drizzle
-- cannot express — the header flag on the template, the trigger that creates a
-- GL leaf for every bank account BY CONSTRUCTION, the protections, the
-- non-posting boundary on journal lines, the ONE bank-identity resolver (a
-- view), the RLS/grants on the new tables, and the backfill of leaves for
-- every bank account that already exists.
--
-- 🔴 What this migration — and the cut-over it prepares — NEVER does: change
-- a posted journal line. History stays on "Cash and Bank" exactly as posted;
-- the cut-over (cashCutover.service.ts) ANNOTATES each historical line with
-- the bank its source evidence establishes (cash_line_bank_attributions) and
-- refuses to run while any line is not deterministically attributable. The
-- header simply accepts no NEW line from here on.

-- ── 1. The header flag, on the template AND on every org's chart ───────────
-- The org-seed trigger copies template → categories column by column, so the
-- template must carry the flag and the trigger must name it (the guard test
-- tests/org-seed-trigger.test.ts compares the column sets).
ALTER TABLE "system_account_templates" ADD COLUMN IF NOT EXISTS "is_posting" boolean NOT NULL DEFAULT true;--> statement-breakpoint
UPDATE "system_account_templates" SET "is_posting" = false WHERE code = 'CASH';--> statement-breakpoint
UPDATE "categories" SET "is_posting" = false WHERE system_code = 'CASH';--> statement-breakpoint

CREATE OR REPLACE FUNCTION seed_org_chart_of_accounts() RETURNS trigger AS $$
BEGIN
  INSERT INTO categories (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, input_vat_blocked, is_posting)
  SELECT NEW.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class, t.input_vat_blocked, t.is_posting
    FROM system_account_templates t
  ON CONFLICT (organization_id, system_code) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ── 2. What a bank leaf IS — a shape, not a convention ─────────────────────
-- A row that names a bank account is a cash asset leaf: system-owned, no
-- system code (the bank id is its identity), cash-classified, under a parent,
-- postable. Anything else claiming a bank is refused at the column.
ALTER TABLE "categories" ADD CONSTRAINT "categories_bank_leaf_shape_chk" CHECK (
  bank_account_id IS NULL OR (
    type = 'asset' AND is_system = true AND system_code IS NULL
    AND liquidity_class = 'cash' AND parent_id IS NOT NULL AND is_posting = true
  )
);--> statement-breakpoint

-- FK checks run OUTSIDE RLS (CLAUDE.md §3): a plain FK to bank_accounts is a
-- cross-tenant edge nothing guards. This trigger closes it — the bank and the
-- parent must belong to the leaf's own organization. As the app role the
-- other org's rows are invisible (RLS) so the lookup finds nothing; as the
-- owner the explicit comparison does the same job.
CREATE OR REPLACE FUNCTION categories_bank_link_chk() RETURNS trigger AS $$
DECLARE
  bank_org uuid;
  parent_org uuid;
BEGIN
  IF NEW.bank_account_id IS NOT NULL THEN
    SELECT organization_id INTO bank_org FROM bank_accounts WHERE id = NEW.bank_account_id;
    IF bank_org IS NULL OR bank_org <> NEW.organization_id THEN
      RAISE EXCEPTION 'Bank GL account % names bank account % which is not in organization %.', NEW.name, NEW.bank_account_id, NEW.organization_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT organization_id INTO parent_org FROM categories WHERE id = NEW.parent_id;
    IF parent_org IS NULL OR parent_org <> NEW.organization_id THEN
      RAISE EXCEPTION 'Account % names parent % which is not in organization %.', NEW.name, NEW.parent_id, NEW.organization_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS categories_bank_link_chk_trg ON "categories";--> statement-breakpoint
CREATE TRIGGER categories_bank_link_chk_trg
  BEFORE INSERT OR UPDATE ON "categories"
  FOR EACH ROW EXECUTE FUNCTION categories_bank_link_chk();--> statement-breakpoint

-- ── 3. Protection, extended ───────────────────────────────────────────────
-- Same owner-vs-app-role shape as 0025 (the owner runs migrations and
-- teardown; the guard applies to everyone else). New rules:
--   • a bank leaf may be deleted ONLY as the consequence of its bank account's
--     deletion (the FK cascade) — never directly while the bank still exists;
--     and while ledger history references the leaf, the lines FK (RESTRICT)
--     refuses the cascade itself, so the bank account cannot be deleted either;
--   • bank_account_id is immutable once set — a leaf cannot be reassigned;
--   • on system rows parent_id and is_posting are immutable too.
CREATE OR REPLACE FUNCTION protect_system_categories() RETURNS trigger AS $$
DECLARE
  owner_name text;
BEGIN
  SELECT tableowner INTO owner_name FROM pg_tables WHERE schemaname = 'public' AND tablename = 'categories';

  -- The owner connection (migrations, seeding, teardown) is not the threat.
  IF current_user = owner_name THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      IF OLD.bank_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.id = OLD.bank_account_id) THEN
        -- The bank account is gone (this is its FK cascade): the leaf goes with it.
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'Cannot delete system account % (%). The posting path and every financial statement depend on it.', OLD.name, coalesce(OLD.system_code, 'bank ' || OLD.bank_account_id::text)
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.bank_account_id IS NOT NULL AND NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id THEN
    RAISE EXCEPTION 'Cannot reassign GL account % from bank account % (-> %).', OLD.name, OLD.bank_account_id, NEW.bank_account_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.is_system THEN
    IF NEW.type IS DISTINCT FROM OLD.type THEN
      RAISE EXCEPTION 'Cannot change the type of system account % (% -> %). Financial statements bucket by type.', OLD.system_code, OLD.type, NEW.type
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.system_code IS DISTINCT FROM OLD.system_code THEN
      RAISE EXCEPTION 'Cannot change the system_code of a system account (% -> %).', OLD.system_code, NEW.system_code
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.is_system IS DISTINCT FROM OLD.is_system THEN
      RAISE EXCEPTION 'Cannot un-flag a system account (%).', OLD.system_code
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
      RAISE EXCEPTION 'Cannot move system account % (parent % -> %).', OLD.name, OLD.parent_id, NEW.parent_id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.is_posting IS DISTINCT FROM OLD.is_posting THEN
      RAISE EXCEPTION 'Cannot change whether system account % accepts postings.', OLD.name
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ── 4. One GL leaf per bank account, BY CONSTRUCTION ──────────────────────
-- Fires for every writer of bank_accounts — the service, a seed script, a
-- test fixture's raw INSERT — so "a bank account without a GL account" cannot
-- be said. The leaf takes the bank's name (the tenant renames the bank, the
-- leaf follows), sits under the org's CASH header, and is cash-classified so
-- every existing cash reader (liquidity_class = 'cash') sums it without
-- change. An org with no CASH header cannot get a bank account: that is the
-- seeded chart missing, which fails loudly here instead of silently later.
CREATE OR REPLACE FUNCTION ensure_bank_gl_account() RETURNS trigger AS $$
DECLARE
  header_id integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT id INTO header_id FROM categories
     WHERE organization_id = NEW.organization_id AND system_code = 'CASH';
    IF header_id IS NULL THEN
      RAISE EXCEPTION 'Organization % has no CASH header account; the system chart of accounts is not seeded, so no bank GL account can be created for bank account %.', NEW.organization_id, NEW.name
        USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO categories (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, liquidity_class, parent_id, bank_account_id, is_posting, description)
    VALUES (NEW.organization_id, NEW.name, NEW.name, 'asset', NULL, true, false, 'cash', header_id, NEW.id, true,
            'Bank GL account, created automatically for bank account ' || NEW.id::text || ' (D-3, 2026-09-16)')
    ON CONFLICT (bank_account_id) DO NOTHING;
    RETURN NEW;
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE categories SET name = NEW.name, name_ar = NEW.name WHERE bank_account_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS ensure_bank_gl_account_trg ON "bank_accounts";--> statement-breakpoint
CREATE TRIGGER ensure_bank_gl_account_trg
  AFTER INSERT OR UPDATE OF name ON "bank_accounts"
  FOR EACH ROW EXECUTE FUNCTION ensure_bank_gl_account();--> statement-breakpoint

-- Every bank account that already exists gets its leaf now. Idempotent on
-- the unique bank_account_id. Provenance is stamped on the row.
INSERT INTO categories (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, liquidity_class, parent_id, bank_account_id, is_posting, description)
SELECT b.organization_id, b.name, b.name, 'asset', NULL, true, false, 'cash', h.id, b.id, true,
       'Bank GL account, created by migration 0073 for bank account ' || b.id::text || ' (D-3, 2026-09-16)'
  FROM bank_accounts b
  JOIN categories h ON h.organization_id = b.organization_id AND h.system_code = 'CASH'
ON CONFLICT (bank_account_id) DO NOTHING;--> statement-breakpoint

-- The migration refuses to leave a bank account without a leaf: an org whose
-- CASH header is missing would silently get no leaf from the JOIN above.
DO $$
DECLARE missing integer;
BEGIN
  SELECT count(*) INTO missing FROM bank_accounts b
   WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.bank_account_id = b.id);
  IF missing > 0 THEN
    RAISE EXCEPTION 'D-3: % bank account(s) have no GL leaf after the backfill — an organization is missing its CASH header. Seed the chart and re-run.', missing;
  END IF;
END $$;--> statement-breakpoint

-- ── 5. A NON-POSTING account accepts no new line — at the database ────────
-- The posting seam refuses it, the manual-JE service refuses it with a 422,
-- and this trigger refuses every other writer, including raw SQL. The one
-- exception: a REVERSAL mirror (reversal_of IS NOT NULL) of a line that is
-- still on the header — a mirror must name the account it cancels, and
-- history stays on "Cash and Bank" until the company's cut-over. No owner
-- bypass here: nothing legitimate posts new cash to the header.
CREATE OR REPLACE FUNCTION refuse_non_posting_account_line() RETURNS trigger AS $$
DECLARE
  posting boolean;
  acct_name text;
  is_reversal boolean;
BEGIN
  IF NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT is_posting, name INTO posting, acct_name FROM categories WHERE id = NEW.account_id;
  IF posting IS DISTINCT FROM false THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT (reversal_of IS NOT NULL) INTO is_reversal FROM journal_entries WHERE id = NEW.journal_entry_id;
    IF coalesce(is_reversal, false) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Account % is a header and accepts no postings. A cash line names a bank account and posts to that bank''s GL account.', acct_name
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS refuse_non_posting_account_line_trg ON "journal_entry_lines";--> statement-breakpoint
CREATE TRIGGER refuse_non_posting_account_line_trg
  BEFORE INSERT OR UPDATE OF account_id ON "journal_entry_lines"
  FOR EACH ROW EXECUTE FUNCTION refuse_non_posting_account_line();--> statement-breakpoint

-- ── 6. THE ONE RESOLVER of a cash line's bank identity ──────────────────
-- Two places can name a line's bank — the leaf it sits on (new postings) or
-- its attribution row (history on the header) — and two definitions of one
-- fact diverge (CLAUDE.md §3). This view is the single definition: leaf
-- first, attribution second, never both (an attributed line is on the
-- header, which has no bank). Every per-bank reader joins it; none re-derives
-- the answer. `security_invoker` keeps RLS on the underlying tables in force
-- for the app role — the view is a definition, not a bypass.
CREATE OR REPLACE VIEW "journal_line_bank_identity" WITH (security_invoker = true) AS
  SELECT l.id                                   AS line_id,
         l.journal_entry_id,
         l.organization_id,
         l.company_id,
         l.account_id,
         COALESCE(c.bank_account_id, a.bank_account_id) AS bank_account_id,
         COALESCE(CASE WHEN c.bank_account_id IS NOT NULL THEN c.id END, a.gl_account_id) AS gl_account_id,
         CASE WHEN c.bank_account_id IS NOT NULL THEN 'leaf'
              WHEN a.bank_account_id IS NOT NULL THEN 'attribution'
              ELSE NULL END                     AS identity_source,
         l.debit_amount,
         l.credit_amount
    FROM journal_entry_lines l
    JOIN categories c ON c.id = l.account_id
    LEFT JOIN cash_line_bank_attributions a ON a.line_id = l.id
   WHERE c.liquidity_class = 'cash';--> statement-breakpoint

GRANT SELECT ON "journal_line_bank_identity" TO authenticated;--> statement-breakpoint

-- ── 7. The evidence tables: tenant-scoped (N1 company arm), append-only ──
ALTER TABLE "cash_cutover_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cash_line_bank_attributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "cash_cutover_runs"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "cash_line_bank_attributions"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE "cash_cutover_runs" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "cash_line_bank_attributions" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "cash_cutover_runs_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "cash_line_bank_attributions_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_cutover_runs', 'cash_line_bank_attributions'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.cash_cutover_runs FROM authenticated';
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.cash_line_bank_attributions FROM authenticated';
  END IF;
END $$;
