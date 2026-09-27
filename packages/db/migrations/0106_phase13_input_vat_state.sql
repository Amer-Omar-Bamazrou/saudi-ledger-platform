ALTER TABLE "bills" ADD COLUMN "input_vat_state" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "input_vat_pending" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "input_vat_claimed_on" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "input_vat_claim_entry_id" integer;--> statement-breakpoint

-- ── Phase 13A (2026-09-27) — accountant answers X1 / X3 / X5, applied. ──────
-- Hand-written; drizzle does not track CHECKs, triggers or template rows.
-- Record: docs/product/phase-13-expenses-decision-pack.md §1–§2.

-- ── 1. The holding account (X1). An ASSET, never VAT_INPUT. ────────────────
INSERT INTO "system_account_templates" (code, name, name_ar, type, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, sort_order)
VALUES ('VAT_AWAITING_EVIDENCE', 'Input VAT awaiting evidence', 'ضريبة مدخلات بانتظار الإثبات', 'asset', true, false, 'O', false, 'current', 31)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint
-- Existing organizations get it too: the org-seed trigger fires only for NEW orgs.
INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, is_posting)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class, true
  FROM organizations o
  CROSS JOIN system_account_templates t
 WHERE t.code = 'VAT_AWAITING_EVIDENCE'
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

-- ── 2. Where every ALREADY-POSTED bill's VAT sits, stated once. ─────────────
-- Before Phase 13 every posted bill claimed its VAT on its own entry, except
-- the fixed-asset treatment: a 0 %-recovery asset capitalised its VAT and
-- posted no VAT_INPUT line (P13-D2 — the return counted it anyway).
UPDATE "bills" b
   SET input_vat_state = CASE
         WHEN b.capitalises_asset_id IS NOT NULL AND b.vat_amount > 0
          AND EXISTS (SELECT 1 FROM fixed_assets fa WHERE fa.id = b.capitalises_asset_id AND fa.vat_initial_recovery_pct = 0)
         THEN 'not_deductible' ELSE 'claimed' END,
       input_vat_claimed_on = CASE
         WHEN b.capitalises_asset_id IS NOT NULL AND b.vat_amount > 0
          AND EXISTS (SELECT 1 FROM fixed_assets fa WHERE fa.id = b.capitalises_asset_id AND fa.vat_initial_recovery_pct = 0)
         THEN NULL ELSE b.date END
 WHERE b.status NOT IN ('draft', 'submitted');--> statement-breakpoint

-- ── 3. What the columns may say. ────────────────────────────────────────────
ALTER TABLE "bills" ADD CONSTRAINT "bills_input_vat_state_chk"
  CHECK (input_vat_state IS NULL OR input_vat_state IN ('claimed', 'awaiting_evidence', 'not_deductible'));--> statement-breakpoint
-- Only VAT that is awaiting evidence is held; held VAT is never negative.
ALTER TABLE "bills" ADD CONSTRAINT "bills_input_vat_pending_chk"
  CHECK (input_vat_pending >= 0 AND (input_vat_pending = 0 OR input_vat_state = 'awaiting_evidence'));--> statement-breakpoint
-- A claim names its period; nothing else does.
ALTER TABLE "bills" ADD CONSTRAINT "bills_input_vat_claimed_on_chk"
  CHECK ((input_vat_claimed_on IS NULL OR input_vat_claimed_on ~ '^\d{4}-\d{2}-\d{2}$')
     AND ((input_vat_state = 'claimed') = (input_vat_claimed_on IS NOT NULL) OR input_vat_state IS NULL)
     AND (input_vat_claim_entry_id IS NULL OR input_vat_state = 'claimed'));--> statement-breakpoint
CREATE INDEX "bills_company_input_vat_idx" ON "bills" USING btree ("company_id", "input_vat_state");--> statement-breakpoint

-- ── 4. 🔴 THE GATE, REWRITTEN (replaces 0105's). ────────────────────────────
-- 0105 refused to post any document whose evidence did not support its claim,
-- because where that VAT would go was still with the accountant. It is
-- answered: such a document POSTS, and what it may NOT do is put the VAT in
-- VAT_INPUT. So the gate now ties the posted state to the verdict:
--   claimed            ← evidenced / not_required (a note, a nil claim)
--   awaiting_evidence  ← awaiting_evidence / not_required (a note on held VAT)
--   not_deductible     ← not_deductible / not_required (a note on blocked VAT)
-- and `not_evaluated` never posts. Once posted, the ONLY change of state is the
-- evidence entry: awaiting_evidence → claimed, with the verdict evidenced (or
-- a note following its original), nothing left pending, a claim date on or
-- after the supply date and within five calendar years of its year (IR Art.
-- 49(8)). Limit, stated (unchanged from 0105): a row INSERTED already posted
-- (opening items, fixtures) never passes through here.
CREATE OR REPLACE FUNCTION bills_vat_evidence_gate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('draft', 'submitted') AND NEW.status NOT IN ('draft', 'submitted') THEN
    -- coalesce: a NULL state makes every arm NULL, and IF NOT (NULL) does not fire.
    IF NOT coalesce(
         (NEW.input_vat_state = 'claimed'           AND NEW.vat_evidence_status IN ('evidenced', 'not_required'))
      OR (NEW.input_vat_state = 'awaiting_evidence' AND NEW.vat_evidence_status IN ('awaiting_evidence', 'not_required'))
      OR (NEW.input_vat_state = 'not_deductible'    AND NEW.vat_evidence_status IN ('not_deductible', 'not_required')),
      false
    ) THEN
      RAISE EXCEPTION 'bill % (%) cannot be posted with input VAT %: its VAT evidence verdict is %',
        NEW.id, NEW.bill_number, coalesce(NEW.input_vat_state, 'unstated'), NEW.vat_evidence_status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bills_vat_evidence_gate';
    END IF;
  ELSIF OLD.status NOT IN ('draft', 'submitted') AND NEW.input_vat_state IS DISTINCT FROM OLD.input_vat_state THEN
    IF NOT coalesce(
         OLD.input_vat_state = 'awaiting_evidence' AND NEW.input_vat_state = 'claimed'
     AND NEW.vat_evidence_status IN ('evidenced', 'not_required')
     AND NEW.input_vat_pending = 0
     AND NEW.input_vat_claimed_on >= NEW.date
     AND substr(NEW.input_vat_claimed_on, 1, 4)::int - substr(NEW.date, 1, 4)::int <= 5,
      false
    ) THEN
      RAISE EXCEPTION 'bill % (%): input VAT cannot move from % to % (verdict %, claimed on %)',
        NEW.id, NEW.bill_number, coalesce(OLD.input_vat_state, 'unstated'), coalesce(NEW.input_vat_state, 'unstated'),
        NEW.vat_evidence_status, coalesce(NEW.input_vat_claimed_on, 'no date')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bills_vat_evidence_gate';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS bills_vat_evidence_gate ON "bills";--> statement-breakpoint
CREATE TRIGGER bills_vat_evidence_gate BEFORE UPDATE OF status, input_vat_state ON "bills"
  FOR EACH ROW EXECUTE FUNCTION bills_vat_evidence_gate();
