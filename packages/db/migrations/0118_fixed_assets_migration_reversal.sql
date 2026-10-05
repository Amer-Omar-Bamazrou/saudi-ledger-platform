ALTER TABLE "fixed_assets" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD COLUMN "reversed_by_migration_batch_id" integer;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD COLUMN "replaces_asset_id" integer;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_replaces_asset_id_fixed_assets_id_fk" FOREIGN KEY ("replaces_asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Accountant Q3 (2026-10-05) — Option A: a migration batch's reversal MARKS the
-- fixed assets it created reversed. Record: docs/product/phase-16-17-tax-
-- treasury-decision-pack.md §14.3; the Batch 1C invariants A4/A5 (§16.12).
--
-- Before: the reversal mirrored the opening journal and marked invoices, bills
-- and deposits, but left the batch's assets IN SERVICE — a replacement batch
-- added a second copy and every run depreciated both (D-13, QA-14; register ≠
-- GL; feeding Zakat and the Art. 17 pool).
--
-- Made structural, the Policy C pattern (0081/0086):
--   1. `reversed` — a terminal status beside `disposed`, with a marker pair
--      (reversed_at, reversed_by_migration_batch_id) written ONCE, by the
--      committed batch that created the asset, on a migrated asset, changing
--      nothing else; then frozen whole. NOT a disposal: no proceeds, no gain or
--      loss, no disposal row.
--   2. 🔴 no schedule row is planned or posted for an asset OUT of the books
--      (reversed, disposed, cancelled) — no run, no catch-up and no caller that
--      skips the service can depreciate a reversed asset.
--   3. one LIVE migrated asset per company and source id — a replacement batch
--      cannot leave a duplicate active asset; its asset names the reversed one
--      it replaces (replaces_asset_id).
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_reversed_by_batch_fk" FOREIGN KEY ("reversed_by_migration_batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" DROP CONSTRAINT "fixed_assets_status_chk";--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_status_chk" CHECK (status IN ('draft', 'in_service', 'disposed', 'cancelled', 'reversed'));--> statement-breakpoint
ALTER TABLE "fixed_assets" DROP CONSTRAINT "fixed_assets_state_chk";--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_state_chk" CHECK (
  (status IN ('draft', 'cancelled') AND capitalisation_journal_entry_id IS NULL AND disposal_date IS NULL)
  OR (status = 'in_service' AND available_for_use_date IS NOT NULL AND capitalisation_journal_entry_id IS NOT NULL AND disposal_date IS NULL)
  OR (status = 'disposed' AND available_for_use_date IS NOT NULL AND capitalisation_journal_entry_id IS NOT NULL AND disposal_date IS NOT NULL)
  -- a reversed migrated asset keeps its capitalisation entry (the opening journal) as provenance, and was never disposed of
  OR (status = 'reversed' AND source = 'migration' AND available_for_use_date IS NOT NULL AND capitalisation_journal_entry_id IS NOT NULL AND disposal_date IS NULL)
);--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_reversed_marker_chk" CHECK (
  (reversed_at IS NULL) = (reversed_by_migration_batch_id IS NULL) AND (status = 'reversed') = (reversed_at IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_replaces_chk" CHECK (replaces_asset_id IS NULL OR (source = 'migration' AND replaces_asset_id <> id));--> statement-breakpoint
-- 3. one LIVE migrated asset per company and source id
CREATE UNIQUE INDEX "fixed_assets_migrated_source_live_unq" ON "fixed_assets" USING btree ("company_id", "source_reference")
  WHERE source = 'migration' AND status <> 'reversed';--> statement-breakpoint

-- 1. the marker: once, by the committed batch that created the asset, nothing else changing; then frozen whole
CREATE OR REPLACE FUNCTION refuse_capitalised_asset_fact_change() RETURNS trigger AS $$
DECLARE b_status text;
BEGIN
  IF OLD.status IN ('cancelled', 'disposed', 'reversed') THEN
    IF (to_jsonb(OLD) - 'updated_at') <> (to_jsonb(NEW) - 'updated_at') THEN
      RAISE EXCEPTION 'asset % is % and frozen', OLD.id, OLD.status USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'in_service' AND NEW.status = 'reversed' THEN
    IF OLD.source <> 'migration' OR OLD.migration_batch_id IS NULL OR NEW.reversed_by_migration_batch_id IS DISTINCT FROM OLD.migration_batch_id OR NEW.reversed_at IS NULL THEN
      RAISE EXCEPTION 'asset % can be marked reversed only by the reversal of the migration batch that created it (batch %)', OLD.id, OLD.migration_batch_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_reversal_marker';
    END IF;
    SELECT status INTO b_status FROM migration_batches WHERE id = NEW.reversed_by_migration_batch_id;
    IF b_status IS DISTINCT FROM 'committed' THEN
      RAISE EXCEPTION 'asset %: migration batch % is %, not committed — only its reversal marks the asset', OLD.id, NEW.reversed_by_migration_batch_id, coalesce(b_status, 'missing')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_reversal_marker';
    END IF;
    IF (to_jsonb(NEW) - 'status' - 'reversed_at' - 'reversed_by_migration_batch_id' - 'updated_at')
       <> (to_jsonb(OLD) - 'status' - 'reversed_at' - 'reversed_by_migration_batch_id' - 'updated_at') THEN
      RAISE EXCEPTION 'asset %: a reversal marks the asset and changes nothing else', OLD.id USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_reversal_marker';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.reversed_at IS DISTINCT FROM OLD.reversed_at OR NEW.reversed_by_migration_batch_id IS DISTINCT FROM OLD.reversed_by_migration_batch_id
     OR NEW.replaces_asset_id IS DISTINCT FROM OLD.replaces_asset_id THEN
    RAISE EXCEPTION 'asset %: its reversal marker and its replacement link are facts of record', OLD.id USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_reversal_marker';
  END IF;
  IF OLD.status = 'in_service' THEN
    IF NEW.cost <> OLD.cost OR NEW.acquisition_date <> OLD.acquisition_date OR NEW.available_for_use_date IS DISTINCT FROM OLD.available_for_use_date
       OR NEW.source <> OLD.source OR NEW.bill_id IS DISTINCT FROM OLD.bill_id OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
       OR NEW.migration_batch_id IS DISTINCT FROM OLD.migration_batch_id
       OR NEW.income_tax_group <> OLD.income_tax_group OR NEW.vat_capital_asset_class <> OLD.vat_capital_asset_class
       OR NEW.vat_input_tax_amount <> OLD.vat_input_tax_amount OR NEW.vat_initial_recovery_pct <> OLD.vat_initial_recovery_pct
       OR NEW.opening_accumulated_depreciation <> OLD.opening_accumulated_depreciation OR NEW.opening_periods_booked <> OLD.opening_periods_booked
       OR NEW.capitalisation_journal_entry_id IS DISTINCT FROM OLD.capitalisation_journal_entry_id
       OR NEW.category_id <> OLD.category_id OR NEW.asset_number <> OLD.asset_number
       OR NEW.status NOT IN ('in_service', 'disposed') THEN
      RAISE EXCEPTION 'asset % is in service: its cost, dates, provenance, tax group, VAT facts, category, number and entry are facts of record (a correction is a new act, never an edit)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_capitalised_facts_frozen';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- an asset is never BORN reversed; a replacement names a reversed migrated asset of its own company
CREATE OR REPLACE FUNCTION fixed_assets_birth_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  IF NEW.status = 'reversed' OR NEW.reversed_at IS NOT NULL OR NEW.reversed_by_migration_batch_id IS NOT NULL THEN
    RAISE EXCEPTION 'an asset is never created reversed: only its batch''s reversal marks it' USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_reversal_marker';
  END IF;
  IF NEW.replaces_asset_id IS NOT NULL THEN
    SELECT id, company_id, source, status INTO r FROM fixed_assets WHERE id = NEW.replaces_asset_id;
    IF r.id IS NULL OR r.company_id IS DISTINCT FROM NEW.company_id OR r.source <> 'migration' OR r.status <> 'reversed' THEN
      RAISE EXCEPTION 'asset: % is not a reversed migrated asset of this company; a replacement replaces only that', NEW.replaces_asset_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_replacement_link';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION fixed_assets_birth_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER fixed_assets_birth_admit BEFORE INSERT ON "fixed_assets" FOR EACH ROW EXECUTE FUNCTION fixed_assets_birth_admit();--> statement-breakpoint

-- 2. 🔴 no schedule row is planned or posted for an asset OUT of the books (the service depreciates only one in service)
CREATE OR REPLACE FUNCTION depreciation_refused_out_of_books() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st text;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.journal_entry_id IS NULL AND NEW.journal_entry_id IS NOT NULL) THEN RETURN NEW; END IF;
  SELECT status INTO st FROM fixed_assets WHERE id = NEW.asset_id;
  IF st IS NULL OR st IN ('reversed', 'disposed', 'cancelled') THEN
    RAISE EXCEPTION 'asset % is %: an asset out of the books is never depreciated (planned or posted)', NEW.asset_id, coalesce(st, 'missing')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'depreciation_asset_out_of_books';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION depreciation_refused_out_of_books() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER asset_depreciation_schedule_out_of_books_trg BEFORE INSERT OR UPDATE ON "asset_depreciation_schedule"
  FOR EACH ROW EXECUTE FUNCTION depreciation_refused_out_of_books();
