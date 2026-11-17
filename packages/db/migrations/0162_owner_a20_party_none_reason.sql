-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 owner decision A20 (2026-11-16) — "NO PARTY" IS A STATEMENT,
-- STORED WITH THE LINE.
--
-- A line on a party account (SECURITY_DEPOSITS_HELD, UNIDENTIFIED_RECEIPTS)
-- names its customer, or states why there is none. The receipt paths already
-- STATE the reason (the posting seam's `{ type: "none", reason }`) but it was
-- recorded nowhere; the manual journal could not state it at all. The reason
-- is now a column of the line, written by the seam and by the manual journal.
--
-- The CHECK keeps it meaningful: a reason only on a line naming no customer
-- and no vendor, and never empty or unbounded. Existing lines keep NULL.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "journal_entry_lines" ADD COLUMN "party_none_reason" text;--> statement-breakpoint
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_party_none_reason_chk"
  CHECK ("party_none_reason" IS NULL
         OR ("customer_id" IS NULL AND "vendor_id" IS NULL AND length(btrim("party_none_reason")) BETWEEN 1 AND 500));
