-- ═══════════════════════════════════════════════════════════════════════════
-- Audit Tier 2 (finding 4) — invariants at the WRITE BOUNDARY, not in one path
-- ═══════════════════════════════════════════════════════════════════════════
--
-- "Non-'S' means no VAT" was enforced in exactly ONE service path
-- (update()'s treatment branch) while three others violated it: the
-- Categorize run kept stale VAT when assigning a Z/E/O category, upload kept
-- CSV-supplied VAT alongside a non-'S' resolved treatment, and PATCH could
-- write vatAmount alone. Every violating row moved the VAT reconciliation by
-- an amount its own treatment says cannot exist — vatRows gates only on
-- vat_amount IS NOT NULL. The service paths are fixed alongside this
-- migration; these CHECKs are the forcing function that keeps the NEXT write
-- path honest (the two-id-spaces lesson: without one, paths drift apart and
-- the divergence is invisible until something joins them).
--
-- NULL treatment deliberately MAY carry VAT: it is honest-unknown, and manual
-- entry / plain CSV import record user-asserted VAT there by design.

-- Clean the rows the three pre-fix paths produced (Z/E/O with VAT). The VAT
-- was contradicted by the row's own treatment; the treatment wins, exactly as
-- the fixed service paths now decide.
UPDATE "transactions" SET "vat_amount" = NULL, "vat_rate" = NULL
 WHERE "tax_treatment" IN ('Z','E','O') AND "vat_amount" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_treatment_vat_agree"
  CHECK ("tax_treatment" IS NULL OR "tax_treatment" = 'S' OR "vat_amount" IS NULL);--> statement-breakpoint

-- Settlement integrity, both directions (findings 5/6 family): the document
-- links exist ONLY on settlement rows, and a settlement row always names the
-- document it settled. 0032's CHECK only said "not both"; these tie the links
-- to the kind so no future path can strand a link on an operating/transfer
-- row or mint a settlement with no document.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_links_only_on_settlement"
  CHECK ("kind" = 'settlement' OR ("settles_invoice_id" IS NULL AND "settles_bill_id" IS NULL));--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_settlement_names_document"
  CHECK ("kind" <> 'settlement' OR "settles_invoice_id" IS NOT NULL OR "settles_bill_id" IS NOT NULL);
