-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 G4a — owner decision 16 (2026-10-27), with decision 17's "never
-- reverse WHT in a later month": a FILED WHT month is corrected in its own
-- statement (an amendment), never carried in a later month's return. Register
-- §11.42. It answers DR-40 (T6/V-8) and replaces the subsequent-period route.
--  · The services refuse the route by name (409 wht_correct_original_month);
--    these triggers refuse a NEW row carrying it, whatever path writes it.
--  · Rows recorded before 0139 keep their treatment: history is not rewritten,
--    and the CHECKs still admit the value for them.
-- Each trigger is named to fire BEFORE the table's admit trigger (Postgres runs
-- same-event triggers in name order), so the refusal names this rule. An
-- ordinary trigger: replica mode is the only bypass, as for every guard here.
-- New triggers only; the pre-check refuses, and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.wht_withholdings') IS NULL OR to_regclass('public.wht_corrections') IS NULL THEN
    RAISE EXCEPTION 'pre-check REFUSED: wht_withholdings or wht_corrections does not exist; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'wht_withholdings' AND column_name = 'filed_month_treatment')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'wht_corrections' AND column_name = 'filed_month_treatment') THEN
    RAISE EXCEPTION 'pre-check REFUSED: filed_month_treatment (Q1, 0117) is missing; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: both tables carry filed_month_treatment';
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION wht_refuse_later_month() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.filed_month_treatment = 'subsequent_period' THEN
    RAISE EXCEPTION 'owner decision 16: a filed WHT month is corrected in its original month (an amendment); a later month never carries it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER wht_withholdings_a_original_month BEFORE INSERT ON "wht_withholdings"
  FOR EACH ROW EXECUTE FUNCTION wht_refuse_later_month();--> statement-breakpoint
CREATE TRIGGER wht_corrections_a_original_month BEFORE INSERT ON "wht_corrections"
  FOR EACH ROW EXECUTE FUNCTION wht_refuse_later_month();
