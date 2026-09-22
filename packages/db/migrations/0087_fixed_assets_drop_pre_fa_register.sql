DROP TABLE "depreciation_entries" CASCADE;--> statement-breakpoint
DROP TABLE "fixed_assets" CASCADE;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "foreign_ownership_pct" numeric(5, 2);