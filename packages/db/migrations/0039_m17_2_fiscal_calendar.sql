-- ═══════════════════════════════════════════════════════════════════════════
-- M17.2 — the fiscal year becomes real (owner decision Q3)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `companies.fiscal_year_start` has existed since M11.6 and has been applied by
-- NOTHING: every report used calendar periods, and the Company Settings page
-- told the user so ("Stored for future use"). It is the longest-standing
-- example in this codebase of a shape whose consumer never arrived.
--
-- Zakat is the consumer. A Zakat base is a balance measured AS OF a fiscal year
-- end, and the Gregorian rate adjustment is a DAY COUNT between two fiscal
-- boundaries — neither is expressible until the platform can say what a fiscal
-- year is for a given company. Hence Q3 calling fiscal-year support a
-- prerequisite rather than a companion feature.
--
-- This migration adds the missing half: WHICH CALENDAR the fiscal year is
-- expressed in.
--
-- 🔴 The new column changes the MEANING of the old one. `fiscal_year_start` is
-- a month number 1–12 in `fiscal_calendar`: under 'gregorian' 1 = January,
-- under 'hijri' 1 = Muharram. They must be read together. A second column
-- (separate gregorian/hijri start months) was rejected deliberately: switching
-- calendars would leave a stale value behind, and a stale start month is a
-- wrong year boundary that nothing would flag.
--
-- 'hijri' means UMM AL-QURA — the Saudi civil calendar — and not the three
-- other islamic calendars ICU exposes, which disagree with it by a day or two.
-- See apps/api/src/lib/hijriCalendar.ts.

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "fiscal_calendar" varchar(20) NOT NULL DEFAULT 'gregorian';--> statement-breakpoint

-- Existing tenants effectively had a Gregorian fiscal year: it is the only
-- behaviour the platform has ever implemented. The DEFAULT above back-fills
-- them to exactly what they had, so nobody's year silently moves.

-- The write-boundary lesson: an invariant three writers could violate belongs
-- in a CHECK, not in per-path validation. The service validates too (for a
-- readable 400); this is what makes the value trustworthy for every reader.
ALTER TABLE "companies" ADD CONSTRAINT "companies_fiscal_calendar_values"
  CHECK ("fiscal_calendar" IN ('gregorian','hijri'));--> statement-breakpoint

-- `fiscal_year_start` has been NOT NULL DEFAULT 1 since M11.6 but never had its
-- range enforced. It is about to be resolved into real date boundaries, so an
-- out-of-range month stops being cosmetic and starts producing a wrong — not
-- absent — fiscal year.
ALTER TABLE "companies" ADD CONSTRAINT "companies_fiscal_year_start_range"
  CHECK ("fiscal_year_start" BETWEEN 1 AND 12);
