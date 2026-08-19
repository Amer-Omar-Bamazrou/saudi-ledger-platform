-- ═══════════════════════════════════════════════════════════════════════════
-- C9 — VAT treatment defaults verified against the PRIMARY SOURCE
-- (ZATCA VAT Implementing Regulations, official English PDF, read 2026-08-19;
-- per-article citations in docs/tax/vat-treatment-verification.md).
--
-- ── 1. `input_vat_blocked` — a THIRD axis, deliberately ────────────────────
-- 🔴 Recoverability is neither TREATMENT nor BASIS, and must not be folded
-- into either (owner decision, 2026-08-19). The FOOD_MEALS case proves it:
-- the supplier CHARGES VAT (treatment 'S' is factually right — Art. 50 does
-- not make catering exempt), the buyer PAID it (basis 'charged' is right),
-- and Article 50(1)(b) still forbids DEDUCTING it. Three independent facts:
-- what the supply is, whether tax was charged, whether the buyer may recover
-- it. Folding the third into treatment would falsify the receipt ('E' on a
-- receipt that shows VAT); folding it into basis would falsify the payment.
-- The flag lives on the CATEGORY because Art. 50 blocks by expenditure
-- CLASS, not per-document.
--
-- ── 2. The live wrong default this corrects ────────────────────────────────
-- FOOD_MEALS extracted VAT into the recoverable-input-VAT estimate. Art.
-- 50(1)(a)-(b) blocks entertainment and catering input VAT, so every meal
-- receipt overstated recoverable input VAT — the C9 queue entry's predicted
-- defect, now confirmed against the regulation and closed at the read side
-- (summary VAT excludes blocked categories; the paid-VAT FACT stays stored).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "system_account_templates"
  ADD COLUMN IF NOT EXISTS "input_vat_blocked" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "categories"
  ADD COLUMN IF NOT EXISTS "input_vat_blocked" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- Art. 50(1)(a) entertainment / 50(1)(b) catering in hotels, restaurants and
-- similar venues: input VAT not deductible.
UPDATE "system_account_templates" SET input_vat_blocked = true, treatment_verified = true WHERE code = 'FOOD_MEALS';--> statement-breakpoint
UPDATE "categories" SET input_vat_blocked = true, treatment_verified = true WHERE system_code = 'FOOD_MEALS';--> statement-breakpoint

-- ── 3. Verified treatments (citations in the doc) ──────────────────────────
-- S by the enumerated-exceptions structure of the law (standard rate is the
-- default; Chapters 5-6 enumerate the exceptions, and none plausibly covers
-- these): SALES, SERVICE_INCOME, TELECOM, OFFICE_SUPPLIES, REPAIRS,
-- PROFESSIONAL_FEES, PURCHASES, FIXED_ASSETS, RENT_UTILITIES (commercial
-- lease taxable — Art. 30 exempts only residential LEASE and ownership
-- transfers), FUEL_TRANSPORT (fuel standard-rated; Art. 50(1)(e)'s
-- restricted-vehicle fuel block is CONDITIONAL, so input_vat_blocked stays
-- false — recorded in the doc).
-- S + reverse-charge basis mechanism verified (Art. 47(1)): MARKETING,
-- IT_SOFTWARE.
-- O verified: SALARIES (Art. 2 — Economic Activity is conducted
-- "independently"; employment is outside it).
-- E verified: INVESTMENTS (Art. 29(1),(2)(a) — dealing in money/securities
-- exempt).
-- Already verified in M16.2, citations now attached: BANK_CHARGES (Art.
-- 29(1) explicit fee), INSURANCE (Art. 29 — life exempt, non-life standard).
UPDATE "system_account_templates" SET treatment_verified = true
 WHERE code IN ('SALES','SERVICE_INCOME','TELECOM','OFFICE_SUPPLIES','REPAIRS','PROFESSIONAL_FEES',
                'PURCHASES','FIXED_ASSETS','RENT_UTILITIES','FUEL_TRANSPORT','MARKETING','IT_SOFTWARE',
                'SALARIES','INVESTMENTS');--> statement-breakpoint
UPDATE "categories" SET treatment_verified = true
 WHERE system_code IN ('SALES','SERVICE_INCOME','TELECOM','OFFICE_SUPPLIES','REPAIRS','PROFESSIONAL_FEES',
                'PURCHASES','FIXED_ASSETS','RENT_UTILITIES','FUEL_TRANSPORT','MARKETING','IT_SOFTWARE',
                'SALARIES','INVESTMENTS');--> statement-breakpoint

-- NOT verified, deliberately (each with what would settle it, in the doc):
-- RENTAL_INCOME (category conflates commercial-S / residential-E, Art. 30),
-- TRAVEL (mixes S hotels / Z international transport Art. 34 / blocked
-- entertainment Art. 50), LOANS + INVESTMENT_INCOME (principal-O vs
-- interest-E mixes, Art. 29), GOVT_FEES / GOVT_GRANTS / GOSI_* (the rules
-- live in the GCC VAT Agreement — queue C11), INVENTORY, OTHER_*.

-- ── 4. 🔴 The org-seed trigger must carry the new column (the 0041 lesson:
-- an added column the trigger omits seeds the next org with the DEFAULT
-- unset — here that would un-block FOOD_MEALS for every new tenant).
-- tests/org-seed-trigger.test.ts compares the two tables' column sets and
-- fails in both directions without being edited.
CREATE OR REPLACE FUNCTION seed_org_chart_of_accounts() RETURNS trigger AS $$
BEGIN
  INSERT INTO categories (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, input_vat_blocked)
  SELECT NEW.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class, t.input_vat_blocked
    FROM system_account_templates t
  ON CONFLICT (organization_id, system_code) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
