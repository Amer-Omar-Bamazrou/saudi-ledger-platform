-- ═══════════════════════════════════════════════════════════════════════════
-- M20.0 — `fiscal_year_start` stops asserting January on the tenant's behalf
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 🔴 THE COLUMN HAS BEEN LYING SINCE M11.6. `integer NOT NULL DEFAULT 1` means
-- every company that never opened Settings is RECORDED as having declared a
-- January fiscal year — indistinguishable from a tenant who deliberately chose
-- January. The schema spoke for the tenant, and everything downstream (the
-- resolver, the settings page, and M20.1's report defaults) would have read
-- that fiction as a fact. The accountant research (2026-08-16) made this
-- concrete: fiscal years genuinely vary across real clients, so a wrong January
-- assertion is a wrong REPORT for real businesses, not a hypothetical.
--
-- Decision F8/F10 (owner, M17.1's `ownership_type` posture): NULL = NOT
-- DECLARED is a first-class state, there is no default, and the platform asks
-- rather than assumes. Reports fall back to a rolling last-12-months while
-- undeclared (F11) — a window that asserts nothing about anyone's year.
--
-- 🔴 EVERY EXISTING ROW IS NULLED, DELIBERATELY (F10, owner-decided). Each
-- holds `1`, and that `1` is not data — it is the old default. Preserving it
-- would preserve the fiction this migration exists to remove. There are no
-- customers; the two real tenants re-declare in Settings.
--
-- The 0039 range CHECK (BETWEEN 1 AND 12) already admits NULL — a NULL CHECK
-- result is not FALSE — so no constraint change is needed.

ALTER TABLE "companies" ALTER COLUMN "fiscal_year_start" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "fiscal_year_start" DROP NOT NULL;--> statement-breakpoint
UPDATE "companies" SET "fiscal_year_start" = NULL;
