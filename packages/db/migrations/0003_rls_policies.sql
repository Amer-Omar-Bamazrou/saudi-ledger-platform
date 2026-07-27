-- M3 · Row-Level Security (defense-in-depth tenant isolation)
--
-- Enables RLS + a single tenant_isolation policy on every tenant-scoped table.
-- The policy compares the row's organization_id to the per-request session GUC
-- `app.current_org_id`, set by the API inside each request transaction (M4):
--
--     SELECT set_config('app.current_org_id', '<org-uuid>', true);  -- SET LOCAL
--
-- `current_setting(..., true)` (missing_ok = true) returns NULL when the GUC is
-- unset, so `organization_id::text = NULL` is NULL → the row is filtered out.
-- Result: with no tenant context, queries return ZERO rows — never an error.
--
-- NOTE ON ROLES: RLS does not apply to a table's OWNER unless FORCE ROW LEVEL
-- SECURITY is set (superusers/BYPASSRLS always bypass). We intentionally do NOT
-- FORCE: the app still connects as the owner today, so it keeps working between
-- M3 and M4. RLS becomes the active backstop in M4 once the API connects as a
-- dedicated non-owner role. The isolation test proves enforcement by switching
-- to such a role (SET LOCAL ROLE) before querying.
--
-- Tables intentionally WITHOUT RLS (need cross-org reads for login / org-switch,
-- or are global reference data): organizations, users, organization_memberships,
-- permissions, feature_flags.

-- transactions
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "transactions";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "transactions"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- categories
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "categories";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "categories"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- journal_entries
ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "journal_entries";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "journal_entries"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- journal_entry_lines
ALTER TABLE "journal_entry_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "journal_entry_lines";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "journal_entry_lines"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- invoices
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "invoices";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoices"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- invoice_items
ALTER TABLE "invoice_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "invoice_items";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_items"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- bills
ALTER TABLE "bills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "bills";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bills"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- bill_items
ALTER TABLE "bill_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "bill_items";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bill_items"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- customers
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "customers";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customers"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- vendors
ALTER TABLE "vendors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "vendors";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "vendors"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- bank_accounts
ALTER TABLE "bank_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "bank_accounts";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bank_accounts"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- employees
ALTER TABLE "employees" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "employees";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "employees"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- payroll_runs
ALTER TABLE "payroll_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "payroll_runs";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payroll_runs"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- payroll_items
ALTER TABLE "payroll_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "payroll_items";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payroll_items"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- fixed_assets
ALTER TABLE "fixed_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "fixed_assets";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fixed_assets"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- depreciation_entries
ALTER TABLE "depreciation_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "depreciation_entries";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "depreciation_entries"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- budgets
ALTER TABLE "budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "budgets";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "budgets"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- period_locks
ALTER TABLE "period_locks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "period_locks";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "period_locks"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- products
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "products";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "products"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- audit_logs (tenant-scoped audit trail)
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "audit_logs";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_logs"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- companies (tenant structure — read after org context is set)
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "companies";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "companies"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- branches (tenant structure)
ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "branches";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "branches"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));--> statement-breakpoint

-- departments (tenant structure)
ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "departments";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "departments"
  USING ("organization_id"::text = current_setting('app.current_org_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_org_id', true));
