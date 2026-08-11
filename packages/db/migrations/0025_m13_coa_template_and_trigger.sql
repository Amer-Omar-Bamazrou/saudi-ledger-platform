-- ═══════════════════════════════════════════════════════════════════════════
-- M13 — one canonical template, and NO organization without a chart of accounts
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 🔴 WHY THIS EXISTS — the fail-closed guard found the real hole immediately.
--
-- Migration 0024 seeded the chart for every organization that existed AT THAT
-- MOMENT, and `signup.repository` seeds it for new signups. That covers two
-- paths and misses every other one: the test fixtures, the seed script, and any
-- future code that creates an organization with a plain INSERT. Each of those
-- produces a tenant that cannot post a single invoice, because GL resolution
-- fails closed.
--
-- Rather than ask every call site to remember, the invariant is enforced where
-- it cannot be bypassed: **an organization row cannot exist without its system
-- accounts.** Same discipline as append-only `audit_logs` and the
-- one-active-credential index — if it matters, the database guarantees it.
--
-- It also removes a duplication. The account list previously lived in TypeScript
-- AND in 0024's SQL. Now there is ONE table, `system_account_templates`, that
-- both the backfill and the trigger read from, and a test asserts it agrees with
-- `packages/db/src/chartOfAccounts.ts`.

CREATE TABLE IF NOT EXISTS "system_account_templates" (
  "code" text PRIMARY KEY,
  "name" text NOT NULL,
  "name_ar" text NOT NULL,
  "type" text NOT NULL,
  "vat_applicable" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0
);--> statement-breakpoint

-- Reference data, not tenant data: no RLS, and the app role only reads it.
-- Revoke the Supabase default REFERENCES/TRIGGER/TRUNCATE grants for the same
-- reason as every other table — TRUNCATE bypasses RLS, and truncating this one
-- would mean the next organization is created with no chart at all.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.system_account_templates FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.system_account_templates TO authenticated';
  END IF;
END $$;--> statement-breakpoint

INSERT INTO "system_account_templates" (code, name, name_ar, type, vat_applicable, sort_order) VALUES
  ('AR',               'Accounts Receivable',        'الذمم المدينة',                          'asset',     false, 10),
  ('CASH',             'Cash and Bank',              'النقد والبنك',                           'asset',     false, 20),
  ('VAT_INPUT',        'Input VAT Receivable',       'ضريبة القيمة المضافة على المشتريات',      'asset',     false, 30),
  ('AP',               'Accounts Payable',           'الذمم الدائنة',                          'liability', false, 40),
  ('VAT_OUTPUT',       'VAT Payable',                'ضريبة القيمة المضافة المستحقة',           'liability', false, 50),
  ('SALARIES_PAYABLE', 'Salaries Payable',           'الرواتب المستحقة',                       'liability', false, 60),
  ('GOSI_PAYABLE',     'GOSI Payable',               'التأمينات الاجتماعية المستحقة',           'liability', false, 70),
  ('SALES',            'Sales Revenue',              'إيرادات المبيعات',                       'income',    true,  80),
  ('PURCHASES',        'Purchases',                  'المشتريات',                              'expense',   true,  90),
  ('SALARIES',         'Salaries and Wages Expense', 'مصروف الرواتب والأجور',                   'expense',   false, 100),
  ('GOSI_EXPENSE',     'GOSI Expense - Employer',    'مصروف التأمينات - حصة صاحب العمل',        'expense',   false, 110)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- Give every organization its chart, from the template. Idempotent, and this
-- re-covers any org created between 0024 and now.
INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, zakat_relevant)
SELECT o.id, t.name, t.name_ar, t.type, t.code, true, t.vat_applicable, false
  FROM organizations o CROSS JOIN system_account_templates t
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

-- 🔴 The invariant: no organization without a chart of accounts, ever.
CREATE OR REPLACE FUNCTION seed_org_chart_of_accounts() RETURNS trigger AS $$
BEGIN
  INSERT INTO categories (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, zakat_relevant)
  SELECT NEW.id, t.name, t.name_ar, t.type, t.code, true, t.vat_applicable, false
    FROM system_account_templates t
  ON CONFLICT (organization_id, system_code) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS seed_org_chart_of_accounts_trg ON "organizations";--> statement-breakpoint
CREATE TRIGGER seed_org_chart_of_accounts_trg
  AFTER INSERT ON "organizations"
  FOR EACH ROW EXECUTE FUNCTION seed_org_chart_of_accounts();
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Refine the system-account protection: guard the APP ROLE, not the owner
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0024's trigger blocked every delete, including the OWNER connection — which
-- broke legitimate teardown (test fixtures dropping an org, and any future
-- admin tooling that removes a tenant). Blocking the owner protects nothing
-- real: the owner runs migrations and can drop the table outright.
--
-- The threat this guards is a TENANT deleting or retyping a system account
-- through a future API route, which runs as the non-owner app role. So the
-- guard applies to exactly that: anyone who is not the table owner.
--
-- Same shape as the rest of the platform's boundaries — owner vs app role, with
-- the app role holding strictly less.
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
      RAISE EXCEPTION 'Cannot delete system account % (%). The posting path and every financial statement depend on it.', OLD.name, OLD.system_code
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
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
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Deleting an organization removes its chart of accounts
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The trigger above means EVERY organization now owns 11 category rows it never
-- asked for. Without a cascade, `DELETE FROM organizations` fails the foreign
-- key — which broke every teardown path in the repository the moment the
-- trigger landed.
--
-- Cascading is also simply correct: the chart belongs to the organization, it is
-- created with it, and it is meaningless without it. Other business tables do
-- NOT cascade because their rows are created deliberately and losing them
-- silently would be a data-loss bug; these are created automatically, so they
-- should disappear automatically.
--
-- (There is no delete-organization route in the product; this affects tooling,
-- migrations and tests.)
ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "categories_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
