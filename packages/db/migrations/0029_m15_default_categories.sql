-- ═══════════════════════════════════════════════════════════════════════════
-- M15 — default categories join the seeded chart, killing the second id space
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 🔴 WHY: the categorization engine carried its own hardcoded category list with
-- ids 1–30, while the real `categories` table (M13) uses serial ids. Nothing
-- forced the two to agree, so they diverged — and the FK on
-- `transactions.category_id` rejected EVERY auto-categorized row. The default
-- upload path imported nothing.
--
-- The fix removes the second id space entirely: the engine now emits a
-- **system_code**, the same stable identity M13 established, and resolution
-- happens against the tenant's own chart. This migration gives every code the
-- engine can emit a seeded category to resolve to.
--
-- These are DEFAULTS, not system accounts (`is_system = false`): a tenant may
-- rename or delete them. Deleting one simply means transactions matching that
-- rule land uncategorized for review — resolution failure is "unknown", never an
-- error. The 11 M13 system accounts remain protected as before.

ALTER TABLE "system_account_templates" ADD COLUMN IF NOT EXISTS "is_system" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "system_account_templates" ADD COLUMN IF NOT EXISTS "zakat_relevant" boolean NOT NULL DEFAULT false;--> statement-breakpoint

INSERT INTO "system_account_templates" (code, name, name_ar, type, vat_applicable, zakat_relevant, is_system, sort_order) VALUES
  ('SERVICE_INCOME', 'Service Income', 'إيرادات الخدمات', 'income', true, false, false, 200),
  ('RENTAL_INCOME', 'Rental Income', 'إيرادات الإيجار', 'income', true, false, false, 210),
  ('INVESTMENT_INCOME', 'Investment Returns', 'عوائد الاستثمار', 'income', false, true, false, 220),
  ('GOVT_GRANTS', 'Government Grants', 'المنح الحكومية', 'income', false, false, false, 230),
  ('OTHER_INCOME', 'Other Income', 'إيرادات أخرى', 'income', false, false, false, 240),
  ('RENT_UTILITIES', 'Rent & Utilities', 'الإيجار والمرافق', 'expense', true, false, false, 250),
  ('TELECOM', 'Telecommunications', 'الاتصالات', 'expense', true, false, false, 260),
  ('FUEL_TRANSPORT', 'Fuel & Transportation', 'الوقود والمواصلات', 'expense', true, false, false, 270),
  ('FOOD_MEALS', 'Food & Meals', 'الطعام والوجبات', 'expense', true, false, false, 280),
  ('MARKETING', 'Marketing & Advertising', 'التسويق والإعلان', 'expense', true, false, false, 290),
  ('OFFICE_SUPPLIES', 'Office Supplies', 'اللوازم المكتبية', 'expense', true, false, false, 300),
  ('PROFESSIONAL_FEES', 'Professional Services', 'الخدمات المهنية', 'expense', true, false, false, 310),
  ('BANK_CHARGES', 'Bank Charges', 'الرسوم البنكية', 'expense', true, false, false, 320),
  ('GOVT_FEES', 'Government Fees', 'الرسوم الحكومية', 'expense', false, false, false, 330),
  ('INSURANCE', 'Insurance', 'التأمين', 'expense', false, false, false, 340),
  ('TRAVEL', 'Travel & Accommodation', 'السفر والإقامة', 'expense', true, false, false, 350),
  ('IT_SOFTWARE', 'IT & Software', 'تقنية المعلومات والبرمجيات', 'expense', true, false, false, 360),
  ('REPAIRS', 'Repairs & Maintenance', 'الإصلاح والصيانة', 'expense', true, false, false, 370),
  ('ZAKAT_PAYMENT', 'Zakat Payment', 'الزكاة', 'expense', false, false, false, 380),
  ('VAT_PAYMENT', 'VAT Payment', 'ضريبة القيمة المضافة', 'expense', false, false, false, 390),
  ('OTHER_EXPENSES', 'Other Expenses', 'مصاريف أخرى', 'expense', false, false, false, 400),
  ('INVENTORY', 'Inventory', 'المخزون', 'asset', false, true, false, 410),
  ('FIXED_ASSETS', 'Fixed Assets', 'الأصول الثابتة', 'asset', true, false, false, 420),
  ('INVESTMENTS', 'Investments', 'الاستثمارات', 'asset', false, true, false, 430),
  ('LOANS', 'Loans & Financing', 'القروض والتمويل', 'liability', false, false, false, 440)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- Seed the new defaults into EVERY existing organization (idempotent on the
-- (organization_id, system_code) unique index, as always).
INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, zakat_relevant)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.zakat_relevant
  FROM organizations o CROSS JOIN system_account_templates t
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

-- The org-creation trigger must carry the flags too, or the NEXT organization
-- gets defaults marked as protected system accounts.
CREATE OR REPLACE FUNCTION seed_org_chart_of_accounts() RETURNS trigger AS $$
BEGIN
  INSERT INTO categories (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, zakat_relevant)
  SELECT NEW.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.zakat_relevant
    FROM system_account_templates t
  ON CONFLICT (organization_id, system_code) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
