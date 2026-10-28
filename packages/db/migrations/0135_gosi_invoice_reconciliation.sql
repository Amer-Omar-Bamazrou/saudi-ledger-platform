-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 GOSI decisions 21 and 22 (owner 2026-10-27; decision 21's scope corrected
-- the same day). Register §11.36.
--  · payroll_runs.gosi_invoiced_amount / gosi_invoice_reference: what GOSI
--    INVOICED and the bank paid, when it differs from the accrual; the
--    difference is shown on the run as a reconciling item, never posted.
--  · payroll_items.gosi_hazards_floor_open: a non-Saudi line below the 1421H
--    Regulation Art. 19(1) SAR 400 occupational-hazards minimum — a WARNING
--    only, an open GOSI question; no figure changes because of it.
-- Existing rows: no invoiced amount (the accrual was paid) and no warning; no
-- row is rewritten. The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payroll_runs' AND column_name = 'gosi_paid_at') THEN
    RAISE EXCEPTION 'pre-check REFUSED: payroll_runs.gosi_paid_at (the GOSI payment step, 0127) does not exist; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: the GOSI payment step exists';
END $$;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "gosi_hazards_floor_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "gosi_invoiced_amount" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "gosi_invoice_reference" text;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_gosi_invoiced_positive_chk" CHECK (gosi_invoiced_amount IS NULL OR gosi_invoiced_amount > 0);
