-- 🔴 19B S2a (v4 §10, D8 O2; owner 2026-11-22): PAY NOT SET.
-- A bookkeeper creates an employee without pay; an accountant or admin sets it later. NULL basic_salary = pay not set
-- (the 0049 CHECK basic_salary >= 0 admits NULL). A payroll run names such employees in left_out and writes no line for
-- them: nothing is computed at zero. Existing rows are unchanged: every employee written before this has a salary.
ALTER TABLE "employees" ALTER COLUMN "basic_salary" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "left_out" jsonb DEFAULT '[]'::jsonb NOT NULL;