ALTER TABLE "employees" ADD COLUMN "gosi_regime" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "gosi_regime_set_by" integer;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "gosi_regime_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "gosi_regime_basis" text;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "gosi_regime" text;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "gosi_wage_base" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "gosi_employee_rate" numeric(7, 4);--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "gosi_employer_rate" numeric(7, 4);--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "gosi_paid_at" text;--> statement-breakpoint
-- 🔴 Hand-written (drizzle does not track CHECKs; the 0071 precedent). Do not drop on a snapshot diff.
-- GOSI (Phase 18, owner 2026-10-26 night): the regime a Saudi employee contributes under, set by the
-- employer from contribution history. NULL = not stated (a payroll run refuses it; never defaulted).
ALTER TABLE "employees" ADD CONSTRAINT "employees_gosi_regime_chk"
  CHECK ("gosi_regime" IS NULL OR "gosi_regime" IN ('law_1421h', 'law_2024'));--> statement-breakpoint
-- What a payroll line was computed WITH. All four set (lines computed from 0127 on) or all four NULL
-- (lines computed before 0127, never back-filled) — never part of a snapshot.
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_gosi_regime_chk"
  CHECK ("gosi_regime" IS NULL OR "gosi_regime" IN ('law_1421h', 'law_2024', 'non_saudi'));--> statement-breakpoint
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_gosi_snapshot_whole_chk"
  CHECK (
    ("gosi_regime" IS NULL AND "gosi_wage_base" IS NULL AND "gosi_employee_rate" IS NULL AND "gosi_employer_rate" IS NULL)
    OR ("gosi_regime" IS NOT NULL AND "gosi_wage_base" IS NOT NULL AND "gosi_employee_rate" IS NOT NULL AND "gosi_employer_rate" IS NOT NULL)
  );--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_gosi_paid_at_chk"
  CHECK ("gosi_paid_at" IS NULL OR "gosi_paid_at" ~ '^\d{4}-\d{2}-\d{2}$');
