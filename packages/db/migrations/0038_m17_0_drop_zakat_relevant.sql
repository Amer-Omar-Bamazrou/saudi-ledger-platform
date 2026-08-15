-- ═══════════════════════════════════════════════════════════════════════════
-- M17.0 — delete the Zakat-relevance flag (owner decision Q6)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `transactions.is_zakat_relevant` and `categories.zakat_relevant` are removed
-- entirely, along with the `system_account_templates.zakat_relevant` column
-- that seeded the latter.
--
-- 🔴 WHY, so this is not "restored" by a future session that finds Zakat has no
-- classification column:
--
-- Almost nothing set the flag. Of ~40 categorization rules exactly ONE wrote it
-- true — "Saudi investment / Tadawul" → INVESTMENT_INCOME (which is also the
-- only seeded template row carrying zakat_relevant = true). The sole reader
-- (`GET /summary/zakat`, deleted in the same milestone) summed rows WHERE
-- is_zakat_relevant = true, so it got an EMPTY set for almost every tenant and
-- rendered a computed-looking SAR 0.00 next to a nisab threshold derived from a
-- hardcoded 2024 gold price.
--
-- For a tenant who DID trade, it was worse than zero rather than better: the sum
-- added credits and subtracted debits, so investment INCOME was reported as a
-- zakatable ASSET, reduced by every unrelated debit in the tenant's history.
--
-- That is the shape-without-a-consumer failure mode inverted: a complete
-- consumer with (almost) no producer, which fails silently because a confident
-- zero looks like an answer.
--
-- The replacement (M17.3) classifies at the CHART-OF-ACCOUNTS level, because a
-- Zakat working paper needs to know WHICH LINE a GL account feeds (capital,
-- retained earnings, a provision, a long-term liability, a deductible long-term
-- asset) — which a boolean cannot express, on a table where it would have to be
-- re-derived per row by every write path. See docs/product/design-zakat-module.md.
--
-- No data is lost that anyone had: `categories.zakat_relevant` is the seeded
-- value (only INVESTMENT_INCOME true), and `transactions.is_zakat_relevant` is
-- `false` except on Tadawul/investment rows and wherever a user hand-toggled a
-- switch whose only effect was this deleted report. None of it is recoverable
-- input to the M17.4 worksheet, which reads balance-sheet GL accounts.

-- ── 1. The org-creation trigger FIRST ──────────────────────────────────────
-- 🔴 Order is not cosmetic. `seed_org_chart_of_accounts()` copies
-- `zakat_relevant` from the templates into `categories` on every organization
-- INSERT (0029 → 0031 → 0033 → 0036). Dropping the columns while the function
-- still names them makes the function fail at its next invocation — i.e. every
-- future signup errors, and the failure surfaces nowhere near this migration.
-- plpgsql resolves column names at EXECUTION time, so there is no error here to
-- warn us; redefining first is the whole safety margin.
CREATE OR REPLACE FUNCTION seed_org_chart_of_accounts() RETURNS trigger AS $$
BEGIN
  INSERT INTO categories (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified)
  SELECT NEW.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified
    FROM system_account_templates t
  ON CONFLICT (organization_id, system_code) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ── 2. Drop the columns ────────────────────────────────────────────────────
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "is_zakat_relevant";--> statement-breakpoint
ALTER TABLE "categories" DROP COLUMN IF EXISTS "zakat_relevant";--> statement-breakpoint
ALTER TABLE "system_account_templates" DROP COLUMN IF EXISTS "zakat_relevant";
