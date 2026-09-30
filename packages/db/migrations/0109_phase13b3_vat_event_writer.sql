ALTER TABLE "input_vat_event_transitions" DROP CONSTRAINT "input_vat_event_transitions_role_chk";--> statement-breakpoint
ALTER TABLE "input_vat_events" DROP CONSTRAINT "input_vat_events_journal_chk";--> statement-breakpoint
CREATE UNIQUE INDEX "input_vat_events_note_journal_unq" ON "input_vat_events" USING btree ("journal_entry_id") WHERE journal_role = 'note_entry';--> statement-breakpoint
CREATE UNIQUE INDEX "input_vat_events_one_per_note_unq" ON "input_vat_events" USING btree ("related_document_id") WHERE event_type = 'reduced_by_note';--> statement-breakpoint
CREATE UNIQUE INDEX "input_vat_events_one_recognition_per_document_unq" ON "input_vat_events" USING btree ("document_id") WHERE event_type LIKE 'recognised\_%';--> statement-breakpoint
CREATE UNIQUE INDEX "input_vat_events_one_advance_deduction_unq" ON "input_vat_events" USING btree ("document_id","related_document_id") WHERE event_type = 'advance_deducted';--> statement-breakpoint
ALTER TABLE "input_vat_event_transitions" ADD CONSTRAINT "input_vat_event_transitions_role_chk" CHECK (journal_role IS NULL OR journal_role IN ('own_entry', 'claim_entry', 'event_entry', 'note_entry'));--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD CONSTRAINT "input_vat_events_journal_chk" CHECK ((journal_role IS NULL) = (journal_entry_id IS NULL) AND (journal_role IS NULL OR journal_role IN ('own_entry', 'claim_entry', 'event_entry', 'note_entry')));--> statement-breakpoint

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 13B-3 — THE INPUT-VAT EVENT WRITER, WITH THE 13B-4 BACKFILL AND ITS
-- RECONCILIATION GATE PULLED FORWARD (owner, Option A, 2026-09-29).
-- Hand-written below this line: drizzle tracks neither reference rows,
-- functions, triggers nor grants. 0107 is never edited; every change to its
-- functions is a CREATE OR REPLACE here.
-- Records: docs/product/phase-13b-vat-claim-ledger-architecture.md §26;
--          docs/product/phase-13b2-credit-note-event-design.md §19 (O-1…O-6,
--          A-B1-1…7, CI-1, D-4a, D-6).
--
-- Order matters, and is the point of pulling 13B-4 forward:
--   1–5  what the database admits and links (the writer's rules);
--   6–8  one definition each of "the document agrees with its events" and
--        "the events agree with the GL" — read by the gate, the triggers and
--        the invariant sweep alike;
--   9    the backfill: every pre-existing document gets its events, labelled
--        RECONSTRUCTED;
--   10   the gate: any disagreement names the document and STOPS the migration;
--   11   only then the cache-consistency triggers, so they never meet a
--        document the ledger has not yet seen.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. Transitions (A-B1-1; O-3). ─────────────────────────────────────────
-- A credit note reduces the ORIGINAL's single non-zero bucket and references
-- the NOTE's own entry (journal role note_entry, A-B1-3). A debit note is its
-- own document with its own recognition (O-3): increased_by_note is retired —
-- still stated, never admitted.
UPDATE "input_vat_event_transitions"
   SET admitted = true, journal_role = 'note_entry', enabled_in = '13B-3',
       basis = 'Supplier credit note on the ORIGINAL: reduces its single non-zero bucket, settled cases only (O-1, O-2; A-B1-1). NI-4 / CN-1…CN-8 refused by name'
 WHERE event_type = 'reduced_by_note';--> statement-breakpoint
UPDATE "input_vat_event_transitions"
   SET enabled_in = '—',
       basis = 'RETIRED: a debit note is its OWN document with its own recognition (O-3) — never admitted'
 WHERE event_type = 'increased_by_note';--> statement-breakpoint

-- ── 2. Who owns an entry — the DOCUMENT first (13B-3). ─────────────────────
-- 0107/0108 asked "does an event reference it?" first. From 13B-3 every
-- document's own entry IS referenced by its recognition, and every note's by
-- its reduction, so that order would answer "an input VAT movement" for a
-- bill's own posting — true, but not the next step a user needs. The same
-- three owners, most specific first: the document's own entry (0108's exact
-- prefix match), then the evidence claim, then an entry the ledger posted.
CREATE OR REPLACE FUNCTION input_vat_journal_owner(p_entry_id integer) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    (SELECT CASE WHEN e.entry_number LIKE 'BILLADVCN-%' THEN 'advance_credit_note'
                 WHEN e.entry_number LIKE 'BILLADV-%'   THEN 'advance_invoice'
                 WHEN e.entry_number LIKE 'BILLCN-%'    THEN 'supplier_note'
                 ELSE 'bill' END
       FROM journal_entries e
       JOIN bills b ON b.company_id = e.company_id
                   AND b.bill_number = CASE WHEN e.entry_number LIKE 'BILLADVCN-%' THEN substr(e.entry_number, 11)
                                            WHEN e.entry_number LIKE 'BILLADV-%'   THEN substr(e.entry_number, 9)
                                            WHEN e.entry_number LIKE 'BILLCN-%'    THEN substr(e.entry_number, 8)
                                            WHEN e.entry_number LIKE 'BILL-%'      THEN substr(e.entry_number, 6) END
                   AND (e.entry_number NOT LIKE 'BILLADVCN-%' OR b.document_type = 'advance_credit_note')
                   AND (e.entry_number NOT LIKE 'BILLADV-%'   OR b.document_type = 'advance_invoice')
      WHERE e.id = p_entry_id
        AND b.status NOT IN ('draft', 'submitted')
      LIMIT 1),
    CASE WHEN EXISTS (SELECT 1 FROM bills b WHERE b.input_vat_claim_entry_id = p_entry_id) THEN 'bill_vat_claim' END,
    CASE WHEN EXISTS (SELECT 1 FROM input_vat_events v WHERE v.journal_entry_id = p_entry_id) THEN 'input_vat_event' END)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_journal_owner(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION input_vat_journal_owner(integer) TO authenticated;--> statement-breakpoint

-- ── 3. 🔴 O-2 — the credit-note rule, ONE definition. ──────────────────────
-- Read by the admission trigger (the boundary) and by the writer BEFORE it
-- posts anything (so the user meets a refusal in words, never a raw error).
-- In the approved order (design §19.4, §19.8), with one precondition first:
--   0. the original is an OPENING (Batch 1C) payable: its VAT was accounted
--      for before the cut-over and is not in this ledger (T(D) = 0 by
--      representation, not by fact) — refused by name, NOT as an over-credit.
--      Decided conservatively in 13B-3; an open item for the owner.
--   1. CI-1: vat(n) > T(D) − N(D)  → credit_note_exceeds_invoice_vat;
--   2. NI-4: any reversal / restoration / correction / lapse in the original's
--      HISTORY → input_vat_note_interaction_undecided (CN-1…CN-6);
--   3. exactly one of HELD / CLAIMED / BLOCKED non-zero and vat(n) fits in
--      it → admitted, from THAT bucket;
--   4. otherwise → input_vat_note_allocation_undecided (CN-7, CN-8) — never
--      called an over-credit.
-- T(D) = the original's own vat_amount; N(D) = the VAT of every OTHER posted
-- credit / advance credit note against it (the note itself is excluded, so the
-- rule reads the same before and after the note posts).
CREATE OR REPLACE FUNCTION input_vat_note_refusal(p_document_id integer, p_note_id integer, p_amount numeric)
RETURNS TABLE (refusal text, from_bucket text, remaining numeric, bucket_amount numeric)
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  d record;
  others numeric;
  v_held numeric; v_claimed numeric; v_blocked numeric;
  nonzero int;
  v_bucket text;
  v_amount numeric;
  v_remaining numeric;
BEGIN
  SELECT b.id, b.is_opening, b.vat_amount INTO d FROM bills b WHERE b.id = p_document_id;
  IF d.id IS NULL THEN
    RETURN QUERY SELECT 'input_vat_note_original_missing'::text, NULL::text, 0::numeric, 0::numeric; RETURN;
  END IF;
  IF d.is_opening THEN
    RETURN QUERY SELECT 'input_vat_note_opening_original'::text, NULL::text, 0::numeric, 0::numeric; RETURN;
  END IF;
  SELECT coalesce(sum(n.vat_amount), 0) INTO others FROM bills n
   WHERE n.credit_note_against_bill_id = p_document_id
     AND n.document_type IN ('credit_note', 'advance_credit_note')
     AND n.status NOT IN ('draft', 'submitted')
     AND n.id IS DISTINCT FROM p_note_id;
  v_remaining := d.vat_amount - others;
  IF p_amount > v_remaining THEN
    RETURN QUERY SELECT 'credit_note_exceeds_invoice_vat'::text, NULL::text, v_remaining, 0::numeric; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM input_vat_events v
              WHERE v.document_id = p_document_id
                AND v.event_type IN ('reversed_unpaid', 'restored_on_payment', 'corrected_blocked', 'lapsed_expired', 'lapsed_written_off')) THEN
    RETURN QUERY SELECT 'input_vat_note_interaction_undecided'::text, NULL::text, v_remaining, 0::numeric; RETURN;
  END IF;
  SELECT coalesce(max(bl.held), 0), coalesce(max(bl.claimed), 0), coalesce(max(bl.blocked), 0)
    INTO v_held, v_claimed, v_blocked
    FROM input_vat_balances bl WHERE bl.document_id = p_document_id;
  nonzero := (v_held > 0)::int + (v_claimed > 0)::int + (v_blocked > 0)::int;
  IF nonzero = 1 THEN
    v_bucket := CASE WHEN v_held > 0 THEN 'HELD' WHEN v_claimed > 0 THEN 'CLAIMED' ELSE 'BLOCKED' END;
    v_amount := greatest(v_held, v_claimed, v_blocked);
    IF p_amount <= v_amount THEN
      RETURN QUERY SELECT NULL::text, v_bucket, v_remaining, v_amount; RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT 'input_vat_note_allocation_undecided'::text, v_bucket, v_remaining, coalesce(v_amount, 0::numeric);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_note_refusal(integer, integer, numeric) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION input_vat_note_refusal(integer, integer, numeric) TO authenticated;--> statement-breakpoint

-- ── 3b. 🔴 Is a restated idempotency key the SAME act? — ONE definition. ──
-- A key names ONE act. Restating it is a retry only when the accounting
-- content is identical — what moved, how much, when, on which document and
-- entry, caused by what, with which provenance. Not compared: who pressed the
-- button and why (actor, reason), the evidence snapshot's wording, the
-- backfill's source description, and what the database computes itself
-- (id, recorded_at, buckets_after). Read twice by the admission trigger.
CREATE OR REPLACE FUNCTION input_vat_event_restates(prev input_vat_events, candidate input_vat_events) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (prev.organization_id, prev.company_id, prev.document_id, prev.related_document_id, prev.event_type, prev.from_bucket,
          prev.to_bucket, prev.amount, prev.occurred_on, prev.posting_date, prev.trigger_month, prev.cause_type, prev.cause_id,
          prev.follows_event_id, prev.evidence_capture_id, prev.journal_entry_id, prev.journal_role, prev.correction_route,
          prev.affected_period_start, prev.affected_period_end, prev.rule_version, prev.provenance, prev.backfill_migration)
         IS NOT DISTINCT FROM
         (candidate.organization_id, candidate.company_id, candidate.document_id, candidate.related_document_id, candidate.event_type,
          candidate.from_bucket, candidate.to_bucket, candidate.amount, candidate.occurred_on, candidate.posting_date,
          candidate.trigger_month, candidate.cause_type, candidate.cause_id, candidate.follows_event_id, candidate.evidence_capture_id,
          candidate.journal_entry_id, candidate.journal_role, candidate.correction_route, candidate.affected_period_start,
          candidate.affected_period_end, candidate.rule_version, candidate.provenance, candidate.backfill_migration)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_event_restates(input_vat_events, input_vat_events) FROM PUBLIC;--> statement-breakpoint

-- ── 4. 🔴 Admission, extended (replaces 0107's). ───────────────────────────
-- Everything 0107 checked, unchanged, plus 13B-3's shape rules:
--   · no event on an OPENING payable or on a credit note ITSELF (a credit
--     note's VAT is a reduction of its original — B-1 §7);
--   · a recognition recognises EXACTLY the document's VAT net of the advance
--     VAT its prepayments already claimed (Z-AP1), on the document's date;
--   · advance_deducted states exactly one prepayment row's tax (one per
--     advance, index input_vat_events_one_advance_deduction_unq);
--   · reduced_by_note (A-B1-2/4/5, NI-1/3/6): a POSTED credit note against
--     THIS document, caused by it, on its issue date — never before the
--     original's (D-6, O-4) — for exactly its VAT, and O-2 (§3 above);
--   · 🔴 a reused idempotency key: the SAME act restated is a retry (nothing
--     recorded, nothing moved); a DIFFERENT act is refused by name
--     (`input_vat_event_idempotency_conflict`) — asked FIRST, so a shape rule
--     never mis-names it, and again under the balance lock (§3b).
CREATE OR REPLACE FUNCTION input_vat_events_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t   input_vat_event_transitions%ROWTYPE;
  d   record;
  x   record;
  nt  record;
  r   record;
  bal input_vat_balances%ROWTYPE;
  prev input_vat_events%ROWTYPE;
  amt numeric(15, 2) := coalesce(NEW.amount, 0);
  window_end text;
  expected numeric;
BEGIN
  -- 🔴 A key already recorded: a retry of the same act (it passed every check
  -- below when first written) or a different act under a reused key.
  SELECT * INTO prev FROM input_vat_events WHERE organization_id = NEW.organization_id AND idempotency_key = NEW.idempotency_key;
  IF prev.id IS NOT NULL THEN
    IF NOT input_vat_event_restates(prev, NEW) THEN
      RAISE EXCEPTION 'input VAT event: idempotency key % already records a DIFFERENT act (event % — % % → % of % on document %); a key names one act and is never reused',
        NEW.idempotency_key, prev.id, prev.event_type, prev.from_bucket, prev.to_bucket, prev.amount, prev.document_id
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_idempotency_conflict';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO t FROM input_vat_event_transitions
   WHERE event_type = NEW.event_type AND from_bucket = NEW.from_bucket AND to_bucket = NEW.to_bucket;
  IF NOT FOUND OR NOT t.admitted THEN
    RAISE EXCEPTION 'input VAT event % (% → %) is not admitted', NEW.event_type, NEW.from_bucket, NEW.to_bucket
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_not_admitted';
  END IF;
  IF NEW.journal_role IS DISTINCT FROM t.journal_role THEN
    RAISE EXCEPTION 'input VAT event %: journal role must be %, not %', NEW.event_type, coalesce(t.journal_role, 'none'), coalesce(NEW.journal_role, 'none')
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_role';
  END IF;

  -- Tenancy. An FK check runs OUTSIDE RLS (CLAUDE.md §3), so every row the
  -- event points at must belong to the event's own organisation and company.
  SELECT id, organization_id, company_id, status, date, document_type, is_opening, vat_amount, bill_number INTO d FROM bills WHERE id = NEW.document_id;
  IF d.organization_id IS DISTINCT FROM NEW.organization_id OR d.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'input VAT event: document % is not in this organisation and company', NEW.document_id
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_tenant';
  END IF;
  IF d.status IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'input VAT event: document % is not posted', NEW.document_id
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_document_not_posted';
  END IF;
  IF NEW.related_document_id IS NOT NULL THEN
    SELECT organization_id, company_id INTO x FROM bills WHERE id = NEW.related_document_id;
    IF x.organization_id IS DISTINCT FROM NEW.organization_id OR x.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'input VAT event: related document % is not in this organisation and company', NEW.related_document_id
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_tenant';
    END IF;
  END IF;
  IF NEW.evidence_capture_id IS NOT NULL THEN
    SELECT organization_id, company_id INTO x FROM captured_documents WHERE id = NEW.evidence_capture_id;
    IF x.organization_id IS DISTINCT FROM NEW.organization_id OR x.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'input VAT event: capture % is not in this organisation and company', NEW.evidence_capture_id
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_tenant';
    END IF;
  END IF;
  IF NEW.journal_entry_id IS NOT NULL THEN
    SELECT organization_id, company_id INTO x FROM journal_entries WHERE id = NEW.journal_entry_id;
    IF x.organization_id IS DISTINCT FROM NEW.organization_id OR x.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'input VAT event: journal entry % is not in this organisation and company', NEW.journal_entry_id
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_tenant';
    END IF;
  END IF;
  IF NEW.follows_event_id IS NOT NULL THEN
    SELECT document_id, company_id, event_type INTO x FROM input_vat_events WHERE id = NEW.follows_event_id;
    IF x.company_id IS DISTINCT FROM NEW.company_id OR x.document_id IS DISTINCT FROM NEW.document_id THEN
      RAISE EXCEPTION 'input VAT event: it may only follow an event of the same document'
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_tenant';
    END IF;
  END IF;

  -- 13B-3: which documents carry events at all.
  IF d.is_opening THEN
    RAISE EXCEPTION 'input VAT event: document % (%) is an opening (Batch 1C) payable — its VAT was accounted for before the cut-over and is not in this ledger',
      NEW.document_id, d.bill_number
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_shape';
  END IF;
  IF d.document_type IN ('credit_note', 'advance_credit_note') THEN
    RAISE EXCEPTION 'input VAT event: % is a supplier credit note — its VAT is recorded on the document it corrects (reduced_by_note), never as an event of its own',
      d.bill_number
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_shape';
  END IF;

  -- 13B-3: a credit note's reduction (A-B1-5; NI-1, NI-6; D-6 / O-4).
  IF NEW.event_type = 'reduced_by_note' THEN
    SELECT id, document_type, credit_note_against_bill_id, status, vat_amount, date, bill_number INTO nt FROM bills WHERE id = NEW.related_document_id;
    IF nt.id IS NULL OR nt.document_type NOT IN ('credit_note', 'advance_credit_note')
       OR nt.credit_note_against_bill_id IS DISTINCT FROM NEW.document_id OR nt.status IN ('draft', 'submitted') THEN
      RAISE EXCEPTION 'input VAT event reduced_by_note on % must name a POSTED supplier credit note against it (named: %)', d.bill_number, coalesce(NEW.related_document_id::text, 'none')
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_shape';
    END IF;
    IF NEW.cause_type IS DISTINCT FROM 'credit_note' OR NEW.cause_id IS DISTINCT FROM nt.id THEN
      RAISE EXCEPTION 'input VAT event reduced_by_note: its cause is the credit note % itself (cause_type credit_note, cause_id %)', nt.bill_number, nt.id
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_shape';
    END IF;
    IF nt.date < d.date THEN
      RAISE EXCEPTION 'supplier credit note % is dated %, before the document it corrects (% dated %) — a note corrects an invoice already issued (IR Art. 54(4))',
        nt.bill_number, nt.date, d.bill_number, d.date
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_note_before_original';
    END IF;
    IF NEW.occurred_on IS DISTINCT FROM nt.date THEN
      RAISE EXCEPTION 'input VAT event reduced_by_note: it occurs on the note''s issue date % (IR Art. 40(6)), not %', nt.date, NEW.occurred_on
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_dates';
    END IF;
    IF amt <> nt.vat_amount THEN
      RAISE EXCEPTION 'input VAT event reduced_by_note: it reduces exactly the note''s VAT %, not %', nt.vat_amount, amt
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_amount';
    END IF;
  END IF;

  -- Dates. No event precedes its document; the statutory date and the posting
  -- date are the same fact for every type but a 40(11) restoration ("or any
  -- later tax period"). 🔴 So a lapse can never be posted on another date
  -- than its real expiry date (A-7 / G2 — not approved, not decided).
  IF NEW.occurred_on < d.date THEN
    RAISE EXCEPTION 'input VAT event: % is before document % (dated %)', NEW.occurred_on, NEW.document_id, d.date
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_dates';
  END IF;
  IF NEW.event_type <> 'restored_on_payment' AND NEW.posting_date <> NEW.occurred_on THEN
    RAISE EXCEPTION 'input VAT event %: posting date % must equal its date % (moving a lapse to another date is not decided — G2)',
      NEW.event_type, NEW.posting_date, NEW.occurred_on
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_dates';
  END IF;
  -- The deduction window, anchored on bills.date EXACTLY as bills_vat_evidence_gate
  -- is (IR 49(8); five calendar years after the year). 13B-5 moves both to the supply date.
  window_end := (substr(d.date, 1, 4)::int + 5)::text || '-12-31';
  IF NEW.event_type IN ('claimed', 'restored_on_payment') AND NEW.posting_date > window_end THEN
    RAISE EXCEPTION 'input VAT event %: % is after the deduction window, which ended %', NEW.event_type, NEW.posting_date, window_end
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_window';
  END IF;
  IF NEW.event_type = 'lapsed_expired' AND NEW.occurred_on <> window_end THEN
    RAISE EXCEPTION 'input VAT event lapsed_expired: its date must be the window end %, not %', window_end, NEW.occurred_on
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_window';
  END IF;
  IF NEW.event_type = 'lapsed_written_off' AND NEW.occurred_on > window_end THEN
    RAISE EXCEPTION 'input VAT event lapsed_written_off: % is after the window end % — that is an expiry', NEW.occurred_on, window_end
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_window';
  END IF;

  -- Shape, per type.
  IF NEW.event_type = 'restored_on_payment'
     AND (NEW.cause_id IS NULL OR NEW.follows_event_id IS NULL
          OR (SELECT event_type FROM input_vat_events WHERE id = NEW.follows_event_id) IS DISTINCT FROM 'reversed_unpaid') THEN
    RAISE EXCEPTION 'input VAT event restored_on_payment must name its payment (cause_id) and follow a reversed_unpaid of the same document'
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_shape';
  END IF;
  IF NEW.event_type = 'advance_deducted' AND (NEW.amount IS NULL OR NEW.related_document_id IS NULL) THEN
    RAISE EXCEPTION 'input VAT event advance_deducted must state its amount and the advance it deducts'
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_shape';
  END IF;
  -- 13B-3: the exact figures (0107 bounded them; the writer's rule is now the database's).
  IF NEW.event_type = 'advance_deducted' THEN
    SELECT p.tax_amount INTO x FROM bill_prepayments p WHERE p.bill_id = NEW.document_id AND p.advance_bill_id = NEW.related_document_id;
    IF x.tax_amount IS NULL OR x.tax_amount <> amt OR NEW.occurred_on <> d.date THEN
      RAISE EXCEPTION 'input VAT event advance_deducted on %: it states the prepayment''s tax % on the bill''s date %, not % on %',
        d.bill_number, coalesce(x.tax_amount::text, '(no prepayment of that advance)'), d.date, amt, NEW.occurred_on
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_amount';
    END IF;
  END IF;
  IF NEW.event_type LIKE 'recognised\_%' THEN
    expected := d.vat_amount - coalesce((SELECT sum(p.tax_amount) FROM bill_prepayments p WHERE p.bill_id = NEW.document_id), 0);
    IF amt <> expected OR NEW.occurred_on <> d.date THEN
      RAISE EXCEPTION 'input VAT event % on %: a recognition states the document''s VAT net of the advance VAT already claimed (%), on its date %; not % on %',
        NEW.event_type, d.bill_number, expected, d.date, amt, NEW.occurred_on
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_amount';
    END IF;
  END IF;

  -- 🔴 Buckets: lock the document's balance row, refuse any negative, and
  -- state the result on the row itself. The caller's buckets_after is ignored.
  INSERT INTO input_vat_balances (document_id, organization_id, company_id)
  VALUES (NEW.document_id, NEW.organization_id, NEW.company_id)
  ON CONFLICT (document_id) DO NOTHING;
  SELECT * INTO bal FROM input_vat_balances WHERE document_id = NEW.document_id FOR UPDATE;
  -- A RETRY of an act already recorded (same organisation + idempotency key):
  -- the balance-dependent checks below would judge it against the balance the
  -- first attempt already moved, and refuse it wrongly. Skip them; the row
  -- meets input_vat_events_idempotency_unq — ON CONFLICT DO NOTHING swallows
  -- it (no AFTER trigger fires, no balance moves), a plain INSERT gets 23505.
  -- Checked UNDER the lock, so a concurrent first attempt is seen once committed.
  -- 🔴 13B-3: a key is a RETRY only when it restates the SAME act. The recorded
  -- event's accounting content — what moved, how much, when, on which
  -- document and entry, caused by what, with which provenance — must be
  -- identical; otherwise the key is being reused for a different act, and that
  -- is refused by name (never swallowed by ON CONFLICT DO NOTHING). Not
  -- compared: who pressed the button and why (actor, reason), the evidence
  -- snapshot's wording, the backfill's source description, and what the
  -- database computes itself (recorded_at, buckets_after).
  -- (A concurrent first attempt, committed while this one waited on the lock.)
  SELECT * INTO prev FROM input_vat_events WHERE organization_id = NEW.organization_id AND idempotency_key = NEW.idempotency_key;
  IF prev.id IS NOT NULL THEN
    IF NOT input_vat_event_restates(prev, NEW) THEN
      RAISE EXCEPTION 'input VAT event: idempotency key % already records a DIFFERENT act (event % — % % → % of % on document %); a key names one act and is never reused',
        NEW.idempotency_key, prev.id, prev.event_type, prev.from_bucket, prev.to_bucket, prev.amount, prev.document_id
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_idempotency_conflict';
    END IF;
    RETURN NEW;
  END IF;
  -- 🔴 O-2, under the lock (§3 above — the same function the writer asks first).
  IF NEW.event_type = 'reduced_by_note' THEN
    SELECT * INTO r FROM input_vat_note_refusal(NEW.document_id, NEW.related_document_id, amt);
    IF r.refusal IS NOT NULL THEN
      RAISE EXCEPTION '%', CASE r.refusal
          WHEN 'credit_note_exceeds_invoice_vat' THEN format('supplier credit note %s reduces VAT by %s, but only %s of the VAT charged on %s (%s) is left after its other credit notes (IR Art. 54(1))', nt.bill_number, amt, r.remaining, d.bill_number, d.vat_amount)
          WHEN 'input_vat_note_interaction_undecided' THEN format('%s has a non-payment reversal, restoration, Art. 50 correction or lapse in its history; how a credit note applies after one is not decided (CN-1…CN-6)', d.bill_number)
          WHEN 'input_vat_note_allocation_undecided' THEN format('supplier credit note %s (VAT %s) is within the VAT charged on %s but does not fit its single VAT position (%s %s); how it would be allocated is not decided (CN-7 / CN-8)', nt.bill_number, amt, d.bill_number, coalesce(r.from_bucket, 'none'), r.bucket_amount)
          WHEN 'input_vat_note_opening_original' THEN format('%s is an opening (Batch 1C) payable; its VAT is not in this ledger, so a credit note against it cannot be recorded here yet', d.bill_number)
          ELSE format('supplier credit note %s: %s', nt.bill_number, r.refusal) END
        USING ERRCODE = '23514', CONSTRAINT = r.refusal;
    END IF;
    IF r.from_bucket IS DISTINCT FROM NEW.from_bucket THEN
      RAISE EXCEPTION 'input VAT event reduced_by_note on %: the document''s VAT is % — the note cannot reduce %', d.bill_number, r.from_bucket, NEW.from_bucket
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_note_bucket';
    END IF;
  END IF;
  IF NEW.event_type = 'claimed' AND amt <> bal.held THEN
    RAISE EXCEPTION 'input VAT event claimed: % must be the WHOLE held amount % — no partial claims (D13B-05)', amt, bal.held
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_partial_claim';
  END IF;
  CASE NEW.from_bucket
    WHEN 'HELD'              THEN bal.held              := bal.held - amt;
    WHEN 'CLAIMED'           THEN bal.claimed           := bal.claimed - amt;
    WHEN 'REVERSED_UNPAID'   THEN bal.reversed_unpaid   := bal.reversed_unpaid - amt;
    WHEN 'BLOCKED'           THEN bal.blocked           := bal.blocked - amt;
    WHEN 'CORRECTED_BLOCKED' THEN bal.corrected_blocked := bal.corrected_blocked - amt;
    WHEN 'LAPSED'            THEN bal.lapsed            := bal.lapsed - amt;
    ELSE NULL;
  END CASE;
  CASE NEW.to_bucket
    WHEN 'HELD'              THEN bal.held              := bal.held + amt;
    WHEN 'CLAIMED'           THEN bal.claimed           := bal.claimed + amt;
    WHEN 'REVERSED_UNPAID'   THEN bal.reversed_unpaid   := bal.reversed_unpaid + amt;
    WHEN 'BLOCKED'           THEN bal.blocked           := bal.blocked + amt;
    WHEN 'CORRECTED_BLOCKED' THEN bal.corrected_blocked := bal.corrected_blocked + amt;
    WHEN 'LAPSED'            THEN bal.lapsed            := bal.lapsed + amt;
    ELSE NULL;
  END CASE;
  IF bal.held < 0 OR bal.claimed < 0 OR bal.reversed_unpaid < 0 OR bal.blocked < 0 OR bal.corrected_blocked < 0 OR bal.lapsed < 0 THEN
    RAISE EXCEPTION 'input VAT event % on document %: bucket % would go negative', NEW.event_type, NEW.document_id, NEW.from_bucket
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_bucket_negative';
  END IF;
  NEW.buckets_after := jsonb_build_object(
    'held', bal.held, 'claimed', bal.claimed, 'reversed_unpaid', bal.reversed_unpaid,
    'blocked', bal.blocked, 'corrected_blocked', bal.corrected_blocked, 'lapsed', bal.lapsed);
  RETURN NEW;
END $$;--> statement-breakpoint

-- ── 5. 🔴 Journal linkage, extended (replaces 0107's; still at COMMIT). ─────
--   own_entry  — the document's own posting: BILL-<n> (a bill, a debit note),
--                BILLADV-<n> (a supplier advance invoice; A-B1-7, NI-7);
--   note_entry — the NOTE's own posting: BILLCN-<note> / BILLADVCN-<note>
--                (A-B1-3, NI-2), its amount the note entry's CREDIT on the
--                bucket's account (A-B1-4, NI-3): HELD → awaiting evidence,
--                CLAIMED → Input VAT; BLOCKED → no VAT line at all (X5);
--   recognised_blocked — its entry carries NO VAT line (X5: the VAT is cost).
CREATE OR REPLACE FUNCTION input_vat_events_journal_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  e record;
  d record;
  nt record;
  acct_dr numeric;
  acct_cr numeric;
  code text;
  side text;
  vat_input_cr numeric;
  vat_lines numeric;
  own_number text;
  note_number text;
BEGIN
  IF NEW.journal_entry_id IS NULL THEN RETURN NULL; END IF;
  SELECT id, company_id, status, date, source, entry_number INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
  SELECT bill_number, document_type, vat_amount, input_vat_claim_entry_id INTO d FROM bills WHERE id = NEW.document_id;
  IF e.company_id IS DISTINCT FROM NEW.company_id OR e.status IS DISTINCT FROM 'posted' OR e.date IS DISTINCT FROM NEW.posting_date THEN
    RAISE EXCEPTION 'input VAT event % (document %): its entry % must be a POSTED entry of the same company dated % (it is %, dated %)',
      NEW.id, d.bill_number, NEW.journal_entry_id, NEW.posting_date, e.status, e.date
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_link';
  END IF;
  IF e.source IN ('opening', 'opening_reversal', 'opening_correction') THEN
    RAISE EXCEPTION 'input VAT event %: an opening (Batch 1C) entry is never an input VAT event''s entry', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_link';
  END IF;
  own_number := CASE d.document_type WHEN 'advance_invoice' THEN 'BILLADV-' ELSE 'BILL-' END || d.bill_number;
  IF NEW.journal_role = 'note_entry' THEN
    SELECT bill_number, document_type, vat_amount INTO nt FROM bills WHERE id = NEW.related_document_id;
    note_number := CASE nt.document_type WHEN 'advance_credit_note' THEN 'BILLADVCN-' ELSE 'BILLCN-' END || nt.bill_number;
  END IF;
  IF (NEW.journal_role = 'own_entry'   AND e.entry_number IS DISTINCT FROM own_number)
  OR (NEW.journal_role = 'note_entry'  AND e.entry_number IS DISTINCT FROM note_number)
  OR (NEW.journal_role = 'claim_entry' AND d.input_vat_claim_entry_id IS DISTINCT FROM e.id)
  OR (NEW.journal_role = 'event_entry' AND e.source IS DISTINCT FROM 'input_vat_event') THEN
    RAISE EXCEPTION 'input VAT event % (document %): entry % (%) is not the % its role names', NEW.id, d.bill_number, e.id, e.entry_number, NEW.journal_role
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_link';
  END IF;

  -- The amount is the entry's line on the bucket's account.
  code := CASE NEW.event_type
            WHEN 'recognised_claimed'  THEN 'VAT_INPUT'
            WHEN 'recognised_held'     THEN 'VAT_AWAITING_EVIDENCE'
            WHEN 'claimed'             THEN 'VAT_INPUT'
            WHEN 'reversed_unpaid'     THEN 'VAT_ADJ_NONPAYMENT'
            WHEN 'restored_on_payment' THEN 'VAT_ADJ_NONPAYMENT'
            WHEN 'corrected_blocked'   THEN 'VAT_ADJ_BLOCKED'
            WHEN 'lapsed_written_off'  THEN 'VAT_AWAITING_EVIDENCE'
            WHEN 'lapsed_expired'      THEN 'VAT_AWAITING_EVIDENCE'
            WHEN 'reduced_by_note'     THEN CASE NEW.from_bucket WHEN 'HELD' THEN 'VAT_AWAITING_EVIDENCE' WHEN 'CLAIMED' THEN 'VAT_INPUT' END END;
  side := CASE WHEN NEW.event_type IN ('recognised_claimed', 'recognised_held', 'claimed', 'restored_on_payment') THEN 'dr' ELSE 'cr' END;
  IF code IS NOT NULL THEN
    SELECT coalesce(sum(l.debit_amount), 0), coalesce(sum(l.credit_amount), 0) INTO acct_dr, acct_cr
      FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
     WHERE l.journal_entry_id = e.id AND c.system_code = code;
    IF (side = 'dr' AND acct_dr <> NEW.amount) OR (side = 'cr' AND acct_cr <> NEW.amount) THEN
      RAISE EXCEPTION 'input VAT event % (%, document %): amount % is not the entry''s % % line (% dr / % cr)',
        NEW.id, NEW.event_type, d.bill_number, NEW.amount, code, side, acct_dr, acct_cr
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_amount';
    END IF;
  ELSIF NEW.amount IS NOT NULL AND NEW.amount > d.vat_amount AND NEW.event_type <> 'reduced_by_note' THEN
    RAISE EXCEPTION 'input VAT event % (%): amount % exceeds the document''s VAT %', NEW.id, NEW.event_type, NEW.amount, d.vat_amount
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_amount';
  END IF;
  -- X5: blocked VAT is COST — its entry carries no VAT line at all.
  IF NEW.event_type = 'recognised_blocked' OR (NEW.event_type = 'reduced_by_note' AND NEW.from_bucket = 'BLOCKED') THEN
    SELECT coalesce(sum(l.debit_amount + l.credit_amount), 0) INTO vat_lines
      FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
     WHERE l.journal_entry_id = e.id AND c.system_code IN ('VAT_INPUT', 'VAT_AWAITING_EVIDENCE');
    IF vat_lines <> 0 THEN
      RAISE EXCEPTION 'input VAT event % (%, document %): blocked VAT is cost — entry % must carry no VAT line (it carries %)',
        NEW.id, NEW.event_type, d.bill_number, e.entry_number, vat_lines
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_amount';
    END IF;
    -- (nt is assigned only for a note's event — a separate IF, since plpgsql's OR does not short-circuit.)
    IF NEW.event_type = 'reduced_by_note' THEN
      IF NEW.amount IS DISTINCT FROM nt.vat_amount THEN
        RAISE EXCEPTION 'input VAT event % (reduced_by_note, document %): a blocked note reduces exactly its own VAT %, not %',
          NEW.id, d.bill_number, nt.vat_amount, NEW.amount
          USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_amount';
      END IF;
    END IF;
  END IF;
  IF NEW.event_type = 'claimed' THEN
    SELECT coalesce(sum(l.credit_amount), 0) INTO acct_cr
      FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
     WHERE l.journal_entry_id = e.id AND c.system_code = 'VAT_AWAITING_EVIDENCE';
    IF acct_cr <> NEW.amount THEN
      RAISE EXCEPTION 'input VAT event % (claimed): the entry must release % from VAT_AWAITING_EVIDENCE (it releases %)', NEW.id, NEW.amount, acct_cr
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_amount';
    END IF;
  END IF;
  -- 🔴 M1b: an Art. 50 correction NEVER credits Input VAT Receivable.
  IF NEW.event_type = 'corrected_blocked' THEN
    SELECT coalesce(sum(l.credit_amount), 0) INTO vat_input_cr
      FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
     WHERE l.journal_entry_id = e.id AND c.system_code = 'VAT_INPUT';
    IF vat_input_cr <> 0 THEN
      RAISE EXCEPTION 'input VAT event % (corrected_blocked): the correction credits VAT_INPUT — it must credit VAT_ADJ_BLOCKED (M1b)', NEW.id
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_m1b';
    END IF;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint

-- ── 6. 🔴 "The document agrees with its events" — ONE definition. ──────────
-- NULL when it does; otherwise a sentence naming the document, what its
-- events say, and what its columns say. Read by the gate (§10), by the
-- cache-consistency triggers (§11) and by the invariant sweep.
--
-- The CACHE MAPPING (architecture §14; A-B1-6 for the all-zero document):
--   recognised_claimed         → claimed, pending 0, claimed on its date, no claim entry
--   recognised_blocked         → not_deductible, pending 0, no claim
--   recognised_held + claimed  → claimed, pending 0, claimed on the claim's date, its VATEV- entry
--   recognised_held, no claim  → awaiting_evidence, pending = the HELD bucket
--       …and when HELD is zero (O-6: its credit notes consumed it — no claimed
--       event is ever written) the cache may also read claimed, pending 0, a
--       date on or after the document's, no claim entry — what the evidence
--       act records today for a nil claim.
--   no recognition (nothing to recognise: VAT net of advances is zero)
--                              → claimed on the document's date, or all empty
--                                (a row inserted posted, the 0106 limit)
--   The cache has no representation for REVERSED_UNPAID / CORRECTED_BLOCKED /
--   LAPSED (no writer produces them before 13B-6 / 13B-8, which revisit this):
--   pending is always the HELD bucket, the state follows recognition and claim.
-- COMPLETENESS: a posted document with VAT to recognise has its recognition;
-- a posted credit note with VAT has its reduction; each prepayment carrying
-- tax has its advance_deducted; an OPENING payable carries no VAT and no
-- event; an unposted document carries neither events nor a cache.
-- CI-1: the credit notes against a document never exceed its VAT.
-- 🔴 HELD CREDIT-NOTE ROWS ARE NOT MAPPED (approved): their columns copy the
-- original's so the live return queries make them follow it into the claim —
-- a cache/return artefact the event on the ORIGINAL already states.
CREATE OR REPLACE FUNCTION input_vat_document_mismatch(p_bill_id integer) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  b record;
  o record;
  rec record;
  clm record;
  nev record;
  v_held numeric;
  recognisable numeric;
  notes_vat numeric;
  missing record;
  exp_state text; exp_pending numeric; exp_on text; exp_entry integer;
  alt_ok boolean := false;
  actual text;
  label text;
BEGIN
  SELECT * INTO b FROM bills WHERE id = p_bill_id;
  IF b.id IS NULL THEN RETURN NULL; END IF;
  label := format('%s %s (id %s)', replace(b.document_type, '_', ' '), b.bill_number, b.id);
  actual := format('state %s, pending %s, claimed on %s, claim entry %s',
    coalesce(b.input_vat_state, 'NULL'), b.input_vat_pending, coalesce(b.input_vat_claimed_on, 'NULL'), coalesce(b.input_vat_claim_entry_id::text, 'NULL'));

  IF b.status IN ('draft', 'submitted') THEN
    IF EXISTS (SELECT 1 FROM input_vat_events v WHERE v.document_id = b.id OR v.related_document_id = b.id) THEN
      RETURN format('%s is %s, yet input VAT events name it', label, b.status);
    END IF;
    IF b.input_vat_state IS NOT NULL OR b.input_vat_pending <> 0 OR b.input_vat_claimed_on IS NOT NULL OR b.input_vat_claim_entry_id IS NOT NULL THEN
      RETURN format('%s is %s: expected no input VAT position (state NULL, pending 0, no claim); its columns read %s', label, b.status, actual);
    END IF;
    RETURN NULL;
  END IF;

  -- An opening payable carries no VAT and no event. Its columns are empty
  -- (inserted posted after 0106) or read claimed on its own date (0106 stated
  -- that for EVERY bill posted before it, a zero-VAT one included) — the same
  -- two readings as any document with nothing to recognise, below.
  IF b.is_opening THEN
    IF b.vat_amount <> 0 OR EXISTS (SELECT 1 FROM input_vat_events v WHERE v.document_id = b.id)
       OR NOT ((b.input_vat_state IS NULL AND b.input_vat_pending = 0 AND b.input_vat_claimed_on IS NULL AND b.input_vat_claim_entry_id IS NULL)
            OR (b.input_vat_state = 'claimed' AND b.input_vat_claimed_on = b.date AND b.input_vat_pending = 0 AND b.input_vat_claim_entry_id IS NULL)) THEN
      RETURN format('%s is an opening (Batch 1C) payable: expected no VAT, no events, and no input VAT position (columns empty, or claimed on its own date %s as 0106 recorded); it has VAT %s and its columns read %s',
        label, b.date, b.vat_amount, actual);
    END IF;
    RETURN NULL;
  END IF;

  IF b.document_type IN ('credit_note', 'advance_credit_note') THEN
    IF EXISTS (SELECT 1 FROM input_vat_events v WHERE v.document_id = b.id) THEN
      RETURN format('%s carries input VAT events of its own; a credit note''s VAT is recorded on the document it corrects', label);
    END IF;
    SELECT * INTO nev FROM input_vat_events v WHERE v.related_document_id = b.id AND v.event_type = 'reduced_by_note';
    IF b.vat_amount > 0 AND nev.id IS NULL THEN
      RETURN format('%s carries VAT %s but no reduced_by_note event on the document it corrects (id %s)', label, b.vat_amount, b.credit_note_against_bill_id);
    END IF;
    SELECT id, bill_number, vat_amount INTO o FROM bills WHERE id = b.credit_note_against_bill_id;
    SELECT coalesce(sum(n.vat_amount), 0) INTO notes_vat FROM bills n
     WHERE n.credit_note_against_bill_id = o.id AND n.document_type IN ('credit_note', 'advance_credit_note') AND n.status NOT IN ('draft', 'submitted');
    IF notes_vat > o.vat_amount THEN
      RETURN format('CI-1: the posted credit notes against %s (id %s) reduce VAT by %s, more than the %s it charged', o.bill_number, o.id, notes_vat, o.vat_amount);
    END IF;
    IF nev.id IS NULL OR nev.from_bucket = 'HELD' THEN RETURN NULL; END IF;
    IF nev.from_bucket = 'CLAIMED' THEN exp_state := 'claimed'; exp_on := b.date;
    ELSE exp_state := 'not_deductible'; exp_on := NULL; END IF;
    IF b.input_vat_state IS DISTINCT FROM exp_state OR b.input_vat_pending <> 0 OR b.input_vat_claimed_on IS DISTINCT FROM exp_on OR b.input_vat_claim_entry_id IS NOT NULL THEN
      RETURN format('%s reduced its original''s %s VAT: its columns must read state %s, pending 0, claimed on %s, claim entry NULL; they read %s',
        label, nev.from_bucket, exp_state, coalesce(exp_on, 'NULL'), actual);
    END IF;
    RETURN NULL;
  END IF;

  -- An ordinary document: a bill, a debit note (its own document, O-3), a supplier advance invoice.
  recognisable := b.vat_amount - coalesce((SELECT sum(p.tax_amount) FROM bill_prepayments p WHERE p.bill_id = b.id), 0);
  SELECT * INTO missing FROM bill_prepayments p
   WHERE p.bill_id = b.id AND p.tax_amount > 0
     AND NOT EXISTS (SELECT 1 FROM input_vat_events v WHERE v.document_id = b.id AND v.event_type = 'advance_deducted' AND v.related_document_id = p.advance_bill_id)
   LIMIT 1;
  IF missing.id IS NOT NULL THEN
    RETURN format('%s deducts advance VAT %s (advance id %s) with no advance_deducted event', label, missing.tax_amount, missing.advance_bill_id);
  END IF;
  SELECT * INTO rec FROM input_vat_events v WHERE v.document_id = b.id AND v.event_type LIKE 'recognised\_%';
  SELECT * INTO clm FROM input_vat_events v WHERE v.document_id = b.id AND v.event_type = 'claimed';
  SELECT coalesce(max(bl.held), 0) INTO v_held FROM input_vat_balances bl WHERE bl.document_id = b.id;

  IF rec.id IS NULL THEN
    IF recognisable > 0 THEN
      RETURN format('%s is posted with input VAT %s to recognise, but has no recognition event; its columns read %s', label, recognisable, actual);
    END IF;
    IF (b.input_vat_state = 'claimed' AND b.input_vat_claimed_on = b.date AND b.input_vat_pending = 0 AND b.input_vat_claim_entry_id IS NULL)
       OR (b.input_vat_state IS NULL AND b.input_vat_pending = 0 AND b.input_vat_claimed_on IS NULL AND b.input_vat_claim_entry_id IS NULL) THEN
      RETURN NULL;
    END IF;
    RETURN format('%s has no input VAT to recognise: its columns must read state claimed on %s (or be empty), pending 0, no claim entry; they read %s', label, b.date, actual);
  END IF;
  IF rec.amount <> recognisable THEN
    RETURN format('%s: its %s event states %s, but its VAT net of advances is %s', label, rec.event_type, rec.amount, recognisable);
  END IF;
  CASE rec.event_type
    WHEN 'recognised_claimed' THEN exp_state := 'claimed'; exp_pending := 0; exp_on := rec.occurred_on; exp_entry := NULL;
    WHEN 'recognised_blocked' THEN exp_state := 'not_deductible'; exp_pending := 0; exp_on := NULL; exp_entry := NULL;
    ELSE
      IF clm.id IS NOT NULL THEN
        exp_state := 'claimed'; exp_pending := 0; exp_on := clm.occurred_on; exp_entry := clm.journal_entry_id;
      ELSE
        exp_state := 'awaiting_evidence'; exp_pending := v_held; exp_on := NULL; exp_entry := NULL;
        alt_ok := v_held = 0;
      END IF;
  END CASE;
  IF b.input_vat_state IS NOT DISTINCT FROM exp_state AND b.input_vat_pending = exp_pending
     AND b.input_vat_claimed_on IS NOT DISTINCT FROM exp_on AND b.input_vat_claim_entry_id IS NOT DISTINCT FROM exp_entry THEN
    RETURN NULL;
  END IF;
  IF alt_ok AND b.input_vat_state = 'claimed' AND b.input_vat_pending = 0 AND b.input_vat_claimed_on >= b.date AND b.input_vat_claim_entry_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN format('%s: its events (%s%s, held %s) require state %s, pending %s, claimed on %s, claim entry %s; its columns read %s',
    label, rec.event_type, CASE WHEN clm.id IS NOT NULL THEN ' + claimed' ELSE '' END, v_held,
    exp_state, exp_pending, coalesce(exp_on, 'NULL'), coalesce(exp_entry::text, 'NULL'), actual);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_document_mismatch(integer) FROM PUBLIC;--> statement-breakpoint

-- ── 7. 🔴 "The events agree with the GL" — ONE definition. ─────────────────
-- Per document (architecture §7.2): HELD = the awaiting-evidence lines;
-- CLAIMED = Input VAT net of the two adjustment accounts; REVERSED_UNPAID /
-- CORRECTED_BLOCKED = those accounts' credit balances — over the document's
-- own entry, its evidence-claim entry, its posted notes' entries and the
-- entries the ledger posted for it. BLOCKED is cost and has no account; its
-- entries' absence of VAT lines is checked by the journal link. Every one of
-- those entries must still be POSTED — a document whose own entry was
-- reversed generically (possible before 0107) cannot be reconstructed, and
-- is named rather than guessed at.
CREATE OR REPLACE FUNCTION input_vat_gl_mismatch(p_bill_id integer) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  b record;
  g record;
  bl record;
  label text;
BEGIN
  SELECT * INTO b FROM bills WHERE id = p_bill_id;
  IF b.id IS NULL OR b.status IN ('draft', 'submitted') OR b.is_opening OR b.document_type IN ('credit_note', 'advance_credit_note') THEN
    RETURN NULL;
  END IF;
  label := format('%s %s (id %s)', replace(b.document_type, '_', ' '), b.bill_number, b.id);
  WITH ents AS (
    SELECT e.id FROM journal_entries e
     WHERE e.company_id = b.company_id AND e.entry_number = CASE b.document_type WHEN 'advance_invoice' THEN 'BILLADV-' ELSE 'BILL-' END || b.bill_number
    UNION SELECT b.input_vat_claim_entry_id WHERE b.input_vat_claim_entry_id IS NOT NULL
    UNION SELECT e.id FROM bills n
            JOIN journal_entries e ON e.company_id = n.company_id
                                  AND e.entry_number = CASE n.document_type WHEN 'advance_credit_note' THEN 'BILLADVCN-' ELSE 'BILLCN-' END || n.bill_number
           WHERE n.credit_note_against_bill_id = b.id AND n.document_type IN ('credit_note', 'advance_credit_note') AND n.status NOT IN ('draft', 'submitted')
    UNION SELECT v.journal_entry_id FROM input_vat_events v WHERE v.document_id = b.id AND v.journal_role = 'event_entry')
  SELECT (SELECT e.entry_number || ' is ' || e.status FROM ents x JOIN journal_entries e ON e.id = x.id WHERE e.status <> 'posted' ORDER BY e.id LIMIT 1) AS unposted,
         coalesce(sum(CASE WHEN c.system_code = 'VAT_AWAITING_EVIDENCE' THEN l.debit_amount - l.credit_amount END), 0)::numeric(15, 2) AS held,
         (coalesce(sum(CASE WHEN c.system_code = 'VAT_INPUT' THEN l.debit_amount - l.credit_amount END), 0)
        - coalesce(sum(CASE WHEN c.system_code IN ('VAT_ADJ_NONPAYMENT', 'VAT_ADJ_BLOCKED') THEN l.credit_amount - l.debit_amount END), 0))::numeric(15, 2) AS claimed,
         coalesce(sum(CASE WHEN c.system_code = 'VAT_ADJ_NONPAYMENT' THEN l.credit_amount - l.debit_amount END), 0)::numeric(15, 2) AS reversed_unpaid,
         coalesce(sum(CASE WHEN c.system_code = 'VAT_ADJ_BLOCKED' THEN l.credit_amount - l.debit_amount END), 0)::numeric(15, 2) AS corrected_blocked
    INTO g
    FROM ents x
    JOIN journal_entry_lines l ON l.journal_entry_id = x.id
    JOIN categories c ON c.id = l.account_id;
  IF g.unposted IS NOT NULL THEN
    RETURN format('%s: its entry %s, not posted — the document''s VAT cannot be read from the GL', label, g.unposted);
  END IF;
  SELECT coalesce(max(held), 0) AS held, coalesce(max(claimed), 0) AS claimed,
         coalesce(max(reversed_unpaid), 0) AS reversed_unpaid, coalesce(max(corrected_blocked), 0) AS corrected_blocked
    INTO bl FROM input_vat_balances WHERE document_id = b.id;
  IF g.held <> bl.held OR g.claimed <> bl.claimed OR g.reversed_unpaid <> bl.reversed_unpaid OR g.corrected_blocked <> bl.corrected_blocked THEN
    RETURN format('%s: the ledger holds held %s / claimed %s / reversed %s / corrected %s; its GL entries hold held %s / claimed %s / reversed %s / corrected %s',
      label, bl.held, bl.claimed, bl.reversed_unpaid, bl.corrected_blocked, g.held, g.claimed, g.reversed_unpaid, g.corrected_blocked);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_gl_mismatch(integer) FROM PUBLIC;--> statement-breakpoint

-- ── 8. The reconciliation, over every document. ────────────────────────────
-- One row per disagreement: the document, and the sentence naming what the
-- ledger says and what the columns / the GL say. Empty = reconciled. Also the
-- balance rows against the sum of their events (trigger-maintained; checked,
-- not trusted).
CREATE OR REPLACE FUNCTION input_vat_reconciliation(p_organization_id uuid DEFAULT NULL)
RETURNS TABLE (document_id integer, organization_id uuid, company_id uuid, problem text)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT b.id, b.organization_id, b.company_id, m.problem
    FROM bills b
   CROSS JOIN LATERAL (SELECT input_vat_document_mismatch(b.id) AS problem
                       UNION ALL SELECT input_vat_gl_mismatch(b.id)) m
   WHERE m.problem IS NOT NULL
     AND (p_organization_id IS NULL OR b.organization_id = p_organization_id)
  UNION ALL
  SELECT bl.document_id, bl.organization_id, bl.company_id,
         format('balance row of document %s differs from the sum of its events', bl.document_id)
    FROM input_vat_balances bl
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(CASE WHEN v.to_bucket = 'HELD' THEN v.amount END), 0) - coalesce(sum(CASE WHEN v.from_bucket = 'HELD' THEN v.amount END), 0) AS held,
             coalesce(sum(CASE WHEN v.to_bucket = 'CLAIMED' THEN v.amount END), 0) - coalesce(sum(CASE WHEN v.from_bucket = 'CLAIMED' THEN v.amount END), 0) AS claimed,
             coalesce(sum(CASE WHEN v.to_bucket = 'BLOCKED' THEN v.amount END), 0) - coalesce(sum(CASE WHEN v.from_bucket = 'BLOCKED' THEN v.amount END), 0) AS blocked
        FROM input_vat_events v WHERE v.document_id = bl.document_id) s ON true
   WHERE (s.held <> bl.held OR s.claimed <> bl.claimed OR s.blocked <> bl.blocked)
     AND (p_organization_id IS NULL OR bl.organization_id = p_organization_id)
   ORDER BY 1, 4
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_reconciliation(uuid) FROM PUBLIC;--> statement-breakpoint

-- ── 9. 🔴 THE BACKFILL (13B-4, pulled forward): RECONSTRUCTED events. ──────
-- For every POSTED bill, debit note and supplier advance invoice that has no
-- event yet (so a re-run writes nothing twice, and a document the live
-- writer recorded is never touched), in company, id order:
--   recognition — its bucket read from the document's OWN entry (a VAT_INPUT
--     debit = claimed, a VAT_AWAITING_EVIDENCE debit = held, no VAT line =
--     blocked) and CROSS-CHECKED against input_vat_state; the amount is the
--     VAT net of advances (the admission trigger re-checks it, the journal
--     link checks it against the entry);
--   held credit notes, in note-date then id order — bucket from the NOTE's
--     entry (a credit on VAT_AWAITING_EVIDENCE);
--   the evidence claim — from bills.input_vat_claim_entry_id (VATEV-), on
--     that entry's date, which must be input_vat_claimed_on;
--   the other credit notes (a credit on VAT_INPUT = claimed, none = blocked);
--   advance_deducted — one per prepayment row carrying tax.
-- Each row is ONE statement (one event per document per statement, 0107).
-- 🔴 NEVER GUESSES: every disagreement between what the columns say and what
-- the entries say RAISES, naming the document, both readings and the rule —
-- the migration stops and nothing is written. O-2 is asked of every note
-- before it is written, so a pre-existing over-credit (D-1) or a note dated
-- before its original (D-6) is named here, not met as a raw trigger error.
-- Provenance (architecture §15): reconstructed, the migration, the rows read,
-- the source records, actor migration:<id>, the evidence verdict as it is NOW
-- (snapshot_source current_at_backfill — the verdict at the time was never
-- recorded); recorded_at is the backfill's own time.
CREATE OR REPLACE FUNCTION input_vat_backfill(p_migration text, p_organization_id uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  b record;
  n record;
  p record;
  own record;
  ce record;
  r record;
  written integer := 0;
  recognisable numeric;
  rec_type text;
  rec_bucket text;
  own_number text;
  note_bucket text;
  actor text := 'migration:' || p_migration;
  why text := 'reconstructed at Phase 13B introduction';
  snap jsonb;
  held_now numeric;
  pass int;
BEGIN
  FOR b IN
    SELECT * FROM bills d
     WHERE d.status NOT IN ('draft', 'submitted') AND NOT d.is_opening
       AND d.document_type IN ('bill', 'debit_note', 'advance_invoice')
       AND NOT EXISTS (SELECT 1 FROM input_vat_events v WHERE v.document_id = d.id)
       AND (p_organization_id IS NULL OR d.organization_id = p_organization_id)
     ORDER BY d.company_id, d.id
  LOOP
    recognisable := b.vat_amount - coalesce((SELECT sum(pp.tax_amount) FROM bill_prepayments pp WHERE pp.bill_id = b.id), 0);
    own_number := CASE b.document_type WHEN 'advance_invoice' THEN 'BILLADV-' ELSE 'BILL-' END || b.bill_number;
    SELECT e.id, e.status, e.date,
           coalesce(sum(CASE WHEN c.system_code = 'VAT_INPUT' THEN l.debit_amount END), 0) AS vi_dr,
           coalesce(sum(CASE WHEN c.system_code = 'VAT_AWAITING_EVIDENCE' THEN l.debit_amount END), 0) AS vae_dr
      INTO own
      FROM journal_entries e
      LEFT JOIN journal_entry_lines l ON l.journal_entry_id = e.id
      LEFT JOIN categories c ON c.id = l.account_id
     WHERE e.company_id = b.company_id AND e.entry_number = own_number
     GROUP BY e.id, e.status, e.date;
    snap := jsonb_build_object('snapshot_source', 'current_at_backfill', 'status', b.vat_evidence_status, 'basis', b.vat_evidence_basis,
                               'flags', b.vat_evidence_flags, 'supplierDocumentKind', b.supplier_document_kind);

    -- ── recognition ──
    IF recognisable > 0 THEN
      IF own.id IS NULL OR own.status <> 'posted' THEN
        RAISE EXCEPTION 'input VAT backfill STOPPED — % % (id %): VAT % to recognise, but its own entry % is %; the ledger cannot be reconstructed from it',
          b.document_type, b.bill_number, b.id, recognisable, own_number, coalesce(own.status, 'missing')
          USING ERRCODE = '23514', CONSTRAINT = 'input_vat_backfill_gate';
      END IF;
      rec_type := CASE WHEN own.vi_dr > 0 AND own.vae_dr = 0 THEN 'recognised_claimed'
                       WHEN own.vae_dr > 0 AND own.vi_dr = 0 THEN 'recognised_held'
                       WHEN own.vi_dr = 0 AND own.vae_dr = 0 THEN 'recognised_blocked' END;
      -- The columns must tell the same story as the entry (never guess which is right).
      IF rec_type IS NULL
         OR (rec_type = 'recognised_claimed' AND b.input_vat_state IS DISTINCT FROM 'claimed')
         OR (rec_type = 'recognised_blocked' AND b.input_vat_state IS DISTINCT FROM 'not_deductible')
         OR (rec_type = 'recognised_held'    AND b.input_vat_state NOT IN ('awaiting_evidence', 'claimed'))
         OR (rec_type = 'recognised_held'    AND b.input_vat_state = 'claimed' AND b.input_vat_claim_entry_id IS NULL AND b.input_vat_pending <> 0) THEN
        RAISE EXCEPTION 'input VAT backfill STOPPED — % % (id %): its entry % reads % (VAT_INPUT dr %, awaiting-evidence dr %) but its columns read state %',
          b.document_type, b.bill_number, b.id, own_number, coalesce(rec_type, 'BOTH accounts'), own.vi_dr, own.vae_dr, coalesce(b.input_vat_state, 'NULL')
          USING ERRCODE = '23514', CONSTRAINT = 'input_vat_backfill_gate';
      END IF;
      rec_bucket := CASE rec_type WHEN 'recognised_claimed' THEN 'CLAIMED' WHEN 'recognised_held' THEN 'HELD' ELSE 'BLOCKED' END;
      INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, amount,
        occurred_on, posting_date, reason, evidence_snapshot, journal_entry_id, journal_role, actor_system,
        provenance, backfill_migration, backfill_source, source_record_ref, idempotency_key)
      VALUES (b.organization_id, b.company_id, b.id, rec_type, 'NONE', rec_bucket, recognisable,
        b.date, b.date, why, snap, own.id, 'own_entry', actor,
        'reconstructed', p_migration,
        'bills.vat_amount − bill_prepayments.tax_amount; bills.input_vat_state; journal_entries ' || own_number || ' VAT lines',
        format('bills:%s; journal_entries:%s', b.id, own.id),
        format('backfill:%s:%s', rec_type, b.id));
      written := written + 1;
    ELSIF b.input_vat_claim_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'input VAT backfill STOPPED — % % (id %): nothing to recognise, yet it names an evidence-claim entry %',
        b.document_type, b.bill_number, b.id, b.input_vat_claim_entry_id
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_backfill_gate';
    END IF;

    -- ── credit notes (pass 1: those that reduced HELD VAT), the claim, then the rest (pass 2) ──
    FOR pass IN 1..2 LOOP
      IF pass = 2 AND b.input_vat_claim_entry_id IS NOT NULL THEN
        SELECT e.id, e.status, e.date,
               coalesce(sum(CASE WHEN c.system_code = 'VAT_AWAITING_EVIDENCE' THEN l.credit_amount END), 0) AS vae_cr
          INTO ce
          FROM journal_entries e
          LEFT JOIN journal_entry_lines l ON l.journal_entry_id = e.id
          LEFT JOIN categories c ON c.id = l.account_id
         WHERE e.id = b.input_vat_claim_entry_id
         GROUP BY e.id, e.status, e.date;
        SELECT coalesce(max(bl.held), 0) INTO held_now FROM input_vat_balances bl WHERE bl.document_id = b.id;
        IF ce.id IS NULL OR ce.status <> 'posted' OR ce.date IS DISTINCT FROM b.input_vat_claimed_on OR ce.vae_cr <> held_now OR held_now = 0 THEN
          RAISE EXCEPTION 'input VAT backfill STOPPED — % % (id %): its evidence claim (entry %, %, dated %, releasing %) must be a posted entry dated input_vat_claimed_on % releasing the whole held VAT %',
            b.document_type, b.bill_number, b.id, b.input_vat_claim_entry_id, coalesce(ce.status, 'missing'), ce.date, ce.vae_cr, b.input_vat_claimed_on, held_now
            USING ERRCODE = '23514', CONSTRAINT = 'input_vat_backfill_gate';
        END IF;
        INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, amount,
          occurred_on, posting_date, reason, evidence_snapshot, journal_entry_id, journal_role, actor_system,
          provenance, backfill_migration, backfill_source, source_record_ref, idempotency_key)
        VALUES (b.organization_id, b.company_id, b.id, 'claimed', 'HELD', 'CLAIMED', held_now,
          ce.date, ce.date, why, snap, ce.id, 'claim_entry', actor,
          'reconstructed', p_migration,
          'bills.input_vat_claim_entry_id + input_vat_claimed_on; journal_entries VATEV-' || b.bill_number,
          format('bills:%s; journal_entries:%s', b.id, ce.id),
          format('backfill:claimed:%s', b.id));
        written := written + 1;
      END IF;
      FOR n IN
        SELECT nb.*, e.id AS entry_id, e.status AS entry_status,
               coalesce(sum(CASE WHEN c.system_code = 'VAT_AWAITING_EVIDENCE' THEN l.credit_amount END), 0) AS vae_cr,
               coalesce(sum(CASE WHEN c.system_code = 'VAT_INPUT' THEN l.credit_amount END), 0) AS vi_cr,
               coalesce(sum(CASE WHEN c.system_code IN ('VAT_INPUT', 'VAT_AWAITING_EVIDENCE') THEN l.debit_amount END), 0) AS vat_dr
          FROM bills nb
          LEFT JOIN journal_entries e ON e.company_id = nb.company_id
                 AND e.entry_number = CASE nb.document_type WHEN 'advance_credit_note' THEN 'BILLADVCN-' ELSE 'BILLCN-' END || nb.bill_number
          LEFT JOIN journal_entry_lines l ON l.journal_entry_id = e.id
          LEFT JOIN categories c ON c.id = l.account_id
         WHERE nb.credit_note_against_bill_id = b.id AND nb.document_type IN ('credit_note', 'advance_credit_note')
           AND nb.status NOT IN ('draft', 'submitted') AND nb.vat_amount > 0
         GROUP BY nb.id, e.id, e.status
         ORDER BY nb.date, nb.id
      LOOP
        note_bucket := CASE WHEN n.vae_cr > 0 AND n.vi_cr = 0 THEN 'HELD'
                            WHEN n.vi_cr > 0 AND n.vae_cr = 0 THEN 'CLAIMED'
                            WHEN n.vi_cr = 0 AND n.vae_cr = 0 THEN 'BLOCKED' END;
        CONTINUE WHEN (pass = 1) <> (note_bucket = 'HELD');
        IF n.entry_id IS NULL OR n.entry_status <> 'posted' OR note_bucket IS NULL OR n.vat_dr <> 0 THEN
          RAISE EXCEPTION 'input VAT backfill STOPPED — credit note % (id %) against % (id %): its entry is %, reading awaiting-evidence cr % / VAT_INPUT cr % / VAT dr % — not one bucket''s reduction',
            n.bill_number, n.id, b.bill_number, b.id, coalesce(n.entry_status, 'missing'), n.vae_cr, n.vi_cr, n.vat_dr
            USING ERRCODE = '23514', CONSTRAINT = 'input_vat_backfill_gate';
        END IF;
        IF n.date < b.date THEN
          RAISE EXCEPTION 'input VAT backfill STOPPED — credit note % (id %) is dated %, before % (id %) dated % (D-6)',
            n.bill_number, n.id, n.date, b.bill_number, b.id, b.date
            USING ERRCODE = '23514', CONSTRAINT = 'input_vat_backfill_gate';
        END IF;
        SELECT * INTO r FROM input_vat_note_refusal(b.id, n.id, n.vat_amount);
        IF r.refusal IS NOT NULL OR r.from_bucket IS DISTINCT FROM note_bucket THEN
          RAISE EXCEPTION 'input VAT backfill STOPPED — credit note % (id %, VAT %) against % (id %): the ledger reads % (bucket %, % left under CI-1, % in the bucket); the note''s entry reduces %',
            n.bill_number, n.id, n.vat_amount, b.bill_number, b.id, coalesce(r.refusal, 'admissible'), coalesce(r.from_bucket, 'none'), r.remaining, r.bucket_amount, note_bucket
            USING ERRCODE = '23514', CONSTRAINT = 'input_vat_backfill_gate';
        END IF;
        INSERT INTO input_vat_events (organization_id, company_id, document_id, related_document_id, event_type, from_bucket, to_bucket, amount,
          occurred_on, posting_date, reason, cause_type, cause_id, journal_entry_id, journal_role, actor_system,
          provenance, backfill_migration, backfill_source, source_record_ref, idempotency_key)
        VALUES (b.organization_id, b.company_id, b.id, n.id, 'reduced_by_note', note_bucket, 'NONE', n.vat_amount,
          n.date, n.date, why, 'credit_note', n.id, n.entry_id, 'note_entry', actor,
          'reconstructed', p_migration,
          'bills.credit_note_against_bill_id; journal_entries ' || CASE n.document_type WHEN 'advance_credit_note' THEN 'BILLADVCN-' ELSE 'BILLCN-' END || n.bill_number || ' VAT lines',
          format('bills:%s; bills:%s; journal_entries:%s', b.id, n.id, n.entry_id),
          format('backfill:reduced_by_note:%s', n.id));
        written := written + 1;
      END LOOP;
    END LOOP;

    -- ── advance VAT this final bill deducts (an annotation; Z-AP1) ──
    FOR p IN SELECT * FROM bill_prepayments pp WHERE pp.bill_id = b.id AND pp.tax_amount > 0 ORDER BY pp.id LOOP
      IF own.id IS NULL THEN
        RAISE EXCEPTION 'input VAT backfill STOPPED — % % (id %) deducts an advance but has no own entry %', b.document_type, b.bill_number, b.id, own_number
          USING ERRCODE = '23514', CONSTRAINT = 'input_vat_backfill_gate';
      END IF;
      INSERT INTO input_vat_events (organization_id, company_id, document_id, related_document_id, event_type, from_bucket, to_bucket, amount,
        occurred_on, posting_date, reason, cause_type, cause_id, journal_entry_id, journal_role, actor_system,
        provenance, backfill_migration, backfill_source, source_record_ref, idempotency_key)
      VALUES (b.organization_id, b.company_id, b.id, p.advance_bill_id, 'advance_deducted', 'NONE', 'NONE', p.tax_amount,
        b.date, b.date, why, 'advance_invoice', p.advance_bill_id, own.id, 'own_entry', actor,
        'reconstructed', p_migration,
        'bill_prepayments.tax_amount',
        format('bills:%s; bill_prepayments:%s; journal_entries:%s', b.id, p.id, own.id),
        format('backfill:advance_deducted:%s:%s', b.id, p.advance_bill_id));
      written := written + 1;
    END LOOP;
  END LOOP;
  RETURN written;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_backfill(text, uuid) FROM PUBLIC;--> statement-breakpoint

-- ── 10. 🔴 THE GATE — and the migration runs it. ───────────────────────────
-- ONE function (the migration's call below, and the tests', read the same
-- code): the journal linkage is checked per row NOW rather than at commit, so
-- a disagreement surfaces beside its document; the backfill runs; then every
-- document is reconciled — columns, events, GL — and ANY disagreement raises,
-- naming the total and the first twenty documents with both readings. Fail
-- closed: nothing is repaired, nothing is guessed, the transaction (the
-- migration) is rolled back. Scoped to one organisation when one is named
-- (an operator re-running it for a tenant; the tests); the migration names none.
CREATE OR REPLACE FUNCTION input_vat_backfill_gate(p_migration text, p_organization_id uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  written integer;
  total integer;
  problems text;
BEGIN
  SET CONSTRAINTS input_vat_events_journal_link IMMEDIATE;
  written := input_vat_backfill(p_migration, p_organization_id);
  SELECT count(*) INTO total FROM input_vat_reconciliation(p_organization_id);
  IF total > 0 THEN
    SELECT string_agg(format('  document %s: %s', q.document_id, q.problem), E'\n')
      INTO problems FROM (SELECT * FROM input_vat_reconciliation(p_organization_id) LIMIT 20) q;
    RAISE EXCEPTION E'input VAT reconciliation gate STOPPED (% event(s) reconstructed, then % disagreement(s); the first % shown):\n%',
      written, total, least(total, 20), problems
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_backfill_gate';
  END IF;
  SET CONSTRAINTS input_vat_events_journal_link DEFERRED;
  RAISE NOTICE 'input VAT backfill: % event(s) reconstructed; reconciliation clean', written;
  RETURN written;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_backfill_gate(text, uuid) FROM PUBLIC;--> statement-breakpoint
SELECT input_vat_backfill_gate('0109');--> statement-breakpoint

-- ── 11. 🔴 THE CACHE-CONSISTENCY TRIGGERS — only now (R5). ──────────────────
-- At COMMIT, a bill whose VAT facts or cache columns changed — and the
-- document (and note) every new event names — must agree with its events
-- (§6). The writer (services/accounting/inputVatLedger.service.ts) writes the
-- cache and the events in one transaction; ANY other write of the cache, or
-- a posting with no event, is refused here.
CREATE OR REPLACE FUNCTION bills_input_vat_cache_consistency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m text;
BEGIN
  m := input_vat_document_mismatch(NEW.id);
  IF m IS NOT NULL THEN
    RAISE EXCEPTION 'input VAT cache: %', m USING ERRCODE = '23514', CONSTRAINT = 'bills_input_vat_cache_consistency';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER bills_input_vat_cache_consistency
  AFTER INSERT OR UPDATE OF status, document_type, is_opening, vat_amount, date, credit_note_against_bill_id,
                            input_vat_state, input_vat_pending, input_vat_claimed_on, input_vat_claim_entry_id
  ON "bills" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bills_input_vat_cache_consistency();--> statement-breakpoint
CREATE OR REPLACE FUNCTION input_vat_events_cache_consistency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m text;
BEGIN
  m := coalesce(input_vat_document_mismatch(NEW.document_id),
                CASE WHEN NEW.event_type = 'reduced_by_note' THEN input_vat_document_mismatch(NEW.related_document_id) END);
  IF m IS NOT NULL THEN
    RAISE EXCEPTION 'input VAT cache: %', m USING ERRCODE = '23514', CONSTRAINT = 'bills_input_vat_cache_consistency';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER input_vat_events_cache_consistency AFTER INSERT ON "input_vat_events"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION input_vat_events_cache_consistency();
