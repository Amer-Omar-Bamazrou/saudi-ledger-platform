-- ═══════════════════════════════════════════════════════════════════════════
-- M17.1 — who owns the company (owner decision Q2)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Zakat v1 covers entities that are 100% Saudi/GCC-owned. Foreign and
-- mixed-ownership companies are assessed differently — the real treatment
-- apportions between Zakat (the Saudi/GCC share) and income tax (the foreign
-- share) — and v1 declines rather than approximating.
--
-- Declining is only honest if the platform KNOWS which case it is in. Hence
-- this column.
--
-- 🔴 DELIBERATELY NULLABLE, WITH NO DEFAULT. `NULL` means "not declared", and
-- it is a first-class state, not a gap to be tidied away.
--
-- The tempting default is 'SAUDI_GCC': it is the common case, and it would make
-- every existing tenant "work" immediately. That is exactly the mistake this
-- milestone chain has been unwinding. A default would have the PLATFORM assert
-- a fact about the TENANT's ownership structure that nobody told it — and that
-- assertion then decides whether the tenant is shown a Zakat surface at all.
-- Getting it wrong in the SAUDI_GCC direction means showing a foreign-owned
-- company a Zakat capability it must not use; the failure is silent, because a
-- working page looks like a correct page.
--
-- So an undeclared company is ASKED, not assumed. The Zakat surface branches
-- three ways: undeclared → "tell us your ownership structure"; SAUDI_GCC → the
-- module (under construction today); FOREIGN/MIXED → out of scope, see your
-- tax advisor.
--
-- ── Scope note ─────────────────────────────────────────────────────────────
-- Ownership structure has consequences well beyond Zakat (income-tax exposure
-- most obviously). v1 reads it for the Zakat gate ONLY. It is recorded here so
-- a future reader does not mistake this column for a general tax-status field
-- that other code may trust.

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "ownership_type" varchar(20);--> statement-breakpoint

-- The write-boundary lesson: an invariant several writers could violate belongs
-- in a CHECK, not in per-path validation. NULL stays permitted — it is the
-- "not declared" state, not a violation.
ALTER TABLE "companies" ADD CONSTRAINT "companies_ownership_type_values"
  CHECK ("ownership_type" IS NULL OR "ownership_type" IN ('SAUDI_GCC','FOREIGN','MIXED'));
