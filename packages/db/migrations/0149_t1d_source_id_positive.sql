-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 R-3 — AC-5, memo §2f (owner 2026-11-01; register §11.90).
--  · T1d (0129): a non-manual source names its row. A row is named by a
--    POSITIVE id — serials start at 1 — so a zero or negative source_id was a
--    claim of provenance that pointed at nothing, and three fixtures wrote one.
--    The CHECK's third arm gains `source_id > 0`; the other two arms are as
--    they were (manual / recurring carry no id).
--  · The pre-check refuses on DATA and repairs nothing: any row with a
--    non-positive source_id stops the migration and is reported (a safety
--    stop under the round's rules). A fresh database has none.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE bad integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_entries_source_id_chk') THEN
    RAISE EXCEPTION 'pre-check REFUSED: journal_entries_source_id_chk (0129) is not present; nothing was changed';
  END IF;
  SELECT count(*) INTO bad FROM journal_entries WHERE source_id IS NOT NULL AND source_id <= 0;
  IF bad > 0 THEN
    RAISE EXCEPTION 'pre-check REFUSED: % journal entr(y/ies) carry a non-positive source_id; nothing was changed — report it, do not repair it here', bad;
  END IF;
  RAISE NOTICE 'pre-check: journal_entries_source_id_chk present; no row carries a non-positive source_id';
END $$;--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_id_chk";--> statement-breakpoint
-- 🔴 Hand-written (drizzle does not track CHECKs; the 0071 precedent). Do not drop on a snapshot diff.
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_id_chk" CHECK (
  (source_type IS NULL AND source_id IS NULL)
  OR (source_type IN ('manual', 'recurring') AND source_id IS NULL)
  OR (source_type NOT IN ('manual', 'recurring') AND source_id IS NOT NULL AND source_id > 0)
);
