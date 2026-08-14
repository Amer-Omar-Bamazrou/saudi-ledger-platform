-- ═══════════════════════════════════════════════════════════════════════════
-- Flaw #1 (Option A) — accepted transactions become ledger facts
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Observed live: one SME month produced an income statement showing 0.00 of
-- expenses beside a dashboard showing 45,063.25, because accepted bank lines
-- never reached the general ledger. Two report families, two answers, and for
-- a cash-based SME the P&L was empty. Option A collapses them: acceptance
-- posts a journal entry, so ONE set of books answers the question.

-- ── 1. The link, so a posted row can be found, reversed and re-posted ──────
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "journal_entry_id" integer
  REFERENCES "journal_entries"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_journal_entry_idx"
  ON "transactions" ("journal_entry_id");--> statement-breakpoint

-- ── 2. SUSPENSE — where an accepted-but-uncategorised line posts ───────────
-- Double entry needs two accounts. Refusing to accept uncategorised rows would
-- strand the review queue, and posting them to an expense account is the
-- defect being fixed. Suspense keeps the books balanced and makes "unknown" a
-- balance someone must clear.
ALTER TABLE "system_account_templates"
  ADD COLUMN IF NOT EXISTS "_noop_flaw1" boolean;--> statement-breakpoint
ALTER TABLE "system_account_templates" DROP COLUMN IF EXISTS "_noop_flaw1";--> statement-breakpoint

INSERT INTO "system_account_templates" (code, name, name_ar, type, is_system, vat_applicable, zakat_relevant, default_tax_treatment, treatment_verified)
VALUES ('SUSPENSE', 'Suspense (unclassified)', 'حساب معلق', 'asset', true, false, false, 'O', false)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, zakat_relevant, default_tax_treatment, treatment_verified)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.zakat_relevant, t.default_tax_treatment, t.treatment_verified
  FROM organizations o
  CROSS JOIN system_account_templates t
 WHERE t.code = 'SUSPENSE'
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

-- ── 3. 🔴 PAYING A LIABILITY IS NOT AN EXPENSE ────────────────────────────
-- `VAT_PAYMENT` and `ZAKAT_PAYMENT` were typed `expense`, so the quarterly VAT
-- remittance (12,500 in the observed month) reduced reported profit — while the
-- liability it settles had already been accrued. Re-typed to `liability`, so
-- under Option A the payment posts Dr <liability> / Cr Cash and never touches
-- the P&L. This is a CLASSIFICATION correction, not a restatement: no amount
-- changes, the figures land in the right statement.
UPDATE "system_account_templates" SET type = 'liability' WHERE code IN ('VAT_PAYMENT','ZAKAT_PAYMENT');--> statement-breakpoint
UPDATE "categories" SET type = 'liability' WHERE system_code IN ('VAT_PAYMENT','ZAKAT_PAYMENT');--> statement-breakpoint

-- ── 4. The org-creation trigger must carry SUSPENSE too ───────────────────
-- (Same lesson as 0029/0031/0033: a template row that the trigger does not
-- copy means the NEXT organization is missing the account entirely — and here
-- that would make every uncategorised acceptance fail to post.)
CREATE OR REPLACE FUNCTION seed_org_chart_of_accounts() RETURNS trigger AS $$
BEGIN
  INSERT INTO categories (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, zakat_relevant, default_tax_treatment, treatment_verified)
  SELECT NEW.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.zakat_relevant, t.default_tax_treatment, t.treatment_verified
    FROM system_account_templates t
  ON CONFLICT (organization_id, system_code) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
