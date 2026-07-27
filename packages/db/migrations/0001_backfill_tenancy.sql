-- M3 · Backfill tenancy (idempotent, re-runnable)
--
-- Assigns every pre-tenancy business row to a single bootstrap tenant and
-- migrates existing user roles into organization memberships. Safe to run on a
-- database that already has data, and safe to run more than once:
--   * the default org/company are created only if absent (looked up by slug/name)
--   * every UPDATE is guarded by `WHERE ... IS NULL`
--   * membership inserts use ON CONFLICT DO NOTHING
--
-- The NOT NULL / FK / tenant-scoped-uniqueness enforcement happens in the NEXT
-- migration (0002), which is safe precisely because this one leaves no NULLs.

-- 1) Bootstrap tenant — default organization (unique by slug)
INSERT INTO "organizations" ("name", "slug")
VALUES ('Default Organization', 'default')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint

-- 2) Bootstrap tenant — default company under it (unique by name within the org)
INSERT INTO "companies" ("organization_id", "name")
SELECT o."id", 'Default Company'
FROM "organizations" o
WHERE o."slug" = 'default'
  AND NOT EXISTS (
    SELECT 1 FROM "companies" c
    WHERE c."organization_id" = o."id" AND c."name" = 'Default Company'
  );
--> statement-breakpoint

-- 2b) Default-tenant resolver functions.
-- Used as the column DEFAULT for organization_id / company_id in migration 0002
-- so that pre-M4 write paths (which don't yet supply a tenant) still produce
-- rows owned by the bootstrap tenant instead of failing the NOT NULL constraint.
-- These defaults are REMOVED in M4 once request-scoped tenant context supplies
-- organization_id/company_id explicitly on every write.
CREATE OR REPLACE FUNCTION app_default_org_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT id FROM organizations WHERE slug = 'default' LIMIT 1 $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_default_company_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT id FROM companies WHERE name = 'Default Company' AND organization_id = app_default_org_id() LIMIT 1 $$;
--> statement-breakpoint

-- 3) Backfill tenant keys + memberships atomically.
-- A single transactional UPDATE per table is intentional: atomic all-or-nothing
-- assignment is the safest choice for financial data. For very large tables a
-- batched loop could reduce lock duration, but correctness is prioritized here.
DO $$
DECLARE
  v_org_id     uuid;
  v_company_id uuid;
BEGIN
  SELECT "id" INTO v_org_id FROM "organizations" WHERE "slug" = 'default';
  SELECT "id" INTO v_company_id FROM "companies"
    WHERE "organization_id" = v_org_id AND "name" = 'Default Company';

  IF v_org_id IS NULL OR v_company_id IS NULL THEN
    RAISE EXCEPTION 'Default tenant not found (org=%, company=%) — cannot backfill', v_org_id, v_company_id;
  END IF;

  -- 3a) organization_id on every business table
  UPDATE "transactions"          SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "categories"            SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "journal_entries"       SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "journal_entry_lines"   SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "invoices"              SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "invoice_items"         SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "bills"                 SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "bill_items"            SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "customers"             SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "vendors"               SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "bank_accounts"         SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "employees"             SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "payroll_runs"          SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "payroll_items"         SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "fixed_assets"          SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "depreciation_entries"  SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "budgets"               SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "period_locks"          SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;
  UPDATE "products"              SET "organization_id" = v_org_id WHERE "organization_id" IS NULL;

  -- 3b) company_id on ledger/operational tables (the ones that carry it)
  UPDATE "transactions"          SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "journal_entries"       SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "journal_entry_lines"   SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "invoices"              SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "invoice_items"         SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "bills"                 SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "bill_items"            SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "bank_accounts"         SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "employees"             SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "payroll_runs"          SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "payroll_items"         SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "fixed_assets"          SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "depreciation_entries"  SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "budgets"               SET "company_id" = v_company_id WHERE "company_id" IS NULL;
  UPDATE "period_locks"          SET "company_id" = v_company_id WHERE "company_id" IS NULL;

  -- 3c) Migrate each user's global role into a membership of the default org.
  -- The same user can later hold different roles in other orgs (M5 RBAC); this
  -- preserves their current role as their role in the bootstrap tenant.
  INSERT INTO "organization_memberships" ("user_id", "organization_id", "role", "status")
  SELECT u."id", v_org_id, COALESCE(u."role", 'viewer'), 'active'
  FROM "users" u
  ON CONFLICT ("user_id", "organization_id") DO NOTHING;
END $$;
