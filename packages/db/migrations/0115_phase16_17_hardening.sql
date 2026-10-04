-- Phase 16 + 17 — hardening found by the recovery audit and the joint audit
-- (docs/product/phase-16-17-tax-treasury-decision-pack.md §13). Every
-- statement is idempotent: CREATE OR REPLACE, DELETE … WHERE.

-- ── 1. 🔴 `delete` is admin-only, everywhere (permission-seed-grants) ──────
-- 0114 granted treasury `delete` to the accountant and the bookkeeper. The
-- platform rule has no exception: a bookkeeper never holds approve or delete,
-- and delete is an admin's on every resource that has it (budgets, recurring,
-- invoices, bills …). The two routes it gates — deleting a never-approved plan
-- and deleting a forecast assumption — follow it.
DELETE FROM "permissions" WHERE resource = 'treasury' AND action = 'delete' AND role <> 'admin';--> statement-breakpoint

-- ── 2. 🔴 Policy C: a reversed opening bill is never planned for payment ───
-- (Batch 1C pack §16.12.1, accountant A4.) A migration's reversal MARKS its
-- opening bills (`reversed_at`) and they are history: nothing acts on them.
-- The admit refuses a plan on one; the approval refuses one whose bill was
-- reversed after it was planned (a cancellation stays possible — that is how
-- the plan is closed). The batch reversal itself is refused while an opening
-- bill has an open plan (migration.repository touchesSinceCommit).
CREATE OR REPLACE FUNCTION scheduled_payments_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b record; ba record;
BEGIN
  SELECT id, organization_id, company_id, status, document_type, reversed_at INTO b FROM bills WHERE id = NEW.bill_id;
  -- a foreign bill is answered exactly like a missing one
  IF b.id IS NULL OR b.organization_id IS DISTINCT FROM NEW.organization_id OR b.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'payment plan: bill % is not a bill of this organisation and company', NEW.bill_id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_tenant';
  END IF;
  IF b.status IN ('draft', 'submitted') OR b.document_type NOT IN ('bill', 'debit_note') THEN
    RAISE EXCEPTION 'payment plan: bill % is not a posted bill or debit note — only what is owed is planned', NEW.bill_id
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_bill';
  END IF;
  IF b.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'payment plan: bill % is an opening item the migration reversed — it is history and owes nothing', NEW.bill_id
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_bill_reversed';
  END IF;
  IF NEW.bank_account_id IS NOT NULL THEN
    SELECT id, organization_id, company_id INTO ba FROM bank_accounts WHERE id = NEW.bank_account_id;
    IF ba.id IS NULL OR ba.organization_id IS DISTINCT FROM NEW.organization_id OR ba.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'payment plan: bank account % is not in this organisation and company', NEW.bank_account_id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_tenant';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.status <> 'planned' OR NEW.approved_at IS NOT NULL OR NEW.paid_bill_payment_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'payment plan: a plan is created PLANNED and moves on only through its lifecycle' USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_born_planned';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION scheduled_payments_admit() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION scheduled_payments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE bp record; ba record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'planned' THEN
      RAISE EXCEPTION 'payment plan % is %: only a plan not yet approved is deleted — cancel an approved one, with its reason', OLD.id, OLD.status
        USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.bill_id IS DISTINCT FROM OLD.bill_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment plan %: its bill and author are fixed', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_identity';
  END IF;
  IF NEW.status = OLD.status THEN
    -- only a PLANNED plan's terms are edited in place
    IF OLD.status <> 'planned' OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.paid_bill_payment_id IS DISTINCT FROM OLD.paid_bill_payment_id
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
      RAISE EXCEPTION 'payment plan % is %: it cannot be changed', OLD.id, OLD.status USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_immutable';
    END IF;
    IF NEW.bank_account_id IS NOT NULL AND NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id THEN
      SELECT id, organization_id, company_id INTO ba FROM bank_accounts WHERE id = NEW.bank_account_id;
      IF ba.id IS NULL OR ba.organization_id IS DISTINCT FROM NEW.organization_id OR ba.company_id IS DISTINCT FROM NEW.company_id THEN
        RAISE EXCEPTION 'payment plan: bank account % is not in this organisation and company', NEW.bank_account_id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_tenant';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- a transition changes its own columns and nothing about the plan's terms
  IF NEW.planned_date IS DISTINCT FROM OLD.planned_date OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
     OR NEW.priority IS DISTINCT FROM OLD.priority OR NEW.wht_payment_type IS DISTINCT FROM OLD.wht_payment_type OR NEW.notes IS DISTINCT FROM OLD.notes THEN
    RAISE EXCEPTION 'payment plan %: a transition does not change the plan''s terms', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_transition';
  END IF;
  IF (OLD.status, NEW.status) = ('planned', 'approved') THEN
    IF NEW.approved_at IS NULL OR NEW.paid_bill_payment_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'payment plan %: an approval records who approved it and when', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_transition';
    END IF;
    IF EXISTS (SELECT 1 FROM bills WHERE id = OLD.bill_id AND reversed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'payment plan %: its bill is an opening item the migration reversed — cancel the plan', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_bill_reversed';
    END IF;
  ELSIF (OLD.status, NEW.status) IN (('planned', 'cancelled'), ('approved', 'cancelled')) THEN
    IF NEW.cancelled_at IS NULL OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.paid_bill_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'payment plan %: a cancellation records who cancelled it, when and why', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_transition';
    END IF;
  ELSIF (OLD.status, NEW.status) = ('approved', 'paid') THEN
    -- 🔴 paid ONLY by a real payment of THIS bill, of THIS amount, in this company
    SELECT id, bill_id, amount, company_id INTO bp FROM bill_payments WHERE id = NEW.paid_bill_payment_id;
    IF bp.id IS NULL OR bp.bill_id IS DISTINCT FROM OLD.bill_id OR bp.amount IS DISTINCT FROM OLD.amount OR bp.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.paid_at IS NULL OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'payment plan %: it is paid only by a payment of its own bill for its own amount', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_paid_by';
    END IF;
  ELSE
    RAISE EXCEPTION 'payment plan %: % → % is not a step of its lifecycle', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_transition';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION scheduled_payments_guard() FROM PUBLIC;
