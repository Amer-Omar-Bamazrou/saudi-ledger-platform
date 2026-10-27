-- 🔴 T1e: the four period-record tables of 0130 go with their organization or company if an operator deletes it
-- (no product path deletes a company; the request's role deletes none of these rows — 0130 revokes it).
ALTER TABLE "period_lock_events" DROP CONSTRAINT "period_lock_events_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "period_lock_events" DROP CONSTRAINT "period_lock_events_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "statement_authorisations" DROP CONSTRAINT "statement_authorisations_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "statement_authorisations" DROP CONSTRAINT "statement_authorisations_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "vat_return_filings" DROP CONSTRAINT "vat_return_filings_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "vat_return_filings" DROP CONSTRAINT "vat_return_filings_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "zakat_income_tax_filings" DROP CONSTRAINT "zakat_income_tax_filings_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "zakat_income_tax_filings" DROP CONSTRAINT "zakat_income_tax_filings_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "period_lock_events" ADD CONSTRAINT "period_lock_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_lock_events" ADD CONSTRAINT "period_lock_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_authorisations" ADD CONSTRAINT "statement_authorisations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_authorisations" ADD CONSTRAINT "statement_authorisations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_return_filings" ADD CONSTRAINT "vat_return_filings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_return_filings" ADD CONSTRAINT "vat_return_filings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zakat_income_tax_filings" ADD CONSTRAINT "zakat_income_tax_filings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zakat_income_tax_filings" ADD CONSTRAINT "zakat_income_tax_filings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;