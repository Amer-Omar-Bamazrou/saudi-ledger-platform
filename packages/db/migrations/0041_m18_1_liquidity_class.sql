-- ═══════════════════════════════════════════════════════════════════════════
-- M18.1 — the chart of accounts learns current vs non-current (Finance Hub Q1)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The hub answers "can I pay what I owe?" from current assets and current
-- liabilities. The chart of accounts could not express that distinction at all:
-- `categories` carried type / system_code / is_system / vat_applicable /
-- default_tax_treatment / treatment_verified and nothing equivalent, so the
-- balance sheet grouped by `type` alone and listed items flat.
--
-- ── Why four values and not a boolean ──────────────────────────────────────
-- The ratios need TWO facts, not one:
--   current ratio  = (everything but non_current) / current liabilities
--   quick ratio    = (cash + quick) / current liabilities
-- A `current | non_current` boolean answers the first and forces a hardcoded
-- "…except inventory" rule for the second — which breaks the moment a tenant
-- adds a prepayments account. One ordered classification carries both.
--
--   cash         cash and equivalents
--   quick        other quick assets — receivables, recoverable input VAT
--   current      current but NOT quick — inventory, prepayments; and every
--                current liability
--   non_current  non-current assets and liabilities
--
-- ── 🔴 NULL is "unclassified" and must stay VISIBLE ────────────────────────
-- No default, and NULL is permitted. An unclassified balance-sheet account that
-- quietly counted as current would make the ratio wrong in a way nothing
-- surfaces — the M17.0 failure applied before the fact rather than after. The
-- hub is a control surface, so an unclassified account IS a signal:
-- "3 accounts aren't classified — these ratios exclude SAR X."
--
-- Income, expense and equity accounts stay NULL forever: the distinction is
-- meaningless for them. NULL therefore means "not applicable" OR "not yet
-- classified", disambiguated by `type` — which is why the CHECK below ties the
-- two together instead of demanding a value everywhere.

-- ── 1. The templates (the source every org is seeded from) ─────────────────
ALTER TABLE "system_account_templates"
  ADD COLUMN IF NOT EXISTS "liquidity_class" varchar(20);--> statement-breakpoint

ALTER TABLE "system_account_templates" ADD CONSTRAINT "sat_liquidity_class_values"
  CHECK ("liquidity_class" IS NULL
         OR "liquidity_class" IN ('cash','quick','current','non_current'));--> statement-breakpoint

-- ── 2. Classify the 14 seeded balance-sheet accounts ───────────────────────
--
-- Owner decisions (2026-08-15), both erring toward UNDERSTATING liquidity,
-- because a hub that says "you look tighter than you are" fails safely and the
-- reverse does not:
--
--   LOANS       → current. A loan SPLITS under IAS 1 (the portion due within
--                 12 months is current, the rest is not) and one account cannot
--                 carry a split. Classifying it all-current overstates current
--                 liabilities and so understates the ratio. Crude for a long
--                 mortgage; deliberately so. Upgrade path when a real user
--                 needs it: separate LOANS_CURRENT / LOANS_NON_CURRENT accounts.
--   INVESTMENTS → non_current. IAS 1 classifies by intent and maturity and one
--                 account cannot know which; non-current understates liquidity.
--   SUSPENSE    → current, NOT quick. It is bank money that already moved, so
--                 it is current — but the platform cannot say what it IS, so it
--                 must not count as a QUICK asset. A material balance also
--                 blocks the hub's plain-language claim (design §5.1).
UPDATE "system_account_templates" SET "liquidity_class" = 'cash'        WHERE code = 'CASH';--> statement-breakpoint
UPDATE "system_account_templates" SET "liquidity_class" = 'quick'       WHERE code IN ('AR','VAT_INPUT');--> statement-breakpoint
UPDATE "system_account_templates" SET "liquidity_class" = 'current'     WHERE code IN ('INVENTORY','SUSPENSE');--> statement-breakpoint
UPDATE "system_account_templates" SET "liquidity_class" = 'non_current' WHERE code IN ('FIXED_ASSETS','INVESTMENTS');--> statement-breakpoint
UPDATE "system_account_templates" SET "liquidity_class" = 'current'
  WHERE code IN ('AP','VAT_OUTPUT','VAT_PAYMENT','ZAKAT_PAYMENT','SALARIES_PAYABLE','GOSI_PAYABLE','LOANS');--> statement-breakpoint

-- ── 3. The tenant-facing column ────────────────────────────────────────────
ALTER TABLE "categories"
  ADD COLUMN IF NOT EXISTS "liquidity_class" varchar(20);--> statement-breakpoint

ALTER TABLE "categories" ADD CONSTRAINT "categories_liquidity_class_values"
  CHECK ("liquidity_class" IS NULL
         OR "liquidity_class" IN ('cash','quick','current','non_current'));--> statement-breakpoint

-- 🔴 The write-boundary invariant: only a balance-sheet account may carry one.
-- An income account classified 'quick' is not a harmless oddity — it would be
-- summed into current assets by a reader that trusts the column, so the
-- constraint belongs here rather than in whichever path happens to write next.
ALTER TABLE "categories" ADD CONSTRAINT "categories_liquidity_class_balance_sheet_only"
  CHECK ("liquidity_class" IS NULL OR "type" IN ('asset','liability'));--> statement-breakpoint

-- Back-fill every existing organization from the templates it was seeded from.
UPDATE "categories" c
   SET "liquidity_class" = t."liquidity_class"
  FROM "system_account_templates" t
 WHERE c."system_code" = t."code"
   AND t."liquidity_class" IS NOT NULL;--> statement-breakpoint

-- ── 4. 🔴 The org-creation trigger, which copies column-by-column ──────────
--
-- Same trap as migration 0038, in the opposite direction: that one dropped a
-- column the function still named; this one ADDS a column the function does not
-- name. Nothing errors either way — the next organization would simply be
-- seeded with every liquidity_class NULL, and its owner would open the Finance
-- Hub to find that no account is classified and no ratio can be computed.
-- Silent, and far from this file.
CREATE OR REPLACE FUNCTION seed_org_chart_of_accounts() RETURNS trigger AS $$
BEGIN
  INSERT INTO categories (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class)
  SELECT NEW.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class
    FROM system_account_templates t
  ON CONFLICT (organization_id, system_code) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
