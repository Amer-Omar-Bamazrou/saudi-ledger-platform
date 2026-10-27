ALTER TABLE "employees" ADD COLUMN "gosi_in_kind_housing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "gosi_in_kind_housing_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "gosi_in_kind_housing" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "gosi_pension_floor_wage" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "gosi_service_days" integer;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "gosi_period_days" integer;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "gosi_wage_fixed_period" text;--> statement-breakpoint
-- 🔴 Hand-written (drizzle does not track CHECKs; the 0071 precedent). Do not drop on a snapshot diff.
-- GO-13 (Phase 18, owner 2026-10-27): "exempt" means the Governor exempted the employee's IN-KIND housing,
-- so it means nothing without in-kind housing.
ALTER TABLE "employees" ADD CONSTRAINT "employees_gosi_in_kind_exempt_chk"
  CHECK (NOT "gosi_in_kind_housing_exempt" OR "gosi_in_kind_housing");--> statement-breakpoint
-- What else a payroll line used (GO-10..GO-13), each NULL where its rule did not apply. A line computed
-- before 0127 has no GOSI record at all, so it carries none of these either.
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_gosi_rules_need_record_chk"
  CHECK ("gosi_regime" IS NOT NULL OR ("gosi_in_kind_housing" IS NULL AND "gosi_pension_floor_wage" IS NULL
    AND "gosi_service_days" IS NULL AND "gosi_period_days" IS NULL AND "gosi_wage_fixed_period" IS NULL));--> statement-breakpoint
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_gosi_amounts_chk"
  CHECK (("gosi_in_kind_housing" IS NULL OR "gosi_in_kind_housing" > 0)
    AND ("gosi_pension_floor_wage" IS NULL OR "gosi_pension_floor_wage" > "gosi_wage_base"));--> statement-breakpoint
-- A joining or leaving month: both day counts or neither, a part of a real month.
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_gosi_service_days_chk"
  CHECK (("gosi_service_days" IS NULL AND "gosi_period_days" IS NULL)
    OR ("gosi_period_days" BETWEEN 28 AND 31 AND "gosi_service_days" BETWEEN 1 AND "gosi_period_days" - 1));--> statement-breakpoint
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_gosi_wage_fixed_period_chk"
  CHECK ("gosi_wage_fixed_period" IS NULL OR "gosi_wage_fixed_period" ~ '^\d{4}-(0[1-9]|1[0-2])$');
