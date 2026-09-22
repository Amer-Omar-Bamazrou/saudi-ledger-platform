ALTER TABLE "invoices" ADD COLUMN "opening_source_uuid" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "opening_einvoicing_status" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "opening_correction_journal_entry_id" integer;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "opening_correction_journal_entry_id" integer;--> statement-breakpoint
ALTER TABLE "migration_open_items" ADD COLUMN "source_uuid" text;--> statement-breakpoint
ALTER TABLE "migration_open_items" ADD COLUMN "einvoicing_status" text;--> statement-breakpoint
ALTER TABLE "migration_open_items" ADD CONSTRAINT "migration_open_items_einvoicing_status_chk" CHECK (einvoicing_status IS NULL OR einvoicing_status IN ('cleared', 'reported', 'pre_einvoicing'));--> statement-breakpoint
ALTER TABLE "migration_open_items" ADD CONSTRAINT "migration_open_items_identity_ar_only_chk" CHECK (item_type = 'ar' OR (source_uuid IS NULL AND einvoicing_status IS NULL));--> statement-breakpoint
ALTER TABLE "migration_open_items" ADD CONSTRAINT "migration_open_items_identity_uuid_chk" CHECK (einvoicing_status IS NULL OR einvoicing_status = 'pre_einvoicing' OR source_uuid IS NOT NULL);--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- Migration follow-ups (2026-09-22), on the accountant's answers 3 and 5 and
-- Batch 1C's A4: the previous solution's e-invoicing identity travels with an
-- opening receivable; an item-level correction's other side is retained
-- earnings; a migrated bad-debt relief is a structured fact.
-- Decision record: docs/product/batch-1c-migration-opening-balances-decision-pack.md §17.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The correction entry is a journal source readers key on ─────────────
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_chk";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_chk" CHECK (source IS NULL OR source IN ('opening', 'opening_reversal', 'opening_correction'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_opening_correction_je_fk" FOREIGN KEY ("opening_correction_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_opening_correction_je_fk" FOREIGN KEY ("opening_correction_journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT;--> statement-breakpoint
-- a correction entry lives on an opening row only, and only on one that was reversed by it (the original)
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_opening_correction_opening_only_chk" CHECK (opening_correction_journal_entry_id IS NULL OR (is_opening AND reversed_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_opening_correction_opening_only_chk" CHECK (opening_correction_journal_entry_id IS NULL OR (is_opening AND reversed_at IS NOT NULL));--> statement-breakpoint

-- ── 2. The opening receivable's e-invoicing identity: opening only, set ONCE ─
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_opening_identity_opening_only_chk" CHECK ((opening_source_uuid IS NULL AND opening_einvoicing_status IS NULL) OR is_opening);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_opening_einvoicing_status_chk" CHECK (opening_einvoicing_status IS NULL OR opening_einvoicing_status IN ('cleared', 'reported', 'pre_einvoicing'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_opening_identity_uuid_chk" CHECK (opening_einvoicing_status IS NULL OR opening_einvoicing_status = 'pre_einvoicing' OR opening_source_uuid IS NOT NULL);--> statement-breakpoint
CREATE OR REPLACE FUNCTION refuse_opening_identity_change() RETURNS trigger AS $$
BEGIN
  IF OLD.opening_einvoicing_status IS NOT NULL AND (NEW.opening_einvoicing_status IS DISTINCT FROM OLD.opening_einvoicing_status OR NEW.opening_source_uuid IS DISTINCT FROM OLD.opening_source_uuid) THEN
    RAISE EXCEPTION 'invoice % already carries its previous-system e-invoicing identity (% / %); an identity is recorded once and never changed', OLD.id, OLD.opening_einvoicing_status, OLD.opening_source_uuid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS invoices_opening_identity_trg ON "invoices";--> statement-breakpoint
CREATE TRIGGER invoices_opening_identity_trg BEFORE UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION refuse_opening_identity_change();--> statement-breakpoint

-- ── 3. A MIGRATED bad-debt relief may lack a date and an amount (the previous system's facts); a RECORDED one never does ─
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_bad_debt_relief_chk";--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_bad_debt_relief_chk" CHECK (
  (bad_debt_relief_source IS NULL AND bad_debt_relief_claimed_on IS NULL AND bad_debt_relief_vat_amount IS NULL AND bad_debt_relief_journal_entry_id IS NULL)
  OR (bad_debt_relief_source = 'recorded' AND bad_debt_relief_claimed_on IS NOT NULL AND bad_debt_relief_vat_amount IS NOT NULL AND bad_debt_relief_vat_amount >= 0 AND bad_debt_relief_journal_entry_id IS NOT NULL)
  OR (bad_debt_relief_source = 'migrated' AND is_opening AND bad_debt_relief_journal_entry_id IS NULL AND (bad_debt_relief_vat_amount IS NULL OR bad_debt_relief_vat_amount >= 0))
);
--> statement-breakpoint
-- ── 4. ONE LIVE ledger row per staged item (was: one row ever). An item-level
--    correction chains reversed originals and a live replacement under the same
--    staging identity; the invariant that matters is that exactly one is live.
DROP INDEX IF EXISTS "invoices_migration_open_item_unq";--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_migration_open_item_unq" ON "invoices" USING btree ("migration_open_item_id") WHERE migration_open_item_id IS NOT NULL AND reversed_at IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "bills_migration_open_item_unq";--> statement-breakpoint
CREATE UNIQUE INDEX "bills_migration_open_item_unq" ON "bills" USING btree ("migration_open_item_id") WHERE migration_open_item_id IS NOT NULL AND reversed_at IS NULL;
--> statement-breakpoint
-- ── 5. The reversal marker admits the CHAIN. Batch 1C's trigger linked a row
--    to its batch through the staging row's resolved id — the row the staging
--    row PRODUCED. A replacement in an item-level correction chain carries the
--    same staging identity (migration_open_item_id) without being the
--    resolved row, and a second correction must mark IT reversed by the same
--    batch. Either link is the staging row's own identity; nothing else is.
CREATE OR REPLACE FUNCTION refuse_opening_reversal_marker() RETURNS trigger AS $$
DECLARE
  b_status text;
  linked boolean;
  target_reversed boolean;
  old_j jsonb;
  new_j jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reversed_at IS NOT NULL OR NEW.reversed_by_migration_batch_id IS NOT NULL THEN
      RAISE EXCEPTION 'a document is never created already reversed' USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_reversal_marker';
    END IF;
  ELSE
    IF OLD.reversed_at IS NOT NULL THEN
      -- FROZEN: a reversed opening item is history. Nothing on it moves.
      old_j := to_jsonb(OLD); new_j := to_jsonb(NEW);
      IF old_j <> new_j THEN
        RAISE EXCEPTION '% % is a reversed opening item and is frozen: a correction is a new record, never an edit (Policy C, pack §16.12.1)', TG_TABLE_NAME, OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_reversed_frozen';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.reversed_at IS NOT NULL THEN
      IF NOT NEW.is_opening THEN
        RAISE EXCEPTION '% % is not an opening item; only an opening item can be marked reversed by a migration', TG_TABLE_NAME, NEW.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_reversal_marker';
      END IF;
      -- Only the batch whose staging row PRODUCED this row — or whose staging row this row REPLACES under (a correction chain) — may mark it, and only while that batch is committed.
      IF TG_TABLE_NAME = 'invoices' THEN
        SELECT EXISTS (SELECT 1 FROM migration_open_items o WHERE o.batch_id = NEW.reversed_by_migration_batch_id AND (o.resolved_invoice_id = NEW.id OR (NEW.migration_open_item_id IS NOT NULL AND o.id = NEW.migration_open_item_id))) INTO linked;
      ELSE
        SELECT EXISTS (SELECT 1 FROM migration_open_items o WHERE o.batch_id = NEW.reversed_by_migration_batch_id AND (o.resolved_bill_id = NEW.id OR (NEW.migration_open_item_id IS NOT NULL AND o.id = NEW.migration_open_item_id))) INTO linked;
      END IF;
      SELECT status INTO b_status FROM migration_batches WHERE id = NEW.reversed_by_migration_batch_id;
      IF NOT coalesce(linked, false) OR b_status IS DISTINCT FROM 'committed' THEN
        RAISE EXCEPTION '% % can only be marked reversed by the committed migration batch that created it (batch %, status %)', TG_TABLE_NAME, NEW.id, NEW.reversed_by_migration_batch_id, coalesce(b_status, 'missing')
          USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_reversal_marker';
      END IF;
    END IF;
  END IF;
  -- A replacement link points at a REVERSED opening row of the same table.
  IF TG_TABLE_NAME = 'invoices' THEN
    IF NEW.replaces_invoice_id IS NOT NULL THEN
      SELECT (i.is_opening AND i.reversed_at IS NOT NULL) INTO target_reversed FROM invoices i WHERE i.id = NEW.replaces_invoice_id;
      IF NOT coalesce(target_reversed, false) THEN
        RAISE EXCEPTION 'invoice % can only replace a REVERSED opening invoice (target %)', NEW.id, NEW.replaces_invoice_id USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_replacement_target';
      END IF;
    END IF;
  ELSE
    IF NEW.replaces_bill_id IS NOT NULL THEN
      SELECT (b.is_opening AND b.reversed_at IS NOT NULL) INTO target_reversed FROM bills b WHERE b.id = NEW.replaces_bill_id;
      IF NOT coalesce(target_reversed, false) THEN
        RAISE EXCEPTION 'bill % can only replace a REVERSED opening bill (target %)', NEW.id, NEW.replaces_bill_id USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_replacement_target';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
