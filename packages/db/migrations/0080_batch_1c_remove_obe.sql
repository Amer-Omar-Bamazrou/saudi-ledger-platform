ALTER TABLE "migration_batches" DROP CONSTRAINT "migration_batches_clearing_journal_entry_id_journal_entries_id_fk";
--> statement-breakpoint
ALTER TABLE "migration_batches" DROP COLUMN "obe_residual_reason";--> statement-breakpoint
ALTER TABLE "migration_batches" DROP COLUMN "clearing_journal_entry_id";--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- Batch 1C (2026-09-20) — hand-written tail. THE OBE MECHANISM IS REMOVED.
-- Decision record: docs/product/batch-1c-migration-opening-balances-decision-pack.md
-- §16.12.2 (accountant A5): an opening position that does not balance BLOCKS
-- the migration; there is no landing account, no declared residual, no
-- clearing journal, no automatic classification.
--
-- 1. GUARD, FIRST: this migration REFUSES to run while any journal line
--    references the OPENING_BALANCE_EQUITY account or any entry carries
--    source = 'opening_clearing'. Nothing is migrated silently into another
--    account — a residual that reached a ledger is a fact for a person to
--    classify, not for a migration to move. The only rows of this kind ever
--    written were the Phase 3 test fixtures in throwaway test databases,
--    which are recreated from scratch (the test suite handles it; see
--    batch-1c-migration-commit.test.ts). A development database that has
--    such rows is a database with test residue: recreate it.
-- 2. The immutability trigger is REDEFINED without the two dropped columns
--    (plpgsql resolves NEW.<column> at execution time — a dropped column
--    would make every batch update fail with "record has no field"). The
--    0079 unlink-only exception is kept here unchanged; the Policy C commit
--    (0081) withdraws it.
-- 3. The line-level trigger that admitted the account to migration sources
--    is dropped with the account. The seam no longer has a migration-only
--    branch either; the account simply does not exist.
-- 4. `journal_entries.source` no longer admits 'opening_clearing'.
-- 5. The account is DELETED — the template row and every organisation's
--    category row. Not tombstoned (owner, 2026-09-20): an account that
--    exists but can never be posted to is a shape waiting for someone to
--    find a use for it. A category row still referenced by any FK makes the
--    DELETE fail loudly, which is the intended behaviour. This touches ROWS
--    of `categories` / `system_account_templates`, not their column sets, so
--    `seed_org_chart_of_accounts()` needs no redefinition
--    (tests/org-seed-trigger.test.ts compares columns).
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE n_lines int; n_clearing int;
BEGIN
  SELECT count(*) INTO n_lines
    FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
   WHERE c.system_code = 'OPENING_BALANCE_EQUITY';
  SELECT count(*) INTO n_clearing FROM journal_entries WHERE source = 'opening_clearing';
  IF n_lines > 0 OR n_clearing > 0 THEN
    RAISE EXCEPTION 'migration 0080 refused: % journal line(s) on OPENING_BALANCE_EQUITY and % opening_clearing entr(ies) exist. Nothing is migrated silently into another account (accountant A5, 2026-09-20). A database with such rows holds test residue — recreate it; a real ledger with such rows is a fact for a person to classify before this migration runs.', n_lines, n_clearing
      USING ERRCODE = 'check_violation', CONSTRAINT = 'obe_residual_exists';
  END IF;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION refuse_committed_migration_change() RETURNS trigger AS $$
DECLARE
  b_status text;
  old_j jsonb;
  new_j jsonb;
  resolved_cols text[] := ARRAY['resolved_category_id', 'resolved_customer_id', 'resolved_vendor_id', 'resolved_invoice_id', 'resolved_bill_id', 'resolved_payment_id'];
  c text;
  unlink_only boolean;
BEGIN
  IF TG_TABLE_NAME = 'migration_batches' THEN
    IF OLD.status IN ('committed', 'reversed') THEN
      IF NEW.status NOT IN ('committed', 'reversed')
         OR NEW.source_system IS DISTINCT FROM OLD.source_system
         OR NEW.cutover_date IS DISTINCT FROM OLD.cutover_date
         OR NEW.opening_date IS DISTINCT FROM OLD.opening_date
         OR NEW.opening_journal_entry_id IS DISTINCT FROM OLD.opening_journal_entry_id
         OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
         OR NEW.committed_at IS DISTINCT FROM OLD.committed_at
         OR NEW.committed_by IS DISTINCT FROM OLD.committed_by
         OR NEW.vat_position IS DISTINCT FROM OLD.vat_position
         OR (OLD.status = 'reversed' AND NEW.status <> 'reversed')
         OR (OLD.reversal_journal_entry_id IS NOT NULL AND NEW.reversal_journal_entry_id IS DISTINCT FROM OLD.reversal_journal_entry_id)
      THEN
        RAISE EXCEPTION 'migration batch % is % and cannot be modified', OLD.id, OLD.status USING ERRCODE = 'check_violation', CONSTRAINT = 'migration_batch_immutable';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO b_status FROM migration_batches WHERE id = COALESCE(NEW.batch_id, OLD.batch_id);
  IF b_status IN ('committed', 'reversed') THEN
    IF TG_OP = 'UPDATE' AND b_status = 'committed' THEN
      old_j := to_jsonb(OLD);
      new_j := to_jsonb(NEW);
      unlink_only := true;
      FOREACH c IN ARRAY resolved_cols LOOP
        IF new_j ? c AND new_j -> c IS DISTINCT FROM old_j -> c AND new_j -> c <> 'null'::jsonb THEN
          unlink_only := false;
        END IF;
        old_j := old_j - c;
        new_j := new_j - c;
      END LOOP;
      IF unlink_only AND old_j = new_j THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'migration batch % is % — staging rows are immutable', COALESCE(NEW.batch_id, OLD.batch_id), b_status USING ERRCODE = 'check_violation', CONSTRAINT = 'migration_rows_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS refuse_migration_only_account_line_trg ON "journal_entry_lines";--> statement-breakpoint
DROP FUNCTION IF EXISTS refuse_migration_only_account_line();--> statement-breakpoint

ALTER TABLE "journal_entries" DROP CONSTRAINT IF EXISTS "journal_entries_source_chk";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_chk" CHECK (source IS NULL OR source IN ('opening', 'opening_reversal'));--> statement-breakpoint

DELETE FROM "categories" WHERE system_code = 'OPENING_BALANCE_EQUITY';--> statement-breakpoint
DELETE FROM "system_account_templates" WHERE code = 'OPENING_BALANCE_EQUITY';
