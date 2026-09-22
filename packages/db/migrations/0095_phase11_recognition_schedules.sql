CREATE TABLE "recognition_schedule_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"schedule_id" integer NOT NULL,
	"period" text NOT NULL,
	"sequence" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"journal_entry_id" integer,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recognition_schedule_rows_schedule_period_unq" UNIQUE("schedule_id","period")
);
--> statement-breakpoint
CREATE TABLE "recognition_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"reference" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"description_ar" text,
	"vendor_id" integer,
	"expense_account_id" integer NOT NULL,
	"balance_account_id" integer NOT NULL,
	"total_amount" numeric(15, 2) NOT NULL,
	"periods" integer NOT NULL,
	"start_period" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"opening_journal_entry_id" integer,
	"source_bill_id" integer,
	"notes" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recognition_schedules_company_reference_unq" UNIQUE("company_id","reference")
);
--> statement-breakpoint
ALTER TABLE "recognition_schedule_rows" ADD CONSTRAINT "recognition_schedule_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognition_schedule_rows" ADD CONSTRAINT "recognition_schedule_rows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognition_schedule_rows" ADD CONSTRAINT "recognition_schedule_rows_schedule_id_recognition_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."recognition_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognition_schedule_rows" ADD CONSTRAINT "recognition_schedule_rows_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_expense_account_id_categories_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_balance_account_id_categories_id_fk" FOREIGN KEY ("balance_account_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_opening_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("opening_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recognition_schedule_rows_schedule_idx" ON "recognition_schedule_rows" USING btree ("schedule_id","sequence");--> statement-breakpoint
CREATE INDEX "recognition_schedules_org_idx" ON "recognition_schedules" USING btree ("organization_id","company_id");

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 11 A2/A3 hardening. Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §2-§3.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The two system accounts ─────────────────────────────────────────────
-- IAS 37.11: an ACCRUAL is not a trade payable (it has not been invoiced), so
-- it gets its own liability account and never AP. A PREPAYMENT is an asset.
INSERT INTO "system_account_templates" (code, name, name_ar, type, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, sort_order)
VALUES
  ('PREPAID_EXPENSES',    'Prepaid expenses',   'مصروفات مدفوعة مقدمًا', 'asset',     true, false, 'O', false, 'current', 148),
  ('ACCRUED_LIABILITIES', 'Accrued liabilities', 'مصروفات مستحقة',       'liability', true, false, 'O', false, 'current', 268)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- Existing organizations get them too: the org-seed trigger fires only for NEW
-- orgs (the M13 lesson), so a migration that adds a template must also backfill.
INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, is_posting)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class, true
  FROM organizations o
  CROSS JOIN system_account_templates t
 WHERE t.code IN ('PREPAID_EXPENSES', 'ACCRUED_LIABILITIES')
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

-- ── 2. What the rows may say ───────────────────────────────────────────────
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_kind_chk" CHECK (kind IN ('accrual', 'prepayment'));--> statement-breakpoint
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_status_chk" CHECK (status IN ('draft', 'active', 'completed', 'cancelled'));--> statement-breakpoint
-- A schedule recognises a positive amount over at least one whole period.
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_amount_chk" CHECK (total_amount > 0);--> statement-breakpoint
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_periods_chk" CHECK (periods >= 1);--> statement-breakpoint
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_start_period_chk" CHECK (start_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');--> statement-breakpoint
-- A cancelled schedule says WHY and WHEN; neither alone is a record.
ALTER TABLE "recognition_schedules" ADD CONSTRAINT "recognition_schedules_cancel_chk" CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "recognition_schedule_rows" ADD CONSTRAINT "recognition_schedule_rows_amount_chk" CHECK (amount > 0);--> statement-breakpoint
ALTER TABLE "recognition_schedule_rows" ADD CONSTRAINT "recognition_schedule_rows_period_chk" CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');--> statement-breakpoint
-- posted means BOTH the entry and the timestamp: a row with one and not the
-- other is a half-posted row, and a reader cannot tell which half is true.
ALTER TABLE "recognition_schedule_rows" ADD CONSTRAINT "recognition_schedule_rows_posted_chk" CHECK ((journal_entry_id IS NULL) = (posted_at IS NULL));--> statement-breakpoint

-- ── 3. Tenancy (CLAUDE.md §4) ──────────────────────────────────────────────
ALTER TABLE "recognition_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."recognition_schedules"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
ALTER TABLE "recognition_schedule_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."recognition_schedule_rows"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "recognition_schedules" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "recognition_schedule_rows" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "recognition_schedules_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "recognition_schedule_rows_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recognition_schedules', 'recognition_schedule_rows'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint

-- ── 4. A POSTED ROW IS FROZEN ──────────────────────────────────────────────
-- The same guarantee `asset_depreciation_schedule` carries. Once a row has
-- reached the GL, its amount, its period and its entry are facts of record: a
-- correction is a REVERSAL and a new act, never an edit. Enforced at the write
-- boundary because per-path enforcement is per-path review, and a new path
-- starts at zero.
CREATE OR REPLACE FUNCTION refuse_posted_recognition_row_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.journal_entry_id IS NOT NULL AND pg_has_role(current_user, 'authenticated', 'MEMBER') THEN
      RAISE EXCEPTION 'A posted recognition row cannot be deleted (schedule %, period %) — reverse its journal entry instead.', OLD.schedule_id, OLD.period
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.journal_entry_id IS NOT NULL AND (
       NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.period IS DISTINCT FROM OLD.period
    OR NEW.sequence IS DISTINCT FROM OLD.sequence
    OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
    OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id) THEN
    RAISE EXCEPTION 'A posted recognition row is a fact of record (schedule %, period %) — reverse its journal entry instead of editing it.', OLD.schedule_id, OLD.period
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER recognition_schedule_rows_frozen
  BEFORE UPDATE OR DELETE ON public."recognition_schedule_rows"
  FOR EACH ROW EXECUTE FUNCTION refuse_posted_recognition_row_change();--> statement-breakpoint

CREATE OR REPLACE FUNCTION touch_recognition_schedule() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER recognition_schedules_touch
  BEFORE UPDATE ON public."recognition_schedules"
  FOR EACH ROW EXECUTE FUNCTION touch_recognition_schedule();
