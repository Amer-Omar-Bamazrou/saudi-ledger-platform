-- ═══════════════════════════════════════════════════════════════════════════
-- MED VALIDATION PASS — TWO INVARIANTS MOVE TO THE WRITE BOUNDARY
-- (audit 2026-08-20, MED findings; fixed 2026-08-23)
--
-- 1. transactions.vat_amount / vat_rate — the create path bounded both at the
--    API schema while PATCH /transactions/:id accepted a negative vat_amount
--    and an unbounded vat_rate into the SAME columns. Owner instruction: fix
--    the invariant at the write boundary, not in the looser path — two paths
--    disagreeing about one invariant is the recurring shape. The OpenAPI
--    bounds on TransactionUpdate (same pass) are the contract; THIS is the
--    enforcement every present and future writer inherits. 0049 deliberately
--    left transactions.amount unconstrained (signed-correction concern) —
--    that reasoning does not extend to vat_amount, which is an extracted
--    component, never a direction carrier.
--
-- 2. tax_category_code ∈ {S, Z, E, O} — the column the VAT return files from
--    accepted ANY string (no check at API, service, or DB). NULL stays legal
--    and first-class: 0% is genuinely ambiguous between Z/E/O and the
--    platform never guesses a tax fact (the M12.8 rule). Service-level
--    asserts (lib/writeGuards.assertTaxCategoryCode) are the named 400s;
--    these CHECKs are the backstop. quotation_items carries the same column
--    (copied into invoice_items at conversion) and gets the same constraint —
--    green fixes the class. bill_items/po_items have NO such column (verified
--    against information_schema, the M21.3 lesson), so nothing to constrain.
--
-- Verified before writing: zero existing rows violate any constraint below
-- (dev org, all four counts 0 on 2026-08-23).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_vat_bounds";
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_vat_bounds"
  CHECK (
    (vat_amount IS NULL OR vat_amount >= 0)
    AND (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate <= 100))
  );--> statement-breakpoint

ALTER TABLE "invoice_items" DROP CONSTRAINT IF EXISTS "invoice_items_tax_category_code_valid";
ALTER TABLE "invoice_items"
  ADD CONSTRAINT "invoice_items_tax_category_code_valid"
  CHECK (tax_category_code IS NULL OR tax_category_code IN ('S', 'Z', 'E', 'O'));--> statement-breakpoint

ALTER TABLE "quotation_items" DROP CONSTRAINT IF EXISTS "quotation_items_tax_category_code_valid";
ALTER TABLE "quotation_items"
  ADD CONSTRAINT "quotation_items_tax_category_code_valid"
  CHECK (tax_category_code IS NULL OR tax_category_code IN ('S', 'Z', 'E', 'O'));--> statement-breakpoint
