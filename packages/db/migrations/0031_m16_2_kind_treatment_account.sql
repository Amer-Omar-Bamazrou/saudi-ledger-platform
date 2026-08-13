ALTER TABLE "categories" ADD COLUMN "default_tax_treatment" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "kind" text DEFAULT 'operating' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "tax_treatment" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "bank_account_id" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_org_account_idx" ON "transactions" USING btree ("organization_id","bank_account_id");
-- ═══════════════════════════════════════════════════════════════════════════
-- M16.2 hand-written half — treatment defaults, template, trigger (design Q1/Q2)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `default_tax_treatment` on the category template: 'S' | 'Z' | 'E' | 'O'.
-- NULL is reserved for UNKNOWN — a catch-all category (OTHER_INCOME /
-- OTHER_EXPENSES) cannot honestly claim a treatment, so it carries none and a
-- transaction categorized under it stays treatment-unknown for a human.
--
-- Reconcile-grade only (design Q0/Q1): these defaults drive the transaction-side
-- VAT ESTIMATE and the reconciliation view. The filing return reads invoices
-- and bills and never consults any of this.

ALTER TABLE "system_account_templates" ADD COLUMN IF NOT EXISTS "default_tax_treatment" text;--> statement-breakpoint

-- KSA treatments, category by category. Notes on the non-obvious ones:
--  * BANK_CHARGES → 'S': explicit bank fees are STANDARD-RATED in KSA (ZATCA
--    financial-services guideline); only implicit-margin products are exempt.
--    The design doc's illustrative "BANK_CHARGES → E" was wrong and is
--    corrected there.
--  * INSURANCE → 'S': general insurance is standard-rated (life is exempt —
--    a per-row override, not the default). 0029 seeded vat_applicable=false
--    for it; corrected below in the same spirit.
--  * SALARIES / GOVT_FEES / ZAKAT_PAYMENT / VAT_PAYMENT / LOANS / GOVT_GRANTS
--    → 'O': not consideration for a supply — out of scope, not "exempt".
--  * INVESTMENT_INCOME / INVESTMENTS → 'E': exempt financial services.
UPDATE "system_account_templates" SET "default_tax_treatment" = v.t FROM (VALUES
  ('SERVICE_INCOME','S'), ('RENTAL_INCOME','S'), ('SALES','S'),
  ('INVESTMENT_INCOME','E'), ('GOVT_GRANTS','O'),
  ('RENT_UTILITIES','S'), ('TELECOM','S'), ('FUEL_TRANSPORT','S'),
  ('FOOD_MEALS','S'), ('MARKETING','S'), ('OFFICE_SUPPLIES','S'),
  ('PROFESSIONAL_FEES','S'), ('BANK_CHARGES','S'), ('INSURANCE','S'),
  ('TRAVEL','S'), ('IT_SOFTWARE','S'), ('REPAIRS','S'),
  ('INVENTORY','S'), ('FIXED_ASSETS','S'), ('INVESTMENTS','E'),
  ('GOVT_FEES','O'), ('ZAKAT_PAYMENT','O'), ('VAT_PAYMENT','O'),
  ('LOANS','O'), ('SALARIES','O'), ('GOSI_EXPENSE','O'),
  ('PURCHASES','S'), ('CASH','O'), ('AR','O'), ('AP','O')
) AS v(code, t) WHERE "system_account_templates".code = v.code;--> statement-breakpoint

-- 0029 correction: general insurance premiums carry 15% VAT in KSA.
UPDATE "system_account_templates" SET "vat_applicable" = true WHERE code = 'INSURANCE';--> statement-breakpoint

-- Backfill every organization's existing category rows from the template
-- (join on system_code; custom categories without a code are untouched and
-- stay treatment-NULL = unknown, which is true).
UPDATE "categories" c SET "default_tax_treatment" = t."default_tax_treatment"
  FROM "system_account_templates" t
 WHERE c."system_code" = t."code" AND t."default_tax_treatment" IS NOT NULL;--> statement-breakpoint
UPDATE "categories" SET "vat_applicable" = true WHERE "system_code" = 'INSURANCE';--> statement-breakpoint

-- The org-creation trigger must carry the treatment, or the NEXT organization
-- gets a chart with no defaults (same lesson as 0029's flag carry).
CREATE OR REPLACE FUNCTION seed_org_chart_of_accounts() RETURNS trigger AS $$
BEGIN
  INSERT INTO categories (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, zakat_relevant, default_tax_treatment)
  SELECT NEW.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.zakat_relevant, t.default_tax_treatment
    FROM system_account_templates t
  ON CONFLICT (organization_id, system_code) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
