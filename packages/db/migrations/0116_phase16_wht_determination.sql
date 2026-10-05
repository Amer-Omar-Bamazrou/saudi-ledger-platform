ALTER TABLE "wht_withholdings" DROP CONSTRAINT "wht_withholdings_status_chk";--> statement-breakpoint
ALTER TABLE "wht_withholdings" DROP CONSTRAINT "wht_withholdings_not_subject_chk";--> statement-breakpoint
DROP INDEX "wht_withholdings_supplier_payment_unq";--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD COLUMN "payment_class" text;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD COLUMN "nature_basis" text;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD COLUMN "supersedes_withholding_id" integer;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_supersedes_withholding_id_wht_withholdings_id_fk" FOREIGN KEY ("supersedes_withholding_id") REFERENCES "public"."wht_withholdings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wht_withholdings_supersedes_unq" ON "wht_withholdings" USING btree ("supersedes_withholding_id") WHERE supersedes_withholding_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wht_withholdings_supplier_payment_unq" ON "wht_withholdings" USING btree ("supplier_payment_id") WHERE supplier_payment_id is not null and supersedes_withholding_id is null;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_class_reason_chk" CHECK ("wht_withholdings"."not_subject_reason" is null or "wht_withholdings"."not_subject_reason" not in ('refundable_deposit', 'erroneous_payment') or "wht_withholdings"."payment_type" is null);--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_pending_chk" CHECK ("wht_withholdings"."status" <> 'pending' or ("wht_withholdings"."rate" = 0 and "wht_withholdings"."wht_amount" = 0 and "wht_withholdings"."payment_type" is null and "wht_withholdings"."not_subject_reason" is null and "wht_withholdings"."rate_id" is null and "wht_withholdings"."statutory_rate" is null and "wht_withholdings"."treaty_relief_id" is null));--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_class_chk" CHECK ("wht_withholdings"."payment_class" is null or "wht_withholdings"."payment_class" in ('bill_payment', 'advance', 'allocated', 'security_deposit', 'erroneous', 'unknown'));--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_basis_chk" CHECK ("wht_withholdings"."nature_basis" is null or "wht_withholdings"."nature_basis" in ('declared', 'supplier_default', 'payment_class'));--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_status_chk" CHECK ("wht_withholdings"."status" in ('withheld', 'not_subject', 'pending'));--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_not_subject_chk" CHECK ("wht_withholdings"."status" <> 'not_subject' or ("wht_withholdings"."rate" = 0 and "wht_withholdings"."not_subject_reason" in ('goods', 'not_kingdom_source', 'refundable_deposit', 'erroneous_payment') and "wht_withholdings"."rate_id" is null and "wht_withholdings"."treaty_relief_id" is null));
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Accountant Q2 (2026-10-05) — the WHT determination is category-aware.
-- Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §14.2.
--
-- Before: every payment to a non-resident withheld at the declared nature or
-- the supplier's default — a refundable deposit, an erroneous and an
-- unidentified payment too (D-12, QA-09). The accountant: the nature of the
-- payment decides, never residency alone; a deposit and an erroneous payment
-- are not subject; an unidentified one is PENDING until identified.
--
-- 🔴 Made inexpressible here, not only refused in the service: the admit
-- reads what the money WAS (a bill payment, or the supplier payment's
-- classification and its own allocations) and admits only the determination
-- that class allows. Residency (non-resident only — 0113) and the rate in
-- force (0113) stay; this adds the third dimension. A withholding on a deposit
-- is now a database refusal for every path, the service included.
--
-- Rows written before this migration keep NULL provenance (payment_class,
-- nature_basis): what was decided then is not re-derived, and the table is
-- append-only. Every new row states both.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION wht_withholdings_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p record; v record; r record; rel record; e record; s record; cls text; on_account numeric;
BEGIN
  IF NEW.source_kind = 'bill_payment' THEN
    SELECT bp.id, bp.organization_id, bp.company_id, bp.amount, bp.paid_at, bp.journal_entry_id, bp.bill_id, b.vendor_id
      INTO p FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id WHERE bp.id = NEW.bill_payment_id;
    IF p.id IS NOT NULL AND NEW.bill_id IS DISTINCT FROM p.bill_id THEN
      RAISE EXCEPTION 'withholding: bill % is not the bill payment %''s bill', NEW.bill_id, NEW.bill_payment_id USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_payment';
    END IF;
  ELSE
    SELECT sp.id, sp.organization_id, sp.company_id, sp.amount, sp.paid_at, sp.journal_entry_id, NULL::integer AS bill_id, sp.vendor_id
      INTO p FROM supplier_payments sp WHERE sp.id = NEW.supplier_payment_id;
    IF NEW.bill_id IS NOT NULL THEN
      RAISE EXCEPTION 'withholding: a supplier payment''s withholding names no single bill' USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_payment';
    END IF;
  END IF;
  IF p.id IS NULL OR p.organization_id IS DISTINCT FROM NEW.organization_id OR p.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'withholding: the payment is not in this organisation and company' USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_tenant';
  END IF;
  IF p.vendor_id IS DISTINCT FROM NEW.vendor_id OR p.paid_at IS DISTINCT FROM NEW.payment_date
     OR p.amount IS DISTINCT FROM NEW.base_amount OR p.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id THEN
    RAISE EXCEPTION 'withholding: its supplier, date, base and entry must be the payment''s own (supplier %, %, %, entry %)', p.vendor_id, p.paid_at, p.amount, p.journal_entry_id
      USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_payment';
  END IF;
  SELECT id, organization_id, residency INTO v FROM vendors WHERE id = NEW.vendor_id;
  IF v.id IS NULL OR v.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'withholding: supplier % is not in this organisation', NEW.vendor_id USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_tenant';
  END IF;
  -- dimension 1 — the recipient: only a payment to a NON-RESIDENT is judged at all (Income Tax Law Art. 68)
  IF v.residency <> 'non_resident' THEN
    RAISE EXCEPTION 'withholding: supplier % is not declared non-resident (Income Tax Law Art. 68)', NEW.vendor_id USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_residency';
  END IF;
  SELECT id, organization_id, company_id INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF e.id IS NULL OR e.organization_id IS DISTINCT FROM NEW.organization_id OR e.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'withholding: entry % is not in this organisation and company', NEW.journal_entry_id USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_tenant';
  END IF;

  -- dimension 2 — 🔴 what the money WAS (Q2). Never residency alone.
  IF NEW.payment_class IS NULL OR NEW.nature_basis IS NULL THEN
    RAISE EXCEPTION 'withholding: a new record states what the money was and how its nature was established (payment_class, nature_basis)'
      USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_provenance';
  END IF;
  IF NEW.source_kind = 'bill_payment' THEN
    cls := 'bill_payment';
  ELSE
    -- the payment's own allocations (inserted in its entry, before this row) say whether any of it is on account
    SELECT sp.amount - coalesce((SELECT sum(a.amount) FROM supplier_payment_allocations a
                                  WHERE a.supplier_payment_id = sp.id AND a.journal_entry_id = sp.journal_entry_id), 0),
           sp.classification
      INTO on_account, cls FROM supplier_payments sp WHERE sp.id = NEW.supplier_payment_id;
    IF on_account <= 0 THEN cls := 'allocated'; END IF;
  END IF;
  IF NEW.payment_class IS DISTINCT FROM cls THEN
    RAISE EXCEPTION 'withholding: the payment is %, not % (its classification and allocations decide its class)', cls, NEW.payment_class
      USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_class';
  END IF;
  IF (cls = 'security_deposit' AND NOT (NEW.status = 'not_subject' AND NEW.not_subject_reason = 'refundable_deposit'))
     OR (cls = 'erroneous' AND NOT (NEW.status = 'not_subject' AND NEW.not_subject_reason = 'erroneous_payment'))
     OR (cls = 'unknown' AND NEW.status <> 'pending')
     OR (cls IN ('bill_payment', 'advance', 'allocated')
         AND NOT (NEW.status = 'withheld' OR (NEW.status = 'not_subject' AND NEW.not_subject_reason IN ('goods', 'not_kingdom_source')))) THEN
    RAISE EXCEPTION 'withholding: a % payment cannot be recorded % (%): a refundable deposit and an erroneous payment are not subject, an unidentified one is pending, and only consideration is withheld',
      cls, NEW.status, coalesce(NEW.not_subject_reason, coalesce(NEW.payment_type, '-'))
      USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_class';
  END IF;

  -- a reclassification SUPERSEDES the payment's pending or not-subject record; it never withholds
  IF NEW.supersedes_withholding_id IS NOT NULL THEN
    SELECT id, supplier_payment_id, status INTO s FROM wht_withholdings WHERE id = NEW.supersedes_withholding_id;
    IF s.id IS NULL OR NEW.source_kind <> 'supplier_payment' OR s.supplier_payment_id IS DISTINCT FROM NEW.supplier_payment_id THEN
      RAISE EXCEPTION 'withholding: % supersedes only a record of the same supplier payment', NEW.supersedes_withholding_id
        USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_supersede';
    END IF;
    IF s.status NOT IN ('pending', 'not_subject') THEN
      RAISE EXCEPTION 'withholding: record % withheld tax; a withholding is corrected (reversed and re-entered), never superseded', s.id
        USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_supersede';
    END IF;
    IF NEW.status = 'withheld' THEN
      RAISE EXCEPTION 'withholding: the payment was made with nothing withheld; tax on it now is open question W-16, never recorded by a reclassification'
        USING ERRCODE = '23514', CONSTRAINT = 'wht_late_withholding';
    END IF;
  END IF;

  -- dimension 3 — the rate: the statutory row in force on the payment date, or an approved relief covering it
  IF NEW.status = 'withheld' THEN
    SELECT id, rate INTO r FROM wht_rates
     WHERE payment_type = NEW.payment_type AND effective_from <= NEW.payment_date AND (effective_to IS NULL OR effective_to >= NEW.payment_date);
    IF r.id IS NULL OR r.id IS DISTINCT FROM NEW.rate_id OR r.rate IS DISTINCT FROM NEW.statutory_rate THEN
      RAISE EXCEPTION 'withholding: the rate must be the % rate in force on % (wht_rates)', NEW.payment_type, NEW.payment_date
        USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_rate';
    END IF;
    IF NEW.treaty_relief_id IS NULL THEN
      IF NEW.rate IS DISTINCT FROM r.rate THEN
        RAISE EXCEPTION 'withholding: without a treaty relief the rate is the statutory % (not %)', r.rate, NEW.rate USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_rate';
      END IF;
    ELSE
      SELECT id, company_id, vendor_id, payment_type, reduced_rate, valid_from, valid_to, status INTO rel FROM vendor_wht_treaty_reliefs WHERE id = NEW.treaty_relief_id;
      IF rel.id IS NULL OR rel.company_id IS DISTINCT FROM NEW.company_id OR rel.vendor_id IS DISTINCT FROM NEW.vendor_id
         OR rel.payment_type IS DISTINCT FROM NEW.payment_type OR rel.status <> 'approved'
         OR NEW.payment_date < rel.valid_from OR NEW.payment_date > rel.valid_to OR rel.reduced_rate IS DISTINCT FROM NEW.rate THEN
        RAISE EXCEPTION 'withholding: treaty relief % does not cover this supplier, nature and date, or is not approved', NEW.treaty_relief_id
          USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_relief';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_withholdings_admit() FROM PUBLIC;
