-- M4 · Activate RLS enforcement for the non-owner application role.
--
-- Two changes, together, make RLS a live control instead of a dormant backstop:
--
--   1. Replace the M3 bootstrap-tenant column DEFAULTs
--      (app_default_org_id()/app_default_company_id(), which hard-coded the
--      "default" org/company) with defaults derived from the per-request tenant
--      GUCs set by resolveTenant. New rows now auto-scope to the REAL request
--      tenant; if no tenant context is set the default is NULL → the NOT NULL
--      constraint rejects the write (fail-safe), and the RLS WITH CHECK clause
--      independently guarantees the row belongs to the current tenant.
--
--   2. Grant the non-owner `authenticated` role (which the API drops to per
--      request via SET LOCAL ROLE, so RLS applies) the table + sequence
--      privileges it needs. Grants are ENUMERATED PER OBJECT on purpose:
--      `GRANT ... ON ALL TABLES/SEQUENCES IN SCHEMA public` and role-membership
--      GRANTs crash this Supabase build into recovery mode.
--
-- We deliberately do NOT `FORCE ROW LEVEL SECURITY`: the owner (`postgres`) has
-- BYPASSRLS, so FORCE would have no effect on it anyway, and the owner is still
-- needed for migrations, seeding, login, and tenant resolution. Enforcement
-- comes from the app running business queries as the non-owner role, not FORCE.

-- ── 1a. organization_id defaults → request tenant GUC ─────────────────────────
ALTER TABLE "categories" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "vendors" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "invoice_items" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "bill_items" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "bills" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "journal_entries" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "payroll_items" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "payroll_runs" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "fixed_assets" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "bank_accounts" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "budgets" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "period_locks" ALTER COLUMN "organization_id" SET DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid;--> statement-breakpoint

-- ── 1b. company_id defaults → request tenant GUC ──────────────────────────────
ALTER TABLE "transactions" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "invoice_items" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "bill_items" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "bills" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "journal_entries" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "payroll_items" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "payroll_runs" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "fixed_assets" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "bank_accounts" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "budgets" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint
ALTER TABLE "period_locks" ALTER COLUMN "company_id" SET DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid;--> statement-breakpoint

-- ── 1c. Drop the obsolete bootstrap-tenant default functions ──────────────────
DROP FUNCTION IF EXISTS app_default_org_id();--> statement-breakpoint
DROP FUNCTION IF EXISTS app_default_company_id();--> statement-breakpoint

-- ── 2a. Schema usage for the application role ─────────────────────────────────
GRANT USAGE ON SCHEMA public TO authenticated;--> statement-breakpoint

-- ── 2b. Full DML on tenant-scoped business tables (RLS constrains the rows) ───
GRANT SELECT, INSERT, UPDATE, DELETE ON "transactions" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "categories" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "journal_entries" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "journal_entry_lines" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoices" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_items" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "bills" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "bill_items" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "customers" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "vendors" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_accounts" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "employees" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_runs" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_items" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "fixed_assets" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "depreciation_entries" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "budgets" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "period_locks" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "products" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "audit_logs" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "companies" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "branches" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "departments" TO authenticated;--> statement-breakpoint

-- ── 2c. Read-only on non-RLS platform/reference tables (login/resolution/refs) ─
GRANT SELECT ON "organizations" TO authenticated;--> statement-breakpoint
GRANT SELECT ON "users" TO authenticated;--> statement-breakpoint
GRANT SELECT ON "organization_memberships" TO authenticated;--> statement-breakpoint
GRANT SELECT ON "permissions" TO authenticated;--> statement-breakpoint
GRANT SELECT ON "feature_flags" TO authenticated;--> statement-breakpoint

-- ── 2d. Sequence usage for serial PKs the role INSERTs into (per object) ───────
GRANT USAGE, SELECT ON SEQUENCE "transactions_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "categories_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "journal_entries_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "journal_entry_lines_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "invoices_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "invoice_items_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "bills_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "bill_items_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "customers_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "vendors_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "bank_accounts_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "employees_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "payroll_runs_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "payroll_items_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "fixed_assets_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "depreciation_entries_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "budgets_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "period_locks_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "products_id_seq" TO authenticated;
