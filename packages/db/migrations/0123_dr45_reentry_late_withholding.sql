-- ════════════════════════════════════════════════════════════════════════════
-- DR-45 (II) (Phase 18, owner-authorised 2026-10-20; register DR-45, HIGH): A
-- CORRECTION'S RE-ENTRY NEVER TURNS A PAYMENT MADE WITH NOTHING WITHHELD INTO A
-- WITHHELD ONE.
--
-- The rule `wht_late_withholding` (0116, kept in 0117) refused a withheld row
-- only when it SUPERSEDES a pending or not-subject record (a reclassification).
-- A WHT correction's re-entry is a NEW row linked by `correction_id`, so it
-- escaped the rule: an unidentified payment or a refundable deposit could be
-- reversed and re-entered as a withheld advance (reproduced, Batch 4B proof D).
-- The rule now covers re-entries too, under the SAME constraint name, so the
-- refusal maps to the same 409 as a reclassification's. The service refuses
-- first, before anything is written (`refuseLateWithholdingOnReentry`, both pay
-- paths); this is the backstop for any writer that skips it, and it binds every
-- role, the owner included (an ordinary BEFORE INSERT trigger).
--
-- 🔴 THIS MIGRATION REPAIRS, REWRITES AND DELETES NOTHING. It first counts the
-- re-entries that already break the rule — with the counting function the test
-- probes on a planted violation — and REFUSES TO APPLY, naming the count, if any
-- exist: such a row needs an owner's decision (the shortfall's treatment is
-- W-16, open), never a migration's. `wht_withholdings` rows are only ever
-- inserted, so the extended rule then holds for every row.
--
-- Only `wht_withholdings_admit()` is redefined — the 0117 body unchanged except
-- the one rule in its correction block. No column, constraint or table changes;
-- `seed_org_chart_of_accounts()` is untouched.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION wht_reentry_late_withholding_count() RETURNS bigint
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT count(*) FROM wht_withholdings w
    JOIN wht_corrections x ON x.id = w.correction_id
    JOIN wht_withholdings o ON o.id = x.withholding_id
   WHERE w.status = 'withheld' AND o.status IN ('pending', 'not_subject')
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_reentry_late_withholding_count() FROM PUBLIC;--> statement-breakpoint
DO $$
DECLARE n bigint;
BEGIN
  n := wht_reentry_late_withholding_count();
  IF n > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('0123 refuses to apply: %s WHT correction re-entr%s already record tax withheld on a payment whose original withheld nothing (pending or not subject).', n, CASE WHEN n = 1 THEN 'y' ELSE 'ies' END),
      HINT = 'Nothing was changed. This migration repairs and deletes nothing; each such re-entry needs an owner''s decision (register DR-45; the shortfall''s treatment is open question W-16).';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wht_withholdings_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p record; v record; r record; rel record; e record; s record; c record; cls text; on_account numeric; filed boolean;
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

  -- dimension 2 — 🔴 what the money WAS (Q2, 0116). Never residency alone.
  IF NEW.payment_class IS NULL OR NEW.nature_basis IS NULL THEN
    RAISE EXCEPTION 'withholding: a new record states what the money was and how its nature was established (payment_class, nature_basis)'
      USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_provenance';
  END IF;
  IF NEW.source_kind = 'bill_payment' THEN
    cls := 'bill_payment';
  ELSE
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
    IF EXISTS (SELECT 1 FROM wht_corrections x WHERE x.withholding_id = s.id) THEN
      RAISE EXCEPTION 'withholding: record % was corrected; its payment is reversed and is not reclassified', s.id
        USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_supersede';
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

  -- Q1 — 🔴 the RETURN month: the payment month, unless that month's Form 06 is recorded filed — then the person's treatment
  filed := EXISTS (SELECT 1 FROM wht_return_filings f WHERE f.company_id = NEW.company_id AND f.period = NEW.period);
  IF NEW.status = 'withheld' AND filed THEN
    IF NEW.filed_month_treatment IS NULL THEN
      RAISE EXCEPTION 'withholding: % is recorded as FILED; a withholding in it states whether it is reported in a later return (subsequent_period) or by amending the filed one (amendment)', NEW.period
        USING ERRCODE = '23514', CONSTRAINT = 'wht_month_filed';
    ELSIF NEW.filed_month_treatment = 'amendment' THEN
      IF NEW.return_period <> NEW.period THEN
        RAISE EXCEPTION 'withholding: an amendment reports it in its own month (%), not %', NEW.period, NEW.return_period USING ERRCODE = '23514', CONSTRAINT = 'wht_return_period';
      END IF;
    ELSE
      IF NEW.return_period <= NEW.period
         OR EXISTS (SELECT 1 FROM wht_return_filings f WHERE f.company_id = NEW.company_id AND f.period = NEW.return_period) THEN
        RAISE EXCEPTION 'withholding: a subsequent-period report goes in a LATER month whose return is not filed (not %)', NEW.return_period
          USING ERRCODE = '23514', CONSTRAINT = 'wht_return_period';
      END IF;
      IF NEW.correction_id IS NOT NULL AND NEW.return_period IS DISTINCT FROM (SELECT x.correction_period FROM wht_corrections x WHERE x.id = NEW.correction_id) THEN
        RAISE EXCEPTION 'withholding: a re-entry reported subsequently goes in its correction''s month' USING ERRCODE = '23514', CONSTRAINT = 'wht_return_period';
      END IF;
    END IF;
  ELSIF NEW.filed_month_treatment IS NOT NULL OR NEW.return_period <> NEW.period THEN
    RAISE EXCEPTION 'withholding: only a withholding in a FILED month is reported anywhere but its own month (%)', NEW.period
      USING ERRCODE = '23514', CONSTRAINT = 'wht_return_period';
  END IF;
  -- the re-entry of a correction names it, once, while the correction has no re-entry yet
  IF NEW.correction_id IS NOT NULL THEN
    SELECT id, company_id, corrected_bill_payment_id, corrected_supplier_payment_id INTO c FROM wht_corrections WHERE id = NEW.correction_id;
    IF c.id IS NULL OR c.company_id IS DISTINCT FROM NEW.company_id OR c.corrected_bill_payment_id IS NOT NULL OR c.corrected_supplier_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'withholding: correction % is not this company''s, or already has its re-entry', NEW.correction_id
        USING ERRCODE = '23514', CONSTRAINT = 'wht_correction_link';
    END IF;
    -- 🔴 DR-45 (II), 0123: a correction's re-entry never withholds on a payment made with nothing withheld
    -- (its original was `pending` or `not_subject`) — tax on it now is open question W-16, never recorded by a
    -- re-entry, exactly as a reclassification (the superseding branch above) never records it.
    IF NEW.status = 'withheld' AND EXISTS (SELECT 1 FROM wht_corrections x JOIN wht_withholdings o ON o.id = x.withholding_id
                                            WHERE x.id = NEW.correction_id AND o.status IN ('pending', 'not_subject')) THEN
      RAISE EXCEPTION 'withholding: correction % re-enters a payment made with nothing withheld; tax on it now is open question W-16, never recorded by a correction''s re-entry', NEW.correction_id
        USING ERRCODE = '23514', CONSTRAINT = 'wht_late_withholding';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_withholdings_admit() FROM PUBLIC;
