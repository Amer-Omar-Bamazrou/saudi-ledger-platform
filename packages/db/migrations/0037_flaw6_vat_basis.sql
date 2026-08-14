-- ═══════════════════════════════════════════════════════════════════════════
-- Flaw #6 — separate "what the supply IS" from "whether VAT was CHARGED"
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `tax_treatment` is the ZATCA supply taxonomy (S/Z/E/O). It says a supply is
-- standard-rated; it CANNOT say that no VAT reached this bank line. Two common
-- cases mean exactly that, and both were being taxed as if VAT had been paid:
--
--   reverse_charge        a foreign supplier (Google Ireland, AWS Luxembourg,
--                         Meta) charges no KSA VAT — the BUYER self-accounts.
--   supplier_unregistered a local supplier below the VAT threshold charges none.
--
-- Live evidence from one SME month: 450.00 of "input VAT" invented on a Google
-- Ads charge, 65.22 on AWS — 66% of the whole reconciliation figure was
-- phantom, which inverted the purpose of the M16.1 gap view (it manufactured
-- fictitious undocumented activity instead of revealing real activity).

ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "vat_basis" text;--> statement-breakpoint

-- Existing rows that carry VAT asserted it was charged; that is what they meant.
UPDATE "transactions" SET "vat_basis" = 'charged' WHERE "vat_amount" IS NOT NULL;--> statement-breakpoint

-- 🔴 The forcing function (the write-boundary lesson): a row may carry VAT
-- only when VAT was actually charged. Kept as a SECOND check rather than
-- folded into 0034's — they assert different facts, and a combined predicate
-- would fail without saying which half was violated.
--
-- NULL basis stays permitted for legacy/manual rows: 0034 already governs the
-- treatment side, and "not yet established" must remain expressible.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_vat_requires_charged_basis"
  CHECK ("vat_amount" IS NULL OR "vat_basis" IS NULL OR "vat_basis" = 'charged');--> statement-breakpoint

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_vat_basis_values"
  CHECK ("vat_basis" IS NULL OR "vat_basis" IN ('charged','reverse_charge','supplier_unregistered'));
