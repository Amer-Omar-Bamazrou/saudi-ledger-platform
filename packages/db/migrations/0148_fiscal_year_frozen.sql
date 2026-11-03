-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 R-2 — G23 (owner 2026-11-01; register §11.82, §11.85).
--  · The fiscal-year start — a month IN a calendar (M17.2) — is FIXED once the
--    company has any journal entry in the books (posted or reversed): every
--    posted figure was placed in a fiscal year by the start it was declared
--    with. A change of month, of calendar, or a withdrawal (NULL) is refused
--    at the database, whatever wrote it. The same month and calendar are not
--    a change. A draft or submitted entry freezes nothing.
--  · The service gives the same refusal, in English and Arabic, before this
--    trigger (409 fiscal_year_start_frozen); the trigger is the boundary.
-- No row is read or changed by this migration. The pre-check refuses and
-- repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'companies_fiscal_year_frozen' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'pre-check REFUSED: trigger companies_fiscal_year_frozen already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: trigger companies_fiscal_year_frozen does not exist yet';
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION companies_fiscal_year_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.fiscal_year_start IS DISTINCT FROM OLD.fiscal_year_start OR NEW.fiscal_calendar IS DISTINCT FROM OLD.fiscal_calendar)
     AND EXISTS (SELECT 1 FROM journal_entries e WHERE e.company_id = OLD.id AND e.status IN ('posted', 'reversed')) THEN
    RAISE EXCEPTION 'the fiscal-year start of company % cannot change: it has journal entries in the books, and every posted figure was placed in a fiscal year by the start it was declared with', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'company_fiscal_year_frozen';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER companies_fiscal_year_frozen BEFORE UPDATE OF fiscal_year_start, fiscal_calendar ON "companies" FOR EACH ROW EXECUTE FUNCTION companies_fiscal_year_frozen();
