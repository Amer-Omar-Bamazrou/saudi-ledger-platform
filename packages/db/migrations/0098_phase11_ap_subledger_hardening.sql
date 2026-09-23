DROP INDEX "supplier_payment_allocations_idempotency_unq";--> statement-breakpoint
ALTER TABLE "supplier_payment_allocation_reversals" ALTER COLUMN "journal_entry_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" DROP COLUMN "idempotency_key";--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 11 Part 2 — hardening found by the post-build audit (pack §17).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The four append-only tables carry NO UPDATE grant ───────────────────
-- 0096 granted UPDATE on every subledger table "because an allocation's
-- journal entry id is filled in after the entry exists". No path does that:
-- every row is written complete. And the allocation trigger only guarded
-- rows WITH a journal entry, so a credit-note application (journal entry
-- NULL — it posts nothing) was editable by the app role. An allocation, its
-- reversal, a classification record and a refund are facts of record; the
-- correction of each is a superseding row, never an edit. supplier_payments
-- keeps UPDATE for its `classification` column only, under its trigger.
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH t IN ARRAY ARRAY['supplier_payment_allocations', 'supplier_payment_allocation_reversals', 'supplier_payment_classifications', 'supplier_refunds'] LOOP
      EXECUTE format('REVOKE UPDATE ON TABLE public.%I FROM authenticated', t);
    END LOOP;
  END IF;
END $$;--> statement-breakpoint

-- Defence in depth for any role that does hold UPDATE: no allocation is
-- editable, with or without a journal entry.
CREATE OR REPLACE FUNCTION refuse_supplier_allocation_change() RETURNS trigger AS $$
BEGIN
  IF pg_has_role(current_user, 'authenticated', 'MEMBER') AND (
       NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.bill_id IS DISTINCT FROM OLD.bill_id
    OR NEW.supplier_payment_id IS DISTINCT FROM OLD.supplier_payment_id
    OR NEW.supplier_credit_note_id IS DISTINCT FROM OLD.supplier_credit_note_id
    OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id) THEN
    RAISE EXCEPTION 'A posted allocation is a fact of record (allocation %) — reverse it instead of editing it.', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint

-- ── 2. A reversal's journal entry follows what it reverses ─────────────────
-- A credit-note application posted nothing, so its reversal posts nothing
-- (journal entry NULL); a payment allocation posted an entry, so its reversal
-- must carry the mirror. The first build posted Dr SUPPLIER_ADVANCES / Cr AP
-- for a note's reversal — an advance no payment explained. Made
-- inexpressible here rather than trusted to the service alone.
CREATE OR REPLACE FUNCTION check_supplier_allocation_reversal() RETURNS trigger AS $$
DECLARE is_note boolean;
BEGIN
  SELECT a.supplier_credit_note_id IS NOT NULL INTO is_note
    FROM supplier_payment_allocations a WHERE a.id = NEW.allocation_id;
  IF is_note AND NEW.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Allocation % applied a credit note, which posted nothing; its reversal posts nothing either.', NEW.allocation_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT is_note AND NEW.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Allocation % moved money onto AP; its reversal must carry the mirror entry.', NEW.allocation_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER supplier_payment_allocation_reversals_je_rule
  BEFORE INSERT ON public."supplier_payment_allocation_reversals"
  FOR EACH ROW EXECUTE FUNCTION check_supplier_allocation_reversal();
