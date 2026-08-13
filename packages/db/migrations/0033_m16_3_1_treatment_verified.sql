ALTER TABLE "categories" ADD COLUMN "treatment_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- M16.3.1 hand-written half — checked vs assumed treatment defaults
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Owner decision (M16.3 close-out): a treatment default that is an unverified
-- majority-guess must be visible WHERE IT IS USED, not only in the design doc.
-- `treatment_verified = true` means the default was checked against actual KSA
-- VAT rules the way BANK_CHARGES was (ZATCA financial-services guideline).
-- Everything else stays false and surfaces as "assumed" in the review UI.
-- Verifying the rest is pre-production queue item C9.
ALTER TABLE "system_account_templates" ADD COLUMN IF NOT EXISTS "treatment_verified" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- The ONLY two treatments checked against KSA rules at M16.2 (both were looked
-- up because the design's illustrations were suspected — and were — wrong):
--   * BANK_CHARGES → 'S' (explicit fees standard-rated; implicit-margin exempt)
--   * INSURANCE   → 'S' (general standard-rated; life-exempt is a row override)
UPDATE "system_account_templates" SET "treatment_verified" = true
 WHERE code IN ('BANK_CHARGES','INSURANCE');--> statement-breakpoint

-- Backfill every organization's category rows from the template.
UPDATE "categories" c SET "treatment_verified" = t."treatment_verified"
  FROM "system_account_templates" t
 WHERE c."system_code" = t."code";--> statement-breakpoint

-- The org-creation trigger must carry the flag, or the NEXT organization gets a
-- chart where nothing records what was checked (the 0029/0031 lesson, again).
CREATE OR REPLACE FUNCTION seed_org_chart_of_accounts() RETURNS trigger AS $$
BEGIN
  INSERT INTO categories (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, zakat_relevant, default_tax_treatment, treatment_verified)
  SELECT NEW.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.zakat_relevant, t.default_tax_treatment, t.treatment_verified
    FROM system_account_templates t
  ON CONFLICT (organization_id, system_code) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
