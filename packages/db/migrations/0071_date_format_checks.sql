-- ═══════════════════════════════════════════════════════════════════════════
-- THE DATE COLUMNS GET A DB-LEVEL FLOOR (2026-09-15).
--
-- journal_entries.date = '' passed THREE application guards (the falsy-
-- skipped assertDateString and checkPeriodOpen at create, and NOT NULL —
-- which an empty string satisfies) and would have posted an entry no
-- date-ranged report shows and no period lock examined. The write boundary
-- is fixed; three passed guards is the argument that the boundary must not
-- be the only thing between the application and the column.
--
-- invoices.date and bills.date share the column type, the writers' shape and
-- the class, so all three get the identical floor.
--
-- 🔴 The audit of existing rows that precedes this constraint — every table,
-- every environment, with its counts and its frame — is recorded in
-- docs/history/findings-and-lessons.md, "THE DATE-COLUMN AUDIT" (2026-09-15).
-- This file states no result of its own: a migration comment is a claim, and
-- the record is where the evidence lives.
--
-- Hand-written (the 0020/0049/0062 precedent: CHECKs drizzle does not
-- express); noted on the three schema columns so a snapshot diff cannot read
-- them as droppable. Shape only — the calendar check (2026-02-30) stays with
-- assertDateString, which rejects it explicitly.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "journal_entries" DROP CONSTRAINT IF EXISTS "journal_entries_date_format_chk";
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_date_format_chk"
  CHECK (date ~ '^\d{4}-\d{2}-\d{2}$');--> statement-breakpoint

ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_date_format_chk";
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_date_format_chk"
  CHECK (date ~ '^\d{4}-\d{2}-\d{2}$');--> statement-breakpoint

ALTER TABLE "bills" DROP CONSTRAINT IF EXISTS "bills_date_format_chk";
ALTER TABLE "bills"
  ADD CONSTRAINT "bills_date_format_chk"
  CHECK (date ~ '^\d{4}-\d{2}-\d{2}$');
