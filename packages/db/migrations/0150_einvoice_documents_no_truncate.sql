-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 R-4 — AC-4, memo §2g (owner 2026-11-01; register §11.93).
--  · PR C (0125) freezes an e-invoice document's signed columns and refuses
--    its deletion, by trigger, for every role. It left TRUNCATE: the owner
--    holds the privilege and no BEFORE TRUNCATE trigger existed, so the table
--    of signed records could be emptied in one statement.
--  · This adds the statement trigger, on T1b's pattern (0132): a signed
--    record is never truncated; replica mode is the only bypass, as for the
--    audit tables. Grants are not changed.
-- Nothing is read or changed in the data. The pre-check refuses and repairs
-- nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'einvoice_documents_no_truncate_trg' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'pre-check REFUSED: trigger einvoice_documents_no_truncate_trg already exists; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'einvoice_documents_frozen_trg' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'pre-check REFUSED: einvoice_documents_frozen_trg (0125) is not present; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: 0125''s freeze is present and no TRUNCATE guard exists yet';
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_einvoice_document_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE on %: e-invoice documents are signed records and are never truncated', TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = 'einvoice_document_frozen';
END $$;--> statement-breakpoint
CREATE TRIGGER einvoice_documents_no_truncate_trg BEFORE TRUNCATE ON "einvoice_documents" FOR EACH STATEMENT EXECUTE FUNCTION guard_einvoice_document_truncate();
