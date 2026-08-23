-- ═══════════════════════════════════════════════════════════════════════════
-- C11 — GOVT_FEES / GOVT_GRANTS / GOSI verified against the PRIMARY TEXTS
-- (GCC Common VAT Agreement, all 78 articles; KSA VAT Law M/113; KSA VAT IR
-- Eighth Edition + the 01-06-24 amendments via ZATCA's April 2025 guideline.
-- Per-article citations: docs/tax/gcc-framework-verification.md, 2026-08-23.)
--
-- The O defaults were C9's deliberate leftovers ("the rule lives in the
-- Agreement, Art. 9 area, which was NOT read"). The read corrected the
-- premise — the Agreement's Art. 9 is reverse charge and NO sovereign-
-- capacity article exists anywhere in the chain — and verified the verdicts
-- from the definitional scope chain instead (Agr. Arts. 1+2; Law Art. 2;
-- IR Art. 14): a statutory fee, fine, or GOSI contribution involves no
-- Taxable Supply by a Taxable Person conducting an Economic Activity
-- independently for the purpose of generating income.
--
-- 🔴 GOVT_GRANTS carries a CONDITION in positive law (IR Art. 39(2), added
-- Nov 2024): a "grant" that compensates supplies benefiting the government
-- — directly or indirectly — is TAXABLE CONSIDERATION, not a subsidy. The
-- category default O covers the true-subsidy case (Agr. Art. 26(6)(b) even
-- REDUCES supply value by state subsidies); the compensating case is a
-- per-row fact and is corrected by the existing per-row treatment override.
-- Unlike every other O here, that error direction is UNSAFE (understates
-- output VAT) — recorded loudly in the doc.
--
-- Values-only migration: no column is added or dropped, so the org-seed
-- trigger is untouched (the §4 redefinition rule fires on COLUMN changes;
-- tests/org-seed-trigger.test.ts continues to guard the copy).
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE "system_account_templates" SET treatment_verified = true
 WHERE code IN ('GOVT_FEES', 'GOVT_GRANTS', 'GOSI_EXPENSE', 'GOSI_PAYABLE');--> statement-breakpoint

UPDATE "categories" SET treatment_verified = true
 WHERE system_code IN ('GOVT_FEES', 'GOVT_GRANTS', 'GOSI_EXPENSE', 'GOSI_PAYABLE');--> statement-breakpoint
