-- ═════════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 audit (2026-11-09), finding A9 — G57's "pin period_lock_id".
--
-- A committed migration batch records the lock it placed on its opening month
-- (period_lock_id). 0081's immutability guard pinned the batch's other columns
-- but not this one, so a writer could clear it on a committed batch, and the
-- ordinary reopen — which refuses a migration's opening month by looking the
-- lock up through the batch — would then reopen it. The guard is redefined
-- with period_lock_id pinned; the reversal's own write (committed → reversed,
-- cleared to NULL) stays allowed. Nothing else in the function changes.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION refuse_committed_migration_change() RETURNS trigger AS $$
DECLARE b_status text;
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
         OR NEW.replaces_batch_id IS DISTINCT FROM OLD.replaces_batch_id
         -- 🔴 Phase 18 audit A9 (G57: "pin period_lock_id"): the opening month's lock is the batch's own; only
         -- the reversal's write (committed → reversed) clears it.
         OR (NEW.period_lock_id IS DISTINCT FROM OLD.period_lock_id
             AND NOT (OLD.status = 'committed' AND NEW.status = 'reversed' AND NEW.period_lock_id IS NULL))
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
    -- Resolved-id and ledger-number columns are written INSIDE the commit
    -- transaction, while the batch is still 'validated'; after commit nothing
    -- on a staging row moves — the links stay pointing at the reversed rows.
    RAISE EXCEPTION 'migration batch % is % — staging rows are immutable', COALESCE(NEW.batch_id, OLD.batch_id), b_status USING ERRCODE = 'check_violation', CONSTRAINT = 'migration_rows_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
