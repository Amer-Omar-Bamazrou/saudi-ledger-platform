-- ═══════════════════════════════════════════════════════════════════════════
-- A — GL OWNS CASH: the three accounts transfers post through.
--
-- Now that B5 records WHERE a transfer went, transfers become ledger facts:
--   own_account  → TRANSFER_CLEARING  (asset, quick). Both legs uploaded ⇒
--                  nets to zero; a residual is the tenant's money in an own
--                  account the platform does not track — real and visible.
--   external     → EXTERNAL_TRANSFERS (equity). 🔴 Equity, owner-approved
--                  2026-08-17: a DECLARED reduction of net assets with no
--                  expense is a distribution. An expense would be a P&L claim
--                  the platform cannot support; an asset would contradict the
--                  tenant's own declaration that the money left.
--   undeclared   → TRANSFER_SUSPENSE  (asset). Posts — the bank genuinely
--                  moved — but the offset demands a declaration, and a
--                  non-zero balance blocks the Finance Hub liquidity claim,
--                  exactly like SUSPENSE.
--
-- Row-only template additions: the org-seed trigger copies ALL template rows
-- dynamically, so it needs no redefinition (the 0038/0041 landmine is about
-- COLUMN changes; tests/org-seed-trigger.test.ts guards those).
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO "system_account_templates" (code, name, name_ar, type, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class)
VALUES
  ('TRANSFER_CLEARING', 'Transfer clearing (own accounts)', 'تسوية التحويلات (حسابات خاصة)', 'asset', true, false, 'O', false, 'quick'),
  ('TRANSFER_SUSPENSE', 'Transfers awaiting declaration', 'تحويلات بانتظار الإقرار', 'asset', true, false, 'O', false, 'current'),
  ('EXTERNAL_TRANSFERS', 'External transfers (money leaving the business)', 'تحويلات خارجية (أموال خرجت من المنشأة)', 'equity', true, false, 'O', false, NULL)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- Existing organizations get the accounts too (the trigger only fires for NEW
-- orgs — the M13 lesson: a seed that fires only at org creation strands every
-- existing tenant, and the fail-closed posting path would refuse their next
-- transfer acceptance).
INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class
  FROM organizations o
  CROSS JOIN system_account_templates t
 WHERE t.code IN ('TRANSFER_CLEARING', 'TRANSFER_SUSPENSE', 'EXTERNAL_TRANSFERS')
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint
