-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 G1 — VAT invoices: owner decisions 6, 8 and 13 (2026-10-27).
-- Register §11.37.
--  · bills.vat_figures_confirmed_* / vat_figures_confirmation_note (decision 6):
--    the user's decision on a supplier invoice whose VAT is non-zero and below
--    15 % — who, when, which figures, and the evidence note. It counts only
--    while the bill shows the figures it confirmed.
--  · invoices.charge_substance / charge_event_date (decision 8): what a sales
--    debit note's extra charge IS; only a price change is issued as a debit
--    note, with the day the price changed.
--  · asset_disposals.withdrawal_reason / nominal_supply_calculation (decision
--    13): why a withdrawn asset left, and the full Art. 52(8) calculation.
-- Every column is new and NULL on existing rows; no row is rewritten. The
-- pre-check refuses and repairs nothing. A "required" rule binds NEW rows at
-- the write boundary (the services), so rows recorded before 0136 stay valid.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'document_type') THEN
    RAISE EXCEPTION 'pre-check REFUSED: invoices.document_type does not exist; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'asset_disposals' AND column_name = 'kind') THEN
    RAISE EXCEPTION 'pre-check REFUSED: asset_disposals.kind does not exist; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND (table_name, column_name) IN (('invoices', 'charge_substance'), ('bills', 'vat_figures_confirmed_vat'), ('asset_disposals', 'withdrawal_reason'))) THEN
    RAISE EXCEPTION 'pre-check REFUSED: a 0136 column already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: invoices.document_type and asset_disposals.kind exist; no 0136 column exists yet';
END $$;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "charge_substance" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "charge_event_date" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "vat_figures_confirmed_subtotal" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "vat_figures_confirmed_vat" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "vat_figures_confirmation_note" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "vat_figures_confirmed_by" integer;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "vat_figures_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD COLUMN "withdrawal_reason" text;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD COLUMN "nominal_supply_calculation" jsonb;--> statement-breakpoint
-- decision 8: only a price change is a debit note, and it names the day the price changed
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_charge_substance_chk" CHECK (
  (charge_substance IS NULL AND charge_event_date IS NULL)
  OR (document_type = 'debit_note' AND charge_substance = 'price_change' AND charge_event_date ~ '^\d{4}-\d{2}-\d{2}$')
);--> statement-breakpoint
-- decision 6: a confirmation is whole — the figures it confirmed, when, and a non-blank evidence note
ALTER TABLE "bills" ADD CONSTRAINT "bills_vat_figures_confirmation_chk" CHECK (
  (vat_figures_confirmed_at IS NULL AND vat_figures_confirmed_subtotal IS NULL AND vat_figures_confirmed_vat IS NULL
     AND vat_figures_confirmation_note IS NULL AND vat_figures_confirmed_by IS NULL)
  OR (vat_figures_confirmed_at IS NOT NULL AND vat_figures_confirmed_subtotal IS NOT NULL AND vat_figures_confirmed_vat IS NOT NULL
     AND length(btrim(coalesce(vat_figures_confirmation_note, ''))) > 0)
);--> statement-breakpoint
-- decision 13: the reason and the calculation belong to a withdrawal only
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_withdrawal_reason_chk" CHECK (
  withdrawal_reason IS NULL
  OR (kind = 'withdrawn' AND withdrawal_reason IN ('private_use', 'gift', 'cessation_of_taxable_use'))
);--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_nominal_calculation_chk" CHECK (
  nominal_supply_calculation IS NULL OR (kind = 'withdrawn' AND jsonb_typeof(nominal_supply_calculation) = 'object')
);
