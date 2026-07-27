ALTER TABLE "period_locks" DROP CONSTRAINT "period_locks_period_unique";--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "vendors" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_items" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "invoice_items" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_items" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "invoice_items" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_items" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "bill_items" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_items" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "bill_items" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "bills" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "bills" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "journal_entries" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "journal_entries" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "payroll_items" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "payroll_items" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_runs" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "payroll_runs" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_runs" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "payroll_runs" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "depreciation_entries" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "depreciation_entries" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fixed_assets" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "fixed_assets" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fixed_assets" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "fixed_assets" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_accounts" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "bank_accounts" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_accounts" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "bank_accounts" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "budgets" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "budgets" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "budgets" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "period_locks" ALTER COLUMN "organization_id" SET DEFAULT app_default_org_id();--> statement-breakpoint
ALTER TABLE "period_locks" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "period_locks" ALTER COLUMN "company_id" SET DEFAULT app_default_company_id();--> statement-breakpoint
ALTER TABLE "period_locks" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "categories_org_idx" ON "categories" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "transactions_org_date_idx" ON "transactions" USING btree ("organization_id","date");--> statement-breakpoint
CREATE INDEX "customers_org_idx" ON "customers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "vendors_org_idx" ON "vendors" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "products_org_idx" ON "products" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invoice_items_org_invoice_idx" ON "invoice_items" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_org_status_idx" ON "invoices" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "bill_items_org_bill_idx" ON "bill_items" USING btree ("organization_id","bill_id");--> statement-breakpoint
CREATE INDEX "bills_org_status_idx" ON "bills" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "journal_entries_org_status_idx" ON "journal_entries" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "journal_entry_lines_org_entry_idx" ON "journal_entry_lines" USING btree ("organization_id","journal_entry_id");--> statement-breakpoint
CREATE INDEX "employees_org_idx" ON "employees" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "payroll_items_org_run_idx" ON "payroll_items" USING btree ("organization_id","payroll_run_id");--> statement-breakpoint
CREATE INDEX "payroll_runs_org_idx" ON "payroll_runs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "depreciation_entries_org_asset_idx" ON "depreciation_entries" USING btree ("organization_id","asset_id");--> statement-breakpoint
CREATE INDEX "fixed_assets_org_idx" ON "fixed_assets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bank_accounts_org_idx" ON "bank_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "budgets_org_idx" ON "budgets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "audit_logs_org_idx" ON "audit_logs" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_org_company_period_key" UNIQUE("organization_id","company_id","period");