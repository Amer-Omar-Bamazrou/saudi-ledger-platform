-- Phase 15 — Budgeting & Planning (docs/product/phase-14-15-reporting-budgeting-decision-pack.md §5).
--
--   budgets ──< budget_versions ──< budget_lines
--
-- 1. The M19 `budgets` table becomes the ARCHIVE `budgets_legacy` (D15-11): renamed, its rows
--    untouched, every grant to a non-owner role revoked. Its rows with an income/expense account
--    are COPIED into the new model as DRAFT version-1 annual lines (never approved: M19 rows were
--    never approved, and a migration must not assert an approval that never happened).
-- 2. Three tenant tables with RLS (company arm), explicit grants, REVOKE of TRUNCATE/REFERENCES/
--    TRIGGER (the 0107/0110 pattern).
-- 3. The lifecycle is enforced HERE, not only in the service (D15-04): lines are writable only
--    while their version is a draft; a version moves only along draft → submitted → approved →
--    superseded (+ send-back submitted → draft); an approved or superseded version is never
--    deleted, so a budget ever approved cannot be deleted even by cascade. Admit triggers check
--    that every referenced row is in the SAME organisation and company, and answer a foreign id
--    exactly like a missing one (no existence oracle — CLAUDE.md §3 "FK checks run OUTSIDE RLS").

-- ── 1. The archive ─────────────────────────────────────────────────────────
ALTER TABLE "budgets" RENAME TO "budgets_legacy";--> statement-breakpoint
ALTER TABLE "budgets_legacy" RENAME CONSTRAINT "budgets_pkey" TO "budgets_legacy_pkey";--> statement-breakpoint
ALTER TABLE "budgets_legacy" RENAME CONSTRAINT "budgets_organization_id_organizations_id_fk" TO "budgets_legacy_organization_id_fk";--> statement-breakpoint
ALTER TABLE "budgets_legacy" RENAME CONSTRAINT "budgets_company_id_companies_id_fk" TO "budgets_legacy_company_id_fk";--> statement-breakpoint
ALTER TABLE "budgets_legacy" RENAME CONSTRAINT "budgets_category_id_categories_id_fk" TO "budgets_legacy_category_id_fk";--> statement-breakpoint
ALTER INDEX "budgets_org_idx" RENAME TO "budgets_legacy_org_idx";--> statement-breakpoint
ALTER SEQUENCE "budgets_id_seq" RENAME TO "budgets_legacy_id_seq";--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  -- every non-owner grantee loses every privilege: an archive is read by the owner only
  FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
           WHERE table_schema = 'public' AND table_name = 'budgets_legacy' AND grantee <> current_user AND grantee <> 'PUBLIC' LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.budgets_legacy FROM %I', r.grantee);
  END LOOP;
  FOR r IN SELECT DISTINCT grantee FROM information_schema.role_usage_grants
           WHERE object_schema = 'public' AND object_name = 'budgets_legacy_id_seq' AND grantee <> current_user AND grantee <> 'PUBLIC' LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE public.budgets_legacy_id_seq FROM %I', r.grantee);
  END LOOP;
END $$;--> statement-breakpoint
REVOKE ALL ON TABLE "budgets_legacy" FROM PUBLIC;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  -- information_schema does not list a grant this role did not make, nor PG17's MAINTAIN:
  -- the known roles are revoked by name as well (the database review, 2026-10-01)
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.budgets_legacy FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.budgets_legacy_id_seq FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
COMMENT ON TABLE "budgets_legacy" IS 'ARCHIVE (Phase 15, D15-11): the M19 annual budgets, renamed with rows untouched. No application reads or writes it; its P&L rows were copied into budgets/budget_versions/budget_lines as DRAFT version-1 annual lines (budget_lines.legacy_budget_id). Dropping it is an owner decision.';--> statement-breakpoint

-- ── 2. The tables ──────────────────────────────────────────────────────────
CREATE TABLE "budgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"scenario" text DEFAULT 'base' NOT NULL,
	"fiscal_calendar" text NOT NULL,
	"fiscal_start_month" smallint NOT NULL,
	"fiscal_label" integer NOT NULL,
	"fiscal_year_start" text NOT NULL,
	"fiscal_year_end" text NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_scenario_chk" CHECK ("budgets"."scenario" in ('base', 'best_case', 'worst_case')),
	CONSTRAINT "budgets_calendar_chk" CHECK ("budgets"."fiscal_calendar" in ('gregorian', 'hijri')),
	CONSTRAINT "budgets_start_month_chk" CHECK ("budgets"."fiscal_start_month" between 1 and 12),
	CONSTRAINT "budgets_year_order_chk" CHECK ("budgets"."fiscal_year_start" < "budgets"."fiscal_year_end"),
	CONSTRAINT "budgets_year_format_chk" CHECK ("budgets"."fiscal_year_start" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and "budgets"."fiscal_year_end" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);--> statement-breakpoint
CREATE TABLE "budget_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"budget_id" integer NOT NULL,
	"version_no" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"based_on_version_id" integer,
	"notes" text,
	"send_back_note" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by" integer,
	"submitted_at" timestamp with time zone,
	"approved_by" integer,
	"approved_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "budget_versions_status_chk" CHECK ("budget_versions"."status" in ('draft', 'submitted', 'approved', 'superseded')),
	CONSTRAINT "budget_versions_no_chk" CHECK ("budget_versions"."version_no" >= 1)
);--> statement-breakpoint
CREATE TABLE "budget_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"version_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"period_no" smallint,
	"amount" numeric(15, 2) NOT NULL,
	"legacy_budget_id" integer,
	CONSTRAINT "budget_lines_period_chk" CHECK ("budget_lines"."period_no" is null or "budget_lines"."period_no" between 1 and 12),
	CONSTRAINT "budget_lines_amount_chk" CHECK ("budget_lines"."amount" >= 0)
);--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_version_id_budget_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."budget_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_account_id_categories_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budgets_company_idx" ON "budgets" USING btree ("company_id","fiscal_year_start");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_company_year_scenario_name_unq" ON "budgets" USING btree ("company_id","fiscal_year_start","scenario","name");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_versions_no_unq" ON "budget_versions" USING btree ("budget_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_versions_one_approved_unq" ON "budget_versions" USING btree ("budget_id") WHERE status = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "budget_versions_one_open_unq" ON "budget_versions" USING btree ("budget_id") WHERE status in ('draft', 'submitted');--> statement-breakpoint
CREATE INDEX "budget_versions_company_idx" ON "budget_versions" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_lines_cell_unq" ON "budget_lines" USING btree ("version_id","account_id",coalesce("period_no", 0));--> statement-breakpoint
CREATE UNIQUE INDEX "budget_lines_legacy_unq" ON "budget_lines" USING btree ("legacy_budget_id") WHERE legacy_budget_id is not null;--> statement-breakpoint
CREATE INDEX "budget_lines_account_idx" ON "budget_lines" USING btree ("account_id");--> statement-breakpoint

-- ── 3. The budget header: its frozen fiscal year never changes ─────────────
CREATE OR REPLACE FUNCTION budgets_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.scenario IS DISTINCT FROM OLD.scenario
     OR NEW.fiscal_calendar IS DISTINCT FROM OLD.fiscal_calendar OR NEW.fiscal_start_month IS DISTINCT FROM OLD.fiscal_start_month
     OR NEW.fiscal_label IS DISTINCT FROM OLD.fiscal_label OR NEW.fiscal_year_start IS DISTINCT FROM OLD.fiscal_year_start
     OR NEW.fiscal_year_end IS DISTINCT FROM OLD.fiscal_year_end
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'budget %: its company, scenario and fiscal year are fixed when it is created (only its name and notes may change)', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'budget_header_frozen';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER budgets_guard BEFORE UPDATE ON "budgets" FOR EACH ROW EXECUTE FUNCTION budgets_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION budgets_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE co record;
BEGIN
  -- the companies FK is checked OUTSIDE RLS: with an org-wide scope (empty company GUC) the
  -- policy's company arm admits any company id, so the pair is checked here (CLAUDE.md §3)
  SELECT id, organization_id INTO co FROM companies WHERE id = NEW.company_id;
  IF co.id IS NULL OR co.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'budget: company % is not in this organisation', NEW.company_id
      USING ERRCODE = '23514', CONSTRAINT = 'budget_header_tenant';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION budgets_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER budgets_admit BEFORE INSERT ON "budgets" FOR EACH ROW EXECUTE FUNCTION budgets_admit();--> statement-breakpoint

-- ── 4. Versions: born a draft, numbered in order, moved only along the lifecycle ──
CREATE OR REPLACE FUNCTION budget_versions_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b record; base record; next_no integer;
BEGIN
  SELECT id, organization_id, company_id INTO b FROM budgets WHERE id = NEW.budget_id;
  IF b.id IS NULL OR b.organization_id IS DISTINCT FROM NEW.organization_id OR b.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'budget version: budget % is not in this organisation and company', NEW.budget_id
      USING ERRCODE = '23514', CONSTRAINT = 'budget_version_tenant';
  END IF;
  IF NEW.status <> 'draft' OR NEW.submitted_at IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'budget version: a version is created as a DRAFT and moves on only through the lifecycle'
      USING ERRCODE = '23514', CONSTRAINT = 'budget_version_born_draft';
  END IF;
  SELECT coalesce(max(version_no), 0) + 1 INTO next_no FROM budget_versions WHERE budget_id = NEW.budget_id;
  IF NEW.version_no <> next_no THEN
    RAISE EXCEPTION 'budget version: the next version of budget % is %, not %', NEW.budget_id, next_no, NEW.version_no
      USING ERRCODE = '23514', CONSTRAINT = 'budget_version_sequence';
  END IF;
  IF NEW.based_on_version_id IS NOT NULL THEN
    SELECT id, budget_id, status INTO base FROM budget_versions WHERE id = NEW.based_on_version_id;
    IF base.id IS NULL OR base.budget_id <> NEW.budget_id OR base.status <> 'approved' THEN
      RAISE EXCEPTION 'budget version: a revision is copied from the budget''s APPROVED version'
        USING ERRCODE = '23514', CONSTRAINT = 'budget_version_revision_base';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION budget_versions_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER budget_versions_admit BEFORE INSERT ON "budget_versions" FOR EACH ROW EXECUTE FUNCTION budget_versions_admit();--> statement-breakpoint

CREATE OR REPLACE FUNCTION budget_versions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved', 'superseded') THEN
      RAISE EXCEPTION 'budget version % (v%) is %: an approved budget is a record and is never deleted — revise it instead', OLD.id, OLD.version_no, OLD.status
        USING ERRCODE = '23514', CONSTRAINT = 'budget_version_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.budget_id IS DISTINCT FROM OLD.budget_id OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.based_on_version_id IS DISTINCT FROM OLD.based_on_version_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'budget version %: its identity is fixed', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'budget_version_identity';
  END IF;
  IF NEW.status = OLD.status THEN
    -- only a draft's own notes may be edited in place
    IF OLD.status <> 'draft' OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.send_back_note IS DISTINCT FROM OLD.send_back_note THEN
      RAISE EXCEPTION 'budget version % (v%) is %: it cannot be changed', OLD.id, OLD.version_no, OLD.status
        USING ERRCODE = '23514', CONSTRAINT = 'budget_version_immutable';
    END IF;
    RETURN NEW;
  END IF;
  -- Each step may change ONLY its own columns; everything else — above all the approval
  -- evidence (approved_at / approved_by) — is pinned (the database and security reviews, 2026-10-01).
  IF (OLD.status, NEW.status) = ('draft', 'submitted') THEN
    -- may set: submitted_at, submitted_by, send_back_note (cleared)
    IF NEW.submitted_at IS NULL OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR NEW.notes IS DISTINCT FROM OLD.notes THEN
      RAISE EXCEPTION 'budget version % (v%): a submission records only who submitted and when', OLD.id, OLD.version_no
        USING ERRCODE = '23514', CONSTRAINT = 'budget_version_transition';
    END IF;
  ELSIF (OLD.status, NEW.status) = ('submitted', 'draft') THEN
    -- send back: may set only send_back_note
    IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR NEW.notes IS DISTINCT FROM OLD.notes THEN
      RAISE EXCEPTION 'budget version % (v%): a send-back records only its note', OLD.id, OLD.version_no
        USING ERRCODE = '23514', CONSTRAINT = 'budget_version_transition';
    END IF;
  ELSIF (OLD.status, NEW.status) IN (('draft', 'approved'), ('submitted', 'approved')) THEN
    -- may set: approved_at, approved_by, send_back_note (cleared)
    IF NEW.approved_at IS NULL OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
       OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR NEW.notes IS DISTINCT FROM OLD.notes THEN
      RAISE EXCEPTION 'budget version % (v%): an approval records only who approved and when', OLD.id, OLD.version_no
        USING ERRCODE = '23514', CONSTRAINT = 'budget_version_transition';
    END IF;
  ELSIF (OLD.status, NEW.status) = ('approved', 'superseded') THEN
    -- may set only superseded_at — and only while a NEWER open version of the same budget exists to be
    -- approved in the same transaction (budget_versions_one_approved checks that at COMMIT)
    IF NEW.superseded_at IS NULL OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
       OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.send_back_note IS DISTINCT FROM OLD.send_back_note
       OR NOT EXISTS (SELECT 1 FROM budget_versions v WHERE v.budget_id = OLD.budget_id AND v.version_no > OLD.version_no AND v.status IN ('draft', 'submitted')) THEN
      RAISE EXCEPTION 'budget version % (v%): an approved version is superseded only by approving a newer revision, and nothing else about it changes', OLD.id, OLD.version_no
        USING ERRCODE = '23514', CONSTRAINT = 'budget_version_transition';
    END IF;
  ELSE
    RAISE EXCEPTION 'budget version % (v%): % → % is not a step of the lifecycle', OLD.id, OLD.version_no, OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'budget_version_transition';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION budget_versions_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER budget_versions_guard BEFORE UPDATE OR DELETE ON "budget_versions" FOR EACH ROW EXECUTE FUNCTION budget_versions_guard();--> statement-breakpoint
-- At COMMIT: a budget that superseded a version holds an approved one — a supersede is never left alone.
CREATE OR REPLACE FUNCTION budget_versions_one_approved_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM budget_versions WHERE budget_id = NEW.budget_id AND status = 'approved') THEN
    RAISE EXCEPTION 'budget %: a superseded version must be replaced by an approved one in the same transaction', NEW.budget_id
      USING ERRCODE = '23514', CONSTRAINT = 'budget_version_superseded_alone';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION budget_versions_one_approved_check() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER budget_versions_one_approved AFTER UPDATE OF status ON "budget_versions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'superseded') EXECUTE FUNCTION budget_versions_one_approved_check();--> statement-breakpoint

-- ── 5. Lines: only a draft's, only an income/expense account of this organisation ──
CREATE OR REPLACE FUNCTION budget_lines_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v record; a record; ver_id integer;
BEGIN
  ver_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  -- FOR UPDATE: serialises line writes against the version's own transitions (and against each other,
  -- so the either-periods-or-annual check below cannot race) — the database review, 2026-10-01
  SELECT id, organization_id, company_id, status, version_no INTO v FROM budget_versions WHERE id = ver_id FOR UPDATE;
  IF TG_OP = 'DELETE' THEN
    -- the version is already gone when its own deletion cascades here (a rejected draft)
    IF v.id IS NOT NULL AND v.status <> 'draft' THEN
      RAISE EXCEPTION 'budget version % (v%) is %: its lines are locked', v.id, v.version_no, v.status
        USING ERRCODE = '23514', CONSTRAINT = 'budget_line_locked';
    END IF;
    RETURN OLD;
  END IF;
  IF v.id IS NULL OR v.organization_id IS DISTINCT FROM NEW.organization_id OR v.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'budget line: version % is not in this organisation and company', NEW.version_id
      USING ERRCODE = '23514', CONSTRAINT = 'budget_line_tenant';
  END IF;
  IF v.status <> 'draft' THEN
    RAISE EXCEPTION 'budget version % (v%) is %: its lines are locked', v.id, v.version_no, v.status
      USING ERRCODE = '23514', CONSTRAINT = 'budget_line_locked';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.version_id IS DISTINCT FROM OLD.version_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.period_no IS DISTINCT FROM OLD.period_no OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.legacy_budget_id IS DISTINCT FROM OLD.legacy_budget_id) THEN
    RAISE EXCEPTION 'budget line %: only its amount may change', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'budget_line_identity';
  END IF;
  SELECT id, organization_id, type, is_posting INTO a FROM categories WHERE id = NEW.account_id;
  -- a foreign id is answered exactly like a missing one
  IF a.id IS NULL OR a.organization_id IS DISTINCT FROM NEW.organization_id OR a.type NOT IN ('income', 'revenue', 'expense') OR a.is_posting IS NOT TRUE THEN
    RAISE EXCEPTION 'budget line: account % is not an income or expense posting account of this organisation', NEW.account_id
      USING ERRCODE = '23514', CONSTRAINT = 'budget_line_account';
  END IF;
  IF EXISTS (SELECT 1 FROM budget_lines l WHERE l.version_id = NEW.version_id AND l.account_id = NEW.account_id AND l.id IS DISTINCT FROM NEW.id
             AND ((NEW.period_no IS NULL) <> (l.period_no IS NULL))) THEN
    RAISE EXCEPTION 'budget line: account % is budgeted EITHER by period OR as one annual amount in a version, never both', NEW.account_id
      USING ERRCODE = '23514', CONSTRAINT = 'budget_line_mode';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION budget_lines_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER budget_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "budget_lines" FOR EACH ROW EXECUTE FUNCTION budget_lines_guard();--> statement-breakpoint

-- an approved version never vanishes, not even by TRUNCATE (the 0110 pattern)
CREATE OR REPLACE FUNCTION budgets_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: budgets are records; TRUNCATE is refused', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'budget_no_truncate';
END $$;--> statement-breakpoint
CREATE TRIGGER budgets_no_truncate BEFORE TRUNCATE ON "budgets" FOR EACH STATEMENT EXECUTE FUNCTION budgets_no_truncate();--> statement-breakpoint
CREATE TRIGGER budget_versions_no_truncate BEFORE TRUNCATE ON "budget_versions" FOR EACH STATEMENT EXECUTE FUNCTION budgets_no_truncate();--> statement-breakpoint
CREATE TRIGGER budget_lines_no_truncate BEFORE TRUNCATE ON "budget_lines" FOR EACH STATEMENT EXECUTE FUNCTION budgets_no_truncate();--> statement-breakpoint

-- ── 6. Tenant isolation, grants ────────────────────────────────────────────
ALTER TABLE "budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."budgets"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
ALTER TABLE "budget_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."budget_versions"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
ALTER TABLE "budget_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."budget_lines"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "budgets" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "budgets_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "budget_versions" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "budget_versions_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "budget_lines" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "budget_lines_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['budgets', 'budget_versions', 'budget_lines'] LOOP
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
        IF current_setting('server_version_num')::int >= 170000 THEN
          EXECUTE format('REVOKE MAINTAIN ON TABLE public.%I FROM %I', t, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- ── 7. The M19 rows, copied (D15-11) — idempotent, owner-only ──────────────
CREATE OR REPLACE FUNCTION budgets_import_legacy(p_organization_id uuid DEFAULT NULL, OUT imported integer, OUT not_imported integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l record; bid integer; vid integer;
BEGIN
  imported := 0; not_imported := 0;
  FOR l IN
    SELECT bl.*, c.type AS cat_type, c.organization_id AS cat_org, c.is_posting AS cat_posting
    FROM budgets_legacy bl LEFT JOIN categories c ON c.id = bl.category_id
    WHERE NOT EXISTS (SELECT 1 FROM budget_lines x WHERE x.legacy_budget_id = bl.id)
      AND (p_organization_id IS NULL OR bl.organization_id = p_organization_id)
    ORDER BY bl.id
  LOOP
    -- a line needs an income/expense posting account of the same organisation, and a YYYY year
    IF l.category_id IS NULL OR l.cat_org IS DISTINCT FROM l.organization_id OR l.cat_type NOT IN ('income', 'revenue', 'expense')
       OR l.cat_posting IS NOT TRUE OR l.period !~ '^[0-9]{4}$' OR l.budgeted_amount < 0
       OR EXISTS (SELECT 1 FROM budgets b JOIN budget_versions v ON v.budget_id = b.id JOIN budget_lines x ON x.version_id = v.id
                  WHERE b.company_id = l.company_id AND b.fiscal_year_start = l.period || '-01-01' AND b.name = 'Budget ' || l.period || ' (imported)'
                    AND x.account_id = l.category_id) THEN
      not_imported := not_imported + 1;
      CONTINUE;
    END IF;
    SELECT id INTO bid FROM budgets
      WHERE company_id = l.company_id AND fiscal_year_start = l.period || '-01-01' AND scenario = 'base' AND name = 'Budget ' || l.period || ' (imported)';
    IF bid IS NULL THEN
      -- M19 budgets were CALENDAR years (its actuals read YYYY-01-01 … YYYY-12-31): kept exactly
      INSERT INTO budgets (organization_id, company_id, name, name_ar, scenario, fiscal_calendar, fiscal_start_month, fiscal_label, fiscal_year_start, fiscal_year_end, notes)
      VALUES (l.organization_id, l.company_id, 'Budget ' || l.period || ' (imported)', 'ميزانية ' || l.period || ' (مستوردة)', 'base', 'gregorian', 1,
              l.period::integer, l.period || '-01-01', l.period || '-12-31',
              'Imported from the M19 annual budgets (budgets_legacy). A DRAFT: those budgets were never approved.')
      RETURNING id INTO bid;
      INSERT INTO budget_versions (organization_id, company_id, budget_id, version_no, status, notes)
      VALUES (l.organization_id, l.company_id, bid, 1, 'draft', 'Imported annual amounts — review, then submit for approval.');
    END IF;
    SELECT id INTO vid FROM budget_versions WHERE budget_id = bid AND version_no = 1 AND status = 'draft';
    IF vid IS NULL THEN
      -- the imported budget has already moved on (submitted or approved): its lines are locked
      not_imported := not_imported + 1;
      CONTINUE;
    END IF;
    INSERT INTO budget_lines (organization_id, company_id, version_id, account_id, period_no, amount, legacy_budget_id)
    VALUES (l.organization_id, l.company_id, vid, l.category_id, NULL, l.budgeted_amount, l.id);
    imported := imported + 1;
  END LOOP;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION budgets_import_legacy(uuid) FROM PUBLIC;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  -- SECURITY DEFINER and tenant-blind by design (it is a migration step): OWNER-ONLY. A hosted
  -- Supabase project may grant EXECUTE on new functions to these roles by default — revoked by name.
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.budgets_import_legacy(uuid) FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM budgets_import_legacy(NULL);
  RAISE NOTICE 'Phase 15: % M19 budget row(s) copied as draft annual lines; % kept in budgets_legacy only (no income/expense account, a duplicate, or not a YYYY year)', r.imported, r.not_imported;
END $$;
