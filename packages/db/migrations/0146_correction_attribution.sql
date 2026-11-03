-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 H-18 — DR-15 (2026-10-27; register §11.73).
--  · A correction's ATTRIBUTION, on the mirror journal entry, as SNAPSHOTS
--    taken at reversal from the ORIGINAL entry's date: its IAS 8 kind
--    (error / estimate / policy, or NULL = unclassified), the fiscal year the
--    original belongs to, the statement authorisation covering that year, and
--    the filed original VAT return whose period holds the date.
--  · Snapshots, not references: the attribution outlives a later calendar
--    change or record, and needs no tenant→tenant key (G04).
--  · NULL on every existing entry, and on every entry that is not a mirror.
-- No existing value is changed. The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'journal_entries' AND column_name = 'correction_kind') THEN
    RAISE EXCEPTION 'pre-check REFUSED: journal_entries.correction_kind already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: journal_entries.correction_kind does not exist yet';
END $$;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "correction_kind" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "origin_fiscal_year_start" date;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "origin_fiscal_year_end" date;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "origin_authorised_on" date;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "origin_authorised_by" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "origin_vat_filing_reference" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_correction_kind_chk" CHECK ("journal_entries"."correction_kind" IS NULL OR "journal_entries"."correction_kind" IN ('error', 'estimate', 'policy'));
