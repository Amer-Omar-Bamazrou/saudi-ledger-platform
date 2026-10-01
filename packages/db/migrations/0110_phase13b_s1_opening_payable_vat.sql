CREATE TABLE "opening_payable_vat_declaration_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"declaration_id" integer NOT NULL,
	"kind" text NOT NULL,
	"capture_id" uuid NOT NULL,
	"capture_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_payable_vat_evidence_kind_chk" CHECK (kind IN ('ORIGINAL_TAX_INVOICE', 'DEDUCTION_RETURN', 'REVERSAL_RETURN', 'PAYMENT_RECORDS', 'CLASSIFICATION'))
);
--> statement-breakpoint
CREATE TABLE "opening_payable_vat_declarations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"migration_open_item_id" integer NOT NULL,
	"bill_id" integer NOT NULL,
	"state" text NOT NULL,
	"historical_vat" numeric(15, 2) NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"deducted_period" text,
	"not_deducted_reason" text,
	"carried_in_cost" boolean,
	"art50_ground" text,
	"reversed_period" text,
	"reversed_vat_location" text,
	"record_reference" text,
	"statement" text NOT NULL,
	"declared_by" integer NOT NULL,
	"declared_on" text NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_payable_vat_declarations_state_chk" CHECK (state IN ('DEDUCTED', 'NOT_DEDUCTED', 'BLOCKED_ART50', 'REVERSED_ART40_10')),
	CONSTRAINT "opening_payable_vat_declarations_amounts_chk" CHECK (historical_vat > 0 AND vat_rate > 0 AND vat_rate <= 100),
	CONSTRAINT "opening_payable_vat_declarations_periods_chk" CHECK ((deducted_period IS NULL OR deducted_period ~ '^\d{4}-(0[1-9]|1[0-2])$')
      AND (reversed_period IS NULL OR reversed_period ~ '^\d{4}-(0[1-9]|1[0-2])$')
      AND declared_on ~ '^\d{4}-\d{2}-\d{2}$'
      AND length(btrim(statement)) > 0),
	CONSTRAINT "opening_payable_vat_declarations_facts_chk" CHECK ((state = 'DEDUCTED' AND deducted_period IS NOT NULL
            AND not_deducted_reason IS NULL AND carried_in_cost IS NULL AND art50_ground IS NULL
            AND reversed_period IS NULL AND reversed_vat_location IS NULL)
       OR (state = 'NOT_DEDUCTED' AND length(btrim(coalesce(not_deducted_reason, ''))) > 0 AND carried_in_cost IS TRUE
            AND deducted_period IS NULL AND art50_ground IS NULL AND reversed_period IS NULL AND reversed_vat_location IS NULL)
       OR (state = 'BLOCKED_ART50' AND length(btrim(coalesce(art50_ground, ''))) > 0
            AND deducted_period IS NULL AND not_deducted_reason IS NULL AND carried_in_cost IS NULL
            AND reversed_period IS NULL AND reversed_vat_location IS NULL)
       OR (state = 'REVERSED_ART40_10' AND deducted_period IS NOT NULL AND reversed_period IS NOT NULL
            AND reversed_period >= deducted_period AND reversed_vat_location = 'cost'
            AND not_deducted_reason IS NULL AND carried_in_cost IS NULL AND art50_ground IS NULL))
);
--> statement-breakpoint
ALTER TABLE "input_vat_balances" DROP CONSTRAINT "input_vat_balances_nonnegative_chk";--> statement-breakpoint
ALTER TABLE "input_vat_event_transitions" DROP CONSTRAINT "input_vat_event_transitions_bucket_chk";--> statement-breakpoint
ALTER TABLE "input_vat_events" DROP CONSTRAINT "input_vat_events_bucket_chk";--> statement-breakpoint
ALTER TABLE "input_vat_events" DROP CONSTRAINT "input_vat_events_provenance_chk";--> statement-breakpoint
ALTER TABLE "input_vat_balances" ADD COLUMN "not_deducted" numeric(15, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD COLUMN "declaration_id" integer;--> statement-breakpoint
ALTER TABLE "opening_payable_vat_declaration_evidence" ADD CONSTRAINT "opening_payable_vat_declaration_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_payable_vat_declaration_evidence" ADD CONSTRAINT "opening_payable_vat_declaration_evidence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_payable_vat_declaration_evidence" ADD CONSTRAINT "opening_payable_vat_declaration_evidence_declaration_id_opening_payable_vat_declarations_id_fk" FOREIGN KEY ("declaration_id") REFERENCES "public"."opening_payable_vat_declarations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_payable_vat_declaration_evidence" ADD CONSTRAINT "opening_payable_vat_declaration_evidence_capture_id_captured_documents_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captured_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_payable_vat_declarations" ADD CONSTRAINT "opening_payable_vat_declarations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_payable_vat_declarations" ADD CONSTRAINT "opening_payable_vat_declarations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_payable_vat_declarations" ADD CONSTRAINT "opening_payable_vat_declarations_migration_open_item_id_migration_open_items_id_fk" FOREIGN KEY ("migration_open_item_id") REFERENCES "public"."migration_open_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_payable_vat_declarations" ADD CONSTRAINT "opening_payable_vat_declarations_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opening_payable_vat_evidence_unq" ON "opening_payable_vat_declaration_evidence" USING btree ("declaration_id","kind","capture_id");--> statement-breakpoint
CREATE INDEX "opening_payable_vat_evidence_capture_idx" ON "opening_payable_vat_declaration_evidence" USING btree ("capture_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opening_payable_vat_declarations_item_unq" ON "opening_payable_vat_declarations" USING btree ("migration_open_item_id");--> statement-breakpoint
CREATE INDEX "opening_payable_vat_declarations_bill_idx" ON "opening_payable_vat_declarations" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "opening_payable_vat_declarations_company_idx" ON "opening_payable_vat_declarations" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD CONSTRAINT "input_vat_events_declaration_id_opening_payable_vat_declarations_id_fk" FOREIGN KEY ("declaration_id") REFERENCES "public"."opening_payable_vat_declarations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "input_vat_events_one_declared_opening_unq" ON "input_vat_events" USING btree ("document_id") WHERE event_type = 'declared_opening';--> statement-breakpoint
ALTER TABLE "input_vat_balances" ADD CONSTRAINT "input_vat_balances_nonnegative_chk" CHECK (held >= 0 AND claimed >= 0 AND reversed_unpaid >= 0 AND blocked >= 0 AND corrected_blocked >= 0 AND lapsed >= 0 AND not_deducted >= 0);--> statement-breakpoint
ALTER TABLE "input_vat_event_transitions" ADD CONSTRAINT "input_vat_event_transitions_bucket_chk" CHECK (from_bucket IN ('NONE', 'HELD', 'CLAIMED', 'REVERSED_UNPAID', 'BLOCKED', 'CORRECTED_BLOCKED', 'LAPSED', 'NOT_DEDUCTED') AND to_bucket IN ('NONE', 'HELD', 'CLAIMED', 'REVERSED_UNPAID', 'BLOCKED', 'CORRECTED_BLOCKED', 'LAPSED', 'NOT_DEDUCTED'));--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD CONSTRAINT "input_vat_events_bucket_chk" CHECK (from_bucket IN ('NONE', 'HELD', 'CLAIMED', 'REVERSED_UNPAID', 'BLOCKED', 'CORRECTED_BLOCKED', 'LAPSED', 'NOT_DEDUCTED') AND to_bucket IN ('NONE', 'HELD', 'CLAIMED', 'REVERSED_UNPAID', 'BLOCKED', 'CORRECTED_BLOCKED', 'LAPSED', 'NOT_DEDUCTED'));--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD CONSTRAINT "input_vat_events_provenance_chk" CHECK ((provenance = 'recorded' AND backfill_migration IS NULL AND backfill_source IS NULL AND source_record_ref IS NULL AND declaration_id IS NULL)
       OR (provenance = 'reconstructed' AND backfill_migration IS NOT NULL AND backfill_source IS NOT NULL AND source_record_ref IS NOT NULL
           AND actor_user_id IS NULL AND actor_system LIKE 'migration:%' AND declaration_id IS NULL)
       OR (provenance = 'declared' AND declaration_id IS NOT NULL AND backfill_migration IS NULL AND backfill_source IS NULL
           AND source_record_ref IS NULL AND event_type = 'declared_opening'));--> statement-breakpoint

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 13B S1 — AN OPENING PAYABLE'S HISTORICAL VAT, AND SINGLE-STATE
-- CREDIT NOTES AGAINST IT (owner decisions D1–D7, 2026-09-30).
-- Hand-written below this line: drizzle tracks neither reference rows,
-- functions, triggers nor grants. 0107 and 0109 are never edited; every
-- change to their functions is a CREATE OR REPLACE here.
-- Records: docs/product/phase-13b-level-policy-implementation-contract.md
--          §1 (AC-2, AC-3 subset, AC-4, AC-5 subset, AC-8, AC-9), §15, §16;
--          docs/product/phase-13b3-opening-payable-credit-note-decision-paper.md
--          §0 (AQ-1, AQ-2), §B, §D, §F (option D), §G, §M.4.
--
-- 🔴 S1 IS DELIBERATELY NARROW. Every credit note it admits resolves to ONE
-- bucket, so its input-VAT effect is either the FULL note VAT (the original's
-- VAT was deducted) or NOTHING (never deducted, Art. 50 blocked, fully
-- reversed under 40(10) with nothing restored). A document holding VAT in two
-- buckets is refused by name (`input_vat_note_multistate`) — the LEVEL split is
-- S2's, and S1 never approximates it.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. Transitions (AC-2, S1 subset). ─────────────────────────────────────
-- A declared recognition has no journal entry: the historical GL lives in the
-- cut-over aggregates (Batch 1C §15.2 C), not per document.
INSERT INTO "input_vat_event_transitions" (event_type, from_bucket, to_bucket, journal_role, admitted, enabled_in, basis) VALUES
  ('declared_opening', 'NONE', 'CLAIMED',         NULL, true, 'S1', 'Declared: the previous system DEDUCTED the opening payable''s historical VAT (AQ-1: the invoice and the return that deducted it)'),
  ('declared_opening', 'NONE', 'NOT_DEDUCTED',    NULL, true, 'S1', 'Declared: never deducted, carried in cost or the asset (AQ-1, AQ-2)'),
  ('declared_opening', 'NONE', 'BLOCKED',         NULL, true, 'S1', 'Declared: blocked under Art. 50 (AQ-1: the invoice, the ground, the classification evidence)'),
  ('declared_opening', 'NONE', 'REVERSED_UNPAID', NULL, true, 'S1', 'Declared: deducted, then FULLY reversed under Art. 40(10), nothing restored, the reversed VAT carried in cost (D7)'),
  ('reduced_by_note',  'NOT_DEDUCTED', 'NONE',    'note_entry', true, 'S1', 'A credit note on never-deducted VAT: no input-VAT effect; the note''s VAT reduces the same cost (AQ-2)'),
  ('reduced_by_note',  'REVERSED_UNPAID', 'NONE', 'note_entry', true, 'S1', 'A credit note on fully reversed, unrestored VAT: no input-VAT effect (R1 Case 2). Declared opening payables only — an in-system reversal history is still refused (NI-4)');
--> statement-breakpoint

-- ── 2. Is a restated key the SAME act? (replaces 0109 §3b — adds the declaration). ─
CREATE OR REPLACE FUNCTION input_vat_event_restates(prev input_vat_events, candidate input_vat_events) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (prev.organization_id, prev.company_id, prev.document_id, prev.related_document_id, prev.event_type, prev.from_bucket,
          prev.to_bucket, prev.amount, prev.occurred_on, prev.posting_date, prev.trigger_month, prev.cause_type, prev.cause_id,
          prev.follows_event_id, prev.evidence_capture_id, prev.journal_entry_id, prev.journal_role, prev.correction_route,
          prev.affected_period_start, prev.affected_period_end, prev.rule_version, prev.provenance, prev.backfill_migration,
          prev.declaration_id)
         IS NOT DISTINCT FROM
         (candidate.organization_id, candidate.company_id, candidate.document_id, candidate.related_document_id, candidate.event_type,
          candidate.from_bucket, candidate.to_bucket, candidate.amount, candidate.occurred_on, candidate.posting_date,
          candidate.trigger_month, candidate.cause_type, candidate.cause_id, candidate.follows_event_id, candidate.evidence_capture_id,
          candidate.journal_entry_id, candidate.journal_role, candidate.correction_route, candidate.affected_period_start,
          candidate.affected_period_end, candidate.rule_version, candidate.provenance, candidate.backfill_migration,
          candidate.declaration_id)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_event_restates(input_vat_events, input_vat_events) FROM PUBLIC;--> statement-breakpoint

-- ── 3. 🔴 T(D) — the credit-note ceiling, ONE definition (D5(a)). ──────────
-- An in-system document: its own VAT. An OPENING payable: its DECLARED
-- historical VAT, read from the ledger — never its own vat_amount, which is 0
-- by construction (bills_opening_no_vat_chk), and 0 when nothing is declared.
CREATE OR REPLACE FUNCTION input_vat_document_ceiling(p_document_id integer) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN b.is_opening
              THEN coalesce((SELECT sum(v.amount) FROM input_vat_events v
                              WHERE v.document_id = b.id AND v.event_type = 'declared_opening'), 0::numeric)
              ELSE b.vat_amount END
    FROM bills b WHERE b.id = p_document_id
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_document_ceiling(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION input_vat_document_ceiling(integer) TO authenticated;--> statement-breakpoint

-- ── 4. 🔴 A supplier note against an OPENING payable — ONE definition. ─────
-- NULL for an in-system original. For an opening one, in order:
--   · the supplier's credit note itself is attached to the note (a capture
--     bound to it — accountant E4; paper §G Rule 3): otherwise entering VAT 0
--     would silently bypass the historical treatment;
--   · the payable's historical VAT is DECLARED (a declaration and its
--     declared recognition): UNKNOWN is refused, for every note;
--   · the supply is not transitional (before 2018, or at 5 %: paper §D, Q-OP-6).
-- Read by the note refusal (a VAT-bearing note, before it posts) AND by the
-- cache check at COMMIT (every posted note, VAT 0 included) — one definition,
-- two readers.
CREATE OR REPLACE FUNCTION input_vat_opening_note_precheck(p_document_id integer, p_note_id integer) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  d record;
  dec record;
BEGIN
  SELECT b.id, b.is_opening, b.date, b.reversed_at INTO d FROM bills b WHERE b.id = p_document_id;
  IF d.id IS NULL OR NOT d.is_opening THEN RETURN NULL; END IF;
  -- A payable its migration has reversed (batch reversal, or replaced by a correction)
  -- is history, not a live debt: nothing corrects it any more. Its declaration and
  -- declared recognition survive (append-only) — which is exactly why this is asked first.
  IF d.reversed_at IS NOT NULL THEN RETURN 'input_vat_note_opening_reversed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM captured_documents c WHERE c.bill_id = p_note_id AND c.status <> 'discarded') THEN
    RETURN 'supplier_note_evidence_missing';
  END IF;
  SELECT x.id, x.vat_rate INTO dec FROM opening_payable_vat_declarations x
   WHERE x.bill_id = d.id
     AND EXISTS (SELECT 1 FROM input_vat_events v WHERE v.document_id = d.id AND v.event_type = 'declared_opening' AND v.declaration_id = x.id);
  IF dec.id IS NULL THEN RETURN 'input_vat_note_opening_undeclared'; END IF;
  IF d.date < '2018-01-01' OR dec.vat_rate = 5 THEN RETURN 'input_vat_note_transitional_supply'; END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_opening_note_precheck(integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION input_vat_opening_note_precheck(integer, integer) TO authenticated;--> statement-breakpoint

-- ── 5. 🔴 The credit-note rule (replaces 0109 §3). ─────────────────────────
-- In order: 0. the opening-payable precheck (§4); 1. CI-1 against T(D) (§3);
-- 2. NI-4 (unchanged: any reversal / restoration / correction / lapse EVENT —
-- a declared history is not one); 3. S1: an OPENING payable with VAT in more
-- than one bucket → `input_vat_note_multistate` (the LEVEL split is S2; an
-- ordinary document keeps 0109's buckets and refusal exactly); 4. exactly one non-zero
-- bucket and the note fits → admitted from it; 5. otherwise
-- `input_vat_note_allocation_undecided` (CN-7, CN-8).
CREATE OR REPLACE FUNCTION input_vat_note_refusal(p_document_id integer, p_note_id integer, p_amount numeric)
RETURNS TABLE (refusal text, from_bucket text, remaining numeric, bucket_amount numeric)
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  d record;
  others numeric;
  v_ceiling numeric;
  v_held numeric; v_claimed numeric; v_blocked numeric; v_reversed numeric; v_not_deducted numeric;
  nonzero int;
  v_bucket text;
  v_amount numeric;
  v_remaining numeric;
  pre text;
BEGIN
  SELECT b.id, b.is_opening, b.vat_amount INTO d FROM bills b WHERE b.id = p_document_id;
  IF d.id IS NULL THEN
    RETURN QUERY SELECT 'input_vat_note_original_missing'::text, NULL::text, 0::numeric, 0::numeric; RETURN;
  END IF;
  pre := input_vat_opening_note_precheck(p_document_id, p_note_id);
  IF pre IS NOT NULL THEN
    RETURN QUERY SELECT pre, NULL::text, 0::numeric, 0::numeric; RETURN;
  END IF;
  v_ceiling := input_vat_document_ceiling(p_document_id);
  SELECT coalesce(sum(n.vat_amount), 0) INTO others FROM bills n
   WHERE n.credit_note_against_bill_id = p_document_id
     AND n.document_type IN ('credit_note', 'advance_credit_note')
     AND n.status NOT IN ('draft', 'submitted')
     AND n.id IS DISTINCT FROM p_note_id;
  v_remaining := v_ceiling - others;
  IF p_amount > v_remaining THEN
    RETURN QUERY SELECT 'credit_note_exceeds_invoice_vat'::text, NULL::text, v_remaining, 0::numeric; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM input_vat_events v
              WHERE v.document_id = p_document_id
                AND v.event_type IN ('reversed_unpaid', 'restored_on_payment', 'corrected_blocked', 'lapsed_expired', 'lapsed_written_off')) THEN
    RETURN QUERY SELECT 'input_vat_note_interaction_undecided'::text, NULL::text, v_remaining, 0::numeric; RETURN;
  END IF;
  SELECT coalesce(max(bl.held), 0), coalesce(max(bl.claimed), 0), coalesce(max(bl.blocked), 0),
         coalesce(max(bl.reversed_unpaid), 0), coalesce(max(bl.not_deducted), 0)
    INTO v_held, v_claimed, v_blocked, v_reversed, v_not_deducted
    FROM input_vat_balances bl WHERE bl.document_id = p_document_id;
  -- An ordinary document counts 13B-3's three buckets, exactly as 0109 did (its
  -- reversed VAT is refused by NI-4 above, which stays THE guard); only an OPENING
  -- payable's declared history can put VAT in REVERSED_UNPAID or NOT_DEDUCTED here,
  -- and only an opening payable gets the S1 name for a split position.
  nonzero := (v_held > 0)::int + (v_claimed > 0)::int + (v_blocked > 0)::int
           + CASE WHEN d.is_opening THEN (v_reversed > 0)::int + (v_not_deducted > 0)::int ELSE 0 END;
  IF nonzero > 1 AND d.is_opening THEN
    RETURN QUERY SELECT 'input_vat_note_multistate'::text, NULL::text, v_remaining, 0::numeric; RETURN;
  END IF;
  IF nonzero = 1 THEN
    v_bucket := CASE WHEN v_held > 0 THEN 'HELD' WHEN v_claimed > 0 THEN 'CLAIMED' WHEN v_blocked > 0 THEN 'BLOCKED'
                     WHEN v_reversed > 0 THEN 'REVERSED_UNPAID' ELSE 'NOT_DEDUCTED' END;
    v_amount := CASE v_bucket WHEN 'HELD' THEN v_held WHEN 'CLAIMED' THEN v_claimed WHEN 'BLOCKED' THEN v_blocked
                              WHEN 'REVERSED_UNPAID' THEN v_reversed ELSE v_not_deducted END;
    IF p_amount <= v_amount THEN
      RETURN QUERY SELECT NULL::text, v_bucket, v_remaining, v_amount; RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT 'input_vat_note_allocation_undecided'::text, v_bucket, v_remaining, coalesce(v_amount, 0::numeric);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_note_refusal(integer, integer, numeric) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION input_vat_note_refusal(integer, integer, numeric) TO authenticated;--> statement-breakpoint

-- ── 6. 🔴 Admission (replaces 0109 §4). ────────────────────────────────────
-- Everything 0109 checked, unchanged, plus S1:
--   · an OPENING payable admits exactly two shapes: its ONE declared
--     recognition (it must restate its declaration — the bucket its state
--     names, the declared historical VAT, the declaration's date), and, once
--     declared, credit-note reductions. Nothing else, ever;
--   · a declared recognition exists ONLY on an opening payable;
--   · the NOT_DEDUCTED bucket.
CREATE OR REPLACE FUNCTION input_vat_events_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t   input_vat_event_transitions%ROWTYPE;
  d   record;
  x   record;
  nt  record;
  r   record;
  dec record;
  bal input_vat_balances%ROWTYPE;
  prev input_vat_events%ROWTYPE;
  amt numeric(15, 2) := coalesce(NEW.amount, 0);
  window_end text;
  expected numeric;
BEGIN
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
  -- Always assigned (a row of NULLs when the event names no declaration), so every
  -- later `dec.` read is a named refusal, never "record is not assigned yet".
  SELECT * INTO dec FROM opening_payable_vat_declarations WHERE id = NEW.declaration_id;
  IF NEW.declaration_id IS NOT NULL THEN
    IF dec.organization_id IS DISTINCT FROM NEW.organization_id OR dec.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'input VAT event: declaration % is not in this organisation and company', NEW.declaration_id
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_tenant';
    END IF;
  END IF;

  -- Which documents carry events at all (13B-3, extended by S1).
  IF d.is_opening THEN
    IF NEW.event_type = 'declared_opening' THEN
      IF dec.id IS NULL OR dec.bill_id IS DISTINCT FROM NEW.document_id THEN
        RAISE EXCEPTION 'input VAT event declared_opening on % must name the historical VAT declaration of THIS opening payable', d.bill_number
          USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_shape';
      END IF;
      IF NEW.to_bucket IS DISTINCT FROM (CASE dec.state WHEN 'DEDUCTED' THEN 'CLAIMED' WHEN 'NOT_DEDUCTED' THEN 'NOT_DEDUCTED'
                                                         WHEN 'BLOCKED_ART50' THEN 'BLOCKED' WHEN 'REVERSED_ART40_10' THEN 'REVERSED_UNPAID' END) THEN
        RAISE EXCEPTION 'input VAT event declared_opening on %: a % declaration recognises its VAT in the bucket its state names, not %', d.bill_number, dec.state, NEW.to_bucket
          USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_shape';
      END IF;
      IF amt <> dec.historical_vat THEN
        RAISE EXCEPTION 'input VAT event declared_opening on %: it recognises exactly the declared historical VAT %, not %', d.bill_number, dec.historical_vat, amt
          USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_amount';
      END IF;
      IF NEW.occurred_on IS DISTINCT FROM dec.declared_on THEN
        RAISE EXCEPTION 'input VAT event declared_opening on %: it occurs on the declaration''s date %, not %', d.bill_number, dec.declared_on, NEW.occurred_on
          USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_dates';
      END IF;
    ELSIF NEW.event_type = 'reduced_by_note' THEN
      IF NOT EXISTS (SELECT 1 FROM input_vat_events v WHERE v.document_id = NEW.document_id AND v.event_type = 'declared_opening') THEN
        RAISE EXCEPTION 'supplier credit note against % : the opening payable''s historical VAT is not declared, so its treatment is UNKNOWN', d.bill_number
          USING ERRCODE = '23514', CONSTRAINT = 'input_vat_note_opening_undeclared';
      END IF;
    ELSE
      RAISE EXCEPTION 'input VAT event: document % (%) is an opening (Batch 1C) payable — it carries only its declared historical VAT and credit-note reductions, never a %',
        NEW.document_id, d.bill_number, NEW.event_type
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_shape';
    END IF;
  ELSIF NEW.event_type = 'declared_opening' THEN
    RAISE EXCEPTION 'input VAT event declared_opening: % is not an opening (Batch 1C) payable — only a migrated payable has a declared history', d.bill_number
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
  -- date are the same fact for every type but a 40(11) restoration.
  IF NEW.occurred_on < d.date THEN
    RAISE EXCEPTION 'input VAT event: % is before document % (dated %)', NEW.occurred_on, NEW.document_id, d.date
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_dates';
  END IF;
  IF NEW.event_type <> 'restored_on_payment' AND NEW.posting_date <> NEW.occurred_on THEN
    RAISE EXCEPTION 'input VAT event %: posting date % must equal its date % (moving a lapse to another date is not decided — G2)',
      NEW.event_type, NEW.posting_date, NEW.occurred_on
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_dates';
  END IF;
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
  -- A retry of an act already recorded, seen under the lock (a concurrent
  -- first attempt committed while this one waited) — see 0109 §4.
  SELECT * INTO prev FROM input_vat_events WHERE organization_id = NEW.organization_id AND idempotency_key = NEW.idempotency_key;
  IF prev.id IS NOT NULL THEN
    IF NOT input_vat_event_restates(prev, NEW) THEN
      RAISE EXCEPTION 'input VAT event: idempotency key % already records a DIFFERENT act (event % — % % → % of % on document %); a key names one act and is never reused',
        NEW.idempotency_key, prev.id, prev.event_type, prev.from_bucket, prev.to_bucket, prev.amount, prev.document_id
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_idempotency_conflict';
    END IF;
    RETURN NEW;
  END IF;
  -- 🔴 O-2 and S1, under the lock (§5 above — the same function the writer asks first).
  IF NEW.event_type = 'reduced_by_note' THEN
    SELECT * INTO r FROM input_vat_note_refusal(NEW.document_id, NEW.related_document_id, amt);
    IF r.refusal IS NOT NULL THEN
      RAISE EXCEPTION '%', CASE r.refusal
          WHEN 'credit_note_exceeds_invoice_vat' THEN format('supplier credit note %s reduces VAT by %s, but only %s of the VAT charged on %s (%s) is left after its other credit notes (IR Art. 54(1))', nt.bill_number, amt, r.remaining, d.bill_number, input_vat_document_ceiling(d.id))
          WHEN 'input_vat_note_interaction_undecided' THEN format('%s has a non-payment reversal, restoration, Art. 50 correction or lapse in its history; how a credit note applies after one is not decided (CN-1…CN-6)', d.bill_number)
          WHEN 'input_vat_note_allocation_undecided' THEN format('supplier credit note %s (VAT %s) is within the VAT charged on %s but does not fit its single VAT position (%s %s); how it would be allocated is not decided (CN-7 / CN-8)', nt.bill_number, amt, d.bill_number, coalesce(r.from_bucket, 'none'), r.bucket_amount)
          WHEN 'input_vat_note_multistate' THEN format('%s holds input VAT in more than one position; a credit note against it needs the proportional (LEVEL) split, which is not enabled (S2)', d.bill_number)
          WHEN 'supplier_note_evidence_missing' THEN format('supplier credit note %s against the opening payable %s has no supplier document attached', nt.bill_number, d.bill_number)
          WHEN 'input_vat_note_opening_undeclared' THEN format('%s is an opening payable whose historical VAT is not declared; its treatment is UNKNOWN', d.bill_number)
          WHEN 'input_vat_note_opening_reversed' THEN format('%s is an opening payable its migration has reversed; it is history, and no credit note corrects it', d.bill_number)
          WHEN 'input_vat_note_transitional_supply' THEN format('%s is a transitional supply (before 2018, or at 5 %%); a credit note against it is not supported', d.bill_number)
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
    WHEN 'NOT_DEDUCTED'      THEN bal.not_deducted      := bal.not_deducted - amt;
    ELSE NULL;
  END CASE;
  CASE NEW.to_bucket
    WHEN 'HELD'              THEN bal.held              := bal.held + amt;
    WHEN 'CLAIMED'           THEN bal.claimed           := bal.claimed + amt;
    WHEN 'REVERSED_UNPAID'   THEN bal.reversed_unpaid   := bal.reversed_unpaid + amt;
    WHEN 'BLOCKED'           THEN bal.blocked           := bal.blocked + amt;
    WHEN 'CORRECTED_BLOCKED' THEN bal.corrected_blocked := bal.corrected_blocked + amt;
    WHEN 'LAPSED'            THEN bal.lapsed            := bal.lapsed + amt;
    WHEN 'NOT_DEDUCTED'      THEN bal.not_deducted      := bal.not_deducted + amt;
    ELSE NULL;
  END CASE;
  IF bal.held < 0 OR bal.claimed < 0 OR bal.reversed_unpaid < 0 OR bal.blocked < 0 OR bal.corrected_blocked < 0 OR bal.lapsed < 0 OR bal.not_deducted < 0 THEN
    RAISE EXCEPTION 'input VAT event % on document %: bucket % would go negative', NEW.event_type, NEW.document_id, NEW.from_bucket
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_bucket_negative';
  END IF;
  NEW.buckets_after := jsonb_build_object(
    'held', bal.held, 'claimed', bal.claimed, 'reversed_unpaid', bal.reversed_unpaid,
    'blocked', bal.blocked, 'corrected_blocked', bal.corrected_blocked, 'lapsed', bal.lapsed,
    'not_deducted', bal.not_deducted);
  RETURN NEW;
END $$;--> statement-breakpoint

-- ── 7. The balance row follows the event (replaces 0107 — adds NOT_DEDUCTED). ─
CREATE OR REPLACE FUNCTION input_vat_events_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE input_vat_balances
     SET held              = (NEW.buckets_after ->> 'held')::numeric,
         claimed           = (NEW.buckets_after ->> 'claimed')::numeric,
         reversed_unpaid   = (NEW.buckets_after ->> 'reversed_unpaid')::numeric,
         blocked           = (NEW.buckets_after ->> 'blocked')::numeric,
         corrected_blocked = (NEW.buckets_after ->> 'corrected_blocked')::numeric,
         lapsed            = (NEW.buckets_after ->> 'lapsed')::numeric,
         not_deducted      = coalesce((NEW.buckets_after ->> 'not_deducted')::numeric, 0),
         last_event_id     = NEW.id,
         updated_at        = now()
   WHERE document_id = NEW.document_id;
  RETURN NULL;
END $$;--> statement-breakpoint

-- ── 8. 🔴 Journal linkage (replaces 0109 §5). ──────────────────────────────
-- Unchanged, but for S1's two new note shapes: a note on NOT_DEDUCTED or
-- (declared) REVERSED_UNPAID VAT has NO input-VAT effect, so — like a note on
-- BLOCKED VAT (X5) — its entry carries no VAT line at all: the note's VAT
-- reduces the same cost (AQ-2; D7 `cost`). A declared recognition has no
-- journal entry (the function returns at once for it).
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
  -- X5, extended by S1: VAT with no input-VAT effect is COST — the entry carries no VAT line at all.
  IF NEW.event_type = 'recognised_blocked'
     OR (NEW.event_type = 'reduced_by_note' AND NEW.from_bucket IN ('BLOCKED', 'NOT_DEDUCTED', 'REVERSED_UNPAID')) THEN
    SELECT coalesce(sum(l.debit_amount + l.credit_amount), 0) INTO vat_lines
      FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
     WHERE l.journal_entry_id = e.id AND c.system_code IN ('VAT_INPUT', 'VAT_AWAITING_EVIDENCE');
    IF vat_lines <> 0 THEN
      RAISE EXCEPTION 'input VAT event % (%, document %): % VAT has no input-VAT effect — entry % must carry no VAT line (it carries %)',
        NEW.id, NEW.event_type, d.bill_number, lower(NEW.from_bucket), e.entry_number, vat_lines
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_amount';
    END IF;
    IF NEW.event_type = 'reduced_by_note' THEN
      IF NEW.amount IS DISTINCT FROM nt.vat_amount THEN
        RAISE EXCEPTION 'input VAT event % (reduced_by_note, document %): a single-position note reduces exactly its own VAT %, not %',
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

-- ── 9. 🔴 "The document agrees with its events" (replaces 0109 §6). ─────────
-- Unchanged for in-system documents. S1:
--   · an OPENING payable carries events only when its historical VAT is
--     declared: then exactly one declared recognition restating the
--     declaration, and nothing but credit-note reductions besides;
--   · a credit note against an opening payable passes the opening precheck
--     (§4) at COMMIT — VAT 0 included — and CI-1 reads T(D) (§3).
CREATE OR REPLACE FUNCTION input_vat_document_mismatch(p_bill_id integer) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  b record;
  o record;
  rec record;
  clm record;
  nev record;
  dec record;
  v_held numeric;
  recognisable numeric;
  notes_vat numeric;
  v_ceiling numeric;
  pre text;
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

  -- An opening payable carries no VAT of its own. Its columns are empty or read
  -- claimed on its own date (0106). Its events — only once its history is
  -- DECLARED — are that declaration's one recognition, then credit notes.
  IF b.is_opening THEN
    IF b.vat_amount <> 0
       OR NOT ((b.input_vat_state IS NULL AND b.input_vat_pending = 0 AND b.input_vat_claimed_on IS NULL AND b.input_vat_claim_entry_id IS NULL)
            OR (b.input_vat_state = 'claimed' AND b.input_vat_claimed_on = b.date AND b.input_vat_pending = 0 AND b.input_vat_claim_entry_id IS NULL)) THEN
      RETURN format('%s is an opening (Batch 1C) payable: expected no VAT and no input VAT position of its own (columns empty, or claimed on its own date %s as 0106 recorded); it has VAT %s and its columns read %s',
        label, b.date, b.vat_amount, actual);
    END IF;
    SELECT x.id, x.historical_vat, x.state INTO dec FROM opening_payable_vat_declarations x WHERE x.bill_id = b.id;
    IF dec.id IS NULL THEN
      IF EXISTS (SELECT 1 FROM input_vat_events v WHERE v.document_id = b.id) THEN
        RETURN format('%s is an opening payable with no historical VAT declaration, yet input VAT events name it', label);
      END IF;
      RETURN NULL;
    END IF;
    SELECT * INTO rec FROM input_vat_events v WHERE v.document_id = b.id AND v.event_type = 'declared_opening';
    IF rec.id IS NULL OR rec.declaration_id IS DISTINCT FROM dec.id OR rec.amount IS DISTINCT FROM dec.historical_vat THEN
      RETURN format('%s: its historical VAT declaration (id %s, %s, VAT %s) has no matching declared recognition', label, dec.id, dec.state, dec.historical_vat);
    END IF;
    IF EXISTS (SELECT 1 FROM input_vat_events v WHERE v.document_id = b.id AND v.event_type NOT IN ('declared_opening', 'reduced_by_note')) THEN
      RETURN format('%s: an opening payable carries only its declared recognition and credit-note reductions', label);
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
    SELECT id, bill_number, vat_amount, is_opening INTO o FROM bills WHERE id = b.credit_note_against_bill_id;
    IF o.is_opening THEN
      pre := input_vat_opening_note_precheck(o.id, b.id);
      IF pre IS NOT NULL THEN
        RETURN format('%s is a supplier note against the opening payable %s (id %s): %s', label, o.bill_number, o.id, pre);
      END IF;
    END IF;
    v_ceiling := input_vat_document_ceiling(o.id);
    SELECT coalesce(sum(n.vat_amount), 0) INTO notes_vat FROM bills n
     WHERE n.credit_note_against_bill_id = o.id AND n.document_type IN ('credit_note', 'advance_credit_note') AND n.status NOT IN ('draft', 'submitted');
    IF notes_vat > v_ceiling THEN
      RETURN format('CI-1: the posted credit notes against %s (id %s) reduce VAT by %s, more than the %s it charged', o.bill_number, o.id, notes_vat, v_ceiling);
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

-- ── 10. The reconciliation (replaces 0109 §8): the balance rows are now checked
-- against their events for EVERY bucket, NOT_DEDUCTED included. The GL
-- mismatch (0109 §7) is unchanged: it skips an opening payable, whose declared
-- position lives in the cut-over aggregate — each of its credit notes is
-- checked against its own entry by the journal link (§8).
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
             coalesce(sum(CASE WHEN v.to_bucket = 'BLOCKED' THEN v.amount END), 0) - coalesce(sum(CASE WHEN v.from_bucket = 'BLOCKED' THEN v.amount END), 0) AS blocked,
             coalesce(sum(CASE WHEN v.to_bucket = 'REVERSED_UNPAID' THEN v.amount END), 0) - coalesce(sum(CASE WHEN v.from_bucket = 'REVERSED_UNPAID' THEN v.amount END), 0) AS reversed_unpaid,
             coalesce(sum(CASE WHEN v.to_bucket = 'CORRECTED_BLOCKED' THEN v.amount END), 0) - coalesce(sum(CASE WHEN v.from_bucket = 'CORRECTED_BLOCKED' THEN v.amount END), 0) AS corrected_blocked,
             coalesce(sum(CASE WHEN v.to_bucket = 'LAPSED' THEN v.amount END), 0) - coalesce(sum(CASE WHEN v.from_bucket = 'LAPSED' THEN v.amount END), 0) AS lapsed,
             coalesce(sum(CASE WHEN v.to_bucket = 'NOT_DEDUCTED' THEN v.amount END), 0) - coalesce(sum(CASE WHEN v.from_bucket = 'NOT_DEDUCTED' THEN v.amount END), 0) AS not_deducted
        FROM input_vat_events v WHERE v.document_id = bl.document_id) s ON true
   WHERE (s.held <> bl.held OR s.claimed <> bl.claimed OR s.blocked <> bl.blocked OR s.reversed_unpaid <> bl.reversed_unpaid
          OR s.corrected_blocked <> bl.corrected_blocked OR s.lapsed <> bl.lapsed OR s.not_deducted <> bl.not_deducted)
     AND (p_organization_id IS NULL OR bl.organization_id = p_organization_id)
   ORDER BY 1, 4
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_reconciliation(uuid) FROM PUBLIC;--> statement-breakpoint

-- ── 11. 🔴 The DECLARATION — what the database refuses (AC-8). ─────────────
-- At INSERT: the item, its live opening bill and the declaration are ONE
-- tenant's; the item is a committed payable whose live row is that bill; the
-- declared figures agree with what the migration staged (a staged amount or
-- rate is a fact the declaration cannot contradict); the periods fall between
-- the invoice and the cut-over; and a DEDUCTED history is refused when the
-- payable was still unpaid past its Art. 40(10) trigger before the cut-over —
-- the mandatory reversal would then be missing from the history the
-- accountant requires to be established (§M.6 #7; contract §15.1.4). The
-- trigger month is D13B-06's: the last day of (supply month + 12).
CREATE OR REPLACE FUNCTION opening_payable_vat_declarations_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  it record;
  bt record;
  bl record;
  staged_amount numeric;
  staged_rate numeric;
  cutover_month text;
  trigger_date date;
BEGIN
  SELECT i.id, i.organization_id, i.company_id, i.item_type, i.historical_vat, i.batch_id, i.original_amount INTO it FROM migration_open_items i WHERE i.id = NEW.migration_open_item_id;
  IF it.id IS NULL OR it.organization_id IS DISTINCT FROM NEW.organization_id OR it.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'historical VAT declaration: migrated item % is not in this organisation and company', NEW.migration_open_item_id
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_tenant';
  END IF;
  IF it.item_type <> 'ap' THEN
    RAISE EXCEPTION 'historical VAT declaration: migrated item % is a receivable — input VAT history belongs to a payable', NEW.migration_open_item_id
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_not_payable';
  END IF;
  SELECT b.status, b.opening_date INTO bt FROM migration_batches b WHERE b.id = it.batch_id;
  IF bt.status IS DISTINCT FROM 'committed' THEN
    RAISE EXCEPTION 'historical VAT declaration: migrated item % belongs to a batch that is % — only a committed migration has a live payable', NEW.migration_open_item_id, coalesce(bt.status, 'missing')
      USING ERRCODE = '23514', CONSTRAINT = 'opening_item_not_live';
  END IF;
  SELECT b.id, b.organization_id, b.company_id, b.is_opening, b.migration_open_item_id, b.reversed_at, b.date, b.status INTO bl FROM bills b WHERE b.id = NEW.bill_id;
  IF bl.id IS NULL OR bl.organization_id IS DISTINCT FROM NEW.organization_id OR bl.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'historical VAT declaration: bill % is not in this organisation and company', NEW.bill_id
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_tenant';
  END IF;
  IF NOT bl.is_opening OR bl.migration_open_item_id IS DISTINCT FROM NEW.migration_open_item_id OR bl.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'historical VAT declaration: bill % is not the LIVE opening payable of migrated item %', NEW.bill_id, NEW.migration_open_item_id
      USING ERRCODE = '23514', CONSTRAINT = 'opening_item_not_live';
  END IF;
  IF NEW.declared_on < bl.date THEN
    RAISE EXCEPTION 'historical VAT declaration: dated %, before the payable''s own date %', NEW.declared_on, bl.date
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_dates';
  END IF;
  staged_amount := nullif(it.historical_vat ->> 'amount', '')::numeric;
  staged_rate := nullif(it.historical_vat ->> 'rate', '')::numeric;
  IF staged_amount IS NOT NULL AND staged_amount <> NEW.historical_vat THEN
    RAISE EXCEPTION 'historical VAT declaration: the migration staged historical VAT %, the declaration states % — a staged fact is not contradicted', staged_amount, NEW.historical_vat
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_contradicts_staging';
  END IF;
  IF staged_rate IS NOT NULL AND staged_rate <> NEW.vat_rate THEN
    RAISE EXCEPTION 'historical VAT declaration: the migration staged a % %% rate, the declaration states % %%', staged_rate, NEW.vat_rate
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_contradicts_staging';
  END IF;
  -- Arithmetic: a document of gross G at rate r carries at most G·r/(100+r) of VAT.
  IF NEW.historical_vat > round(it.original_amount * NEW.vat_rate / (100 + NEW.vat_rate), 2) THEN
    RAISE EXCEPTION 'historical VAT declaration: a document of % at % %% carries at most % of VAT, not %', it.original_amount, NEW.vat_rate,
      round(it.original_amount * NEW.vat_rate / (100 + NEW.vat_rate), 2), NEW.historical_vat
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_exceeds_document';
  END IF;
  cutover_month := to_char(bt.opening_date, 'YYYY-MM');
  IF NEW.deducted_period IS NOT NULL AND (NEW.deducted_period < substr(bl.date, 1, 7) OR NEW.deducted_period > cutover_month) THEN
    RAISE EXCEPTION 'historical VAT declaration: the deduction period % must fall between the invoice (%) and the cut-over (%)', NEW.deducted_period, substr(bl.date, 1, 7), cutover_month
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_dates';
  END IF;
  IF NEW.reversed_period IS NOT NULL AND NEW.reversed_period > cutover_month THEN
    RAISE EXCEPTION 'historical VAT declaration: the reversal period % is after the cut-over (%) — a reversal after cut-over is this system''s, not the history''s', NEW.reversed_period, cutover_month
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_dates';
  END IF;
  trigger_date := (date_trunc('month', bl.date::date) + interval '13 months' - interval '1 day')::date;
  IF NEW.state = 'DEDUCTED' AND trigger_date < bt.opening_date THEN
    RAISE EXCEPTION 'historical VAT declaration: the payable was still unpaid at its Art. 40(10) trigger (%), before the cut-over (%), so a deduction that was never reversed is not an established history',
      trigger_date, bt.opening_date
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_40_10_not_established';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER opening_payable_vat_declarations_admit BEFORE INSERT ON "opening_payable_vat_declarations"
  FOR EACH ROW EXECUTE FUNCTION opening_payable_vat_declarations_admit();--> statement-breakpoint

-- 🔴 COMPLETE AT COMMIT: a declaration exists only with the evidence its state
-- requires (accountant AQ-1; the §M.4 product evidence policy — NOT a ZATCA
-- schema) and with its ONE declared recognition in the ledger. A declaration
-- with no sufficient evidence cannot commit, so the item stays UNKNOWN.
CREATE OR REPLACE FUNCTION opening_payable_vat_declarations_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  needed text[];
  k text;
BEGIN
  needed := CASE NEW.state
    WHEN 'DEDUCTED'          THEN ARRAY['ORIGINAL_TAX_INVOICE', 'DEDUCTION_RETURN']
    WHEN 'NOT_DEDUCTED'      THEN ARRAY['ORIGINAL_TAX_INVOICE']
    WHEN 'BLOCKED_ART50'     THEN ARRAY['ORIGINAL_TAX_INVOICE', 'CLASSIFICATION']
    WHEN 'REVERSED_ART40_10' THEN ARRAY['ORIGINAL_TAX_INVOICE', 'DEDUCTION_RETURN', 'REVERSAL_RETURN', 'PAYMENT_RECORDS']
  END;
  FOREACH k IN ARRAY needed LOOP
    IF NOT EXISTS (SELECT 1 FROM opening_payable_vat_declaration_evidence e WHERE e.declaration_id = NEW.id AND e.kind = k) THEN
      RAISE EXCEPTION 'historical VAT declaration % (%): the % evidence is missing — without it the history is not established and the item stays UNKNOWN', NEW.id, NEW.state, k
        USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_evidence_missing';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM input_vat_events v WHERE v.declaration_id = NEW.id AND v.event_type = 'declared_opening') THEN
    RAISE EXCEPTION 'historical VAT declaration %: it has no declared recognition in the input VAT ledger', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_unrecognised';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER opening_payable_vat_declarations_complete AFTER INSERT ON "opening_payable_vat_declarations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opening_payable_vat_declarations_complete();--> statement-breakpoint

-- Evidence: the declaration's own tenant; a capture of that tenant, not
-- discarded, promoted as evidence of the declared payable itself (so it is
-- retained and never purged — the capture outbox, B3/C7), stated with the
-- content hash it was checked against.
CREATE OR REPLACE FUNCTION opening_payable_vat_declaration_evidence_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  dc record;
  cap record;
BEGIN
  SELECT id, organization_id, company_id, bill_id INTO dc FROM opening_payable_vat_declarations WHERE id = NEW.declaration_id;
  IF dc.id IS NULL OR dc.organization_id IS DISTINCT FROM NEW.organization_id OR dc.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'declaration evidence: declaration % is not in this organisation and company', NEW.declaration_id
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_tenant';
  END IF;
  SELECT id, organization_id, company_id, status, bill_id, sha256 INTO cap FROM captured_documents WHERE id = NEW.capture_id;
  IF cap.id IS NULL OR cap.organization_id IS DISTINCT FROM NEW.organization_id OR cap.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'declaration evidence: captured document % is not in this organisation and company', NEW.capture_id
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_tenant';
  END IF;
  IF cap.status = 'discarded' OR cap.bill_id IS DISTINCT FROM dc.bill_id THEN
    RAISE EXCEPTION 'declaration evidence: captured document % is not held as evidence of the declared payable (status %, bill %)', NEW.capture_id, cap.status, coalesce(cap.bill_id::text, 'none')
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_evidence_unbound';
  END IF;
  IF NEW.capture_sha256 IS DISTINCT FROM cap.sha256 THEN
    RAISE EXCEPTION 'declaration evidence: captured document % is not the document that was declared (content hash differs)', NEW.capture_id
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_evidence_hash';
  END IF;
  -- One document is one kind of evidence: a single file cannot stand for the invoice
  -- AND the return that deducted it (else one upload satisfies every required kind).
  IF EXISTS (SELECT 1 FROM opening_payable_vat_declaration_evidence e
              WHERE e.declaration_id = NEW.declaration_id AND e.capture_id = NEW.capture_id AND e.kind <> NEW.kind) THEN
    RAISE EXCEPTION 'declaration evidence: captured document % is already this declaration''s % evidence — each kind needs its own document', NEW.capture_id, NEW.kind
      USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declaration_evidence_reused';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER opening_payable_vat_declaration_evidence_admit BEFORE INSERT ON "opening_payable_vat_declaration_evidence"
  FOR EACH ROW EXECUTE FUNCTION opening_payable_vat_declaration_evidence_admit();--> statement-breakpoint

-- 🔴 APPEND-ONLY, for every role, the owner included — a declaration is a
-- statement made once; a wrong one is not edited (no correction route exists:
-- paper §F). Only the demo wipe passes it, in replica mode, on a demo-only
-- database (services/demo/demoReset.service.ts).
CREATE OR REPLACE FUNCTION opening_payable_vat_declarations_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'historical VAT declarations and their evidence are append-only: % is refused; a declaration is made once and never changed', TG_OP
    USING ERRCODE = '23514', CONSTRAINT = 'opening_vat_declarations_append_only';
END $$;--> statement-breakpoint
CREATE TRIGGER opening_payable_vat_declarations_immutable BEFORE UPDATE OR DELETE ON "opening_payable_vat_declarations"
  FOR EACH ROW EXECUTE FUNCTION opening_payable_vat_declarations_immutable();--> statement-breakpoint
CREATE TRIGGER opening_payable_vat_declarations_no_truncate BEFORE TRUNCATE ON "opening_payable_vat_declarations"
  FOR EACH STATEMENT EXECUTE FUNCTION opening_payable_vat_declarations_immutable();--> statement-breakpoint
CREATE TRIGGER opening_payable_vat_declaration_evidence_immutable BEFORE UPDATE OR DELETE ON "opening_payable_vat_declaration_evidence"
  FOR EACH ROW EXECUTE FUNCTION opening_payable_vat_declarations_immutable();--> statement-breakpoint
CREATE TRIGGER opening_payable_vat_declaration_evidence_no_truncate BEFORE TRUNCATE ON "opening_payable_vat_declaration_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION opening_payable_vat_declarations_immutable();--> statement-breakpoint

-- ── 12. Tenant isolation, grants — the 0107 pattern. ───────────────────────
ALTER TABLE "opening_payable_vat_declarations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."opening_payable_vat_declarations"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
ALTER TABLE "opening_payable_vat_declaration_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."opening_payable_vat_declaration_evidence"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "opening_payable_vat_declarations" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "opening_payable_vat_declarations_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "opening_payable_vat_declaration_evidence" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "opening_payable_vat_declaration_evidence_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['opening_payable_vat_declarations', 'opening_payable_vat_declaration_evidence'] LOOP
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END LOOP;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- ── 13. The declaration capability — admin and accountant only (D4). ───────
-- A DEDICATED resource, not a widening of `migration` (which would hand an
-- accountant batch create / commit / reverse). Read by requirePermission.
INSERT INTO "permissions" (role, resource, action) VALUES
  ('admin', 'opening_vat_declaration', 'read'), ('admin', 'opening_vat_declaration', 'create'),
  ('accountant', 'opening_vat_declaration', 'read'), ('accountant', 'opening_vat_declaration', 'create')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- ── 14. 🔴 THE GATE — everything S1 changed still reconciles. ─────────────
-- S1 changes the rules for exactly three things, and the gate covers exactly
-- those: an OPENING payable, a supplier note AGAINST one (13B-3 admitted a
-- VAT-0 note there; it now needs a declaration and its supplier document —
-- such a row is NAMED here and the migration STOPS, never grandfathered), and
-- the balance rows (now summed over every bucket). Every other document's rule
-- is 0109's, gated by 0109 when it ran; re-judging it here would add nothing
-- S1 changed, and would re-fail on data 0109 already names.
DO $$
DECLARE
  n integer;
  first_rows text;
BEGIN
  SELECT count(*), string_agg(format('document %s: %s', document_id, problem), E'\n' ORDER BY document_id)
    INTO n, first_rows
    FROM (SELECT r.* FROM input_vat_reconciliation() r
            JOIN bills b ON b.id = r.document_id
            LEFT JOIN bills o ON o.id = b.credit_note_against_bill_id
           WHERE b.is_opening OR o.is_opening OR r.problem LIKE 'balance row of document %'
           LIMIT 20) r;
  IF n > 0 THEN
    RAISE EXCEPTION 'migration 0110: % input VAT document(s) do not reconcile under the S1 rules; the first:%', n, E'\n' || first_rows
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_s1_gate';
  END IF;
END $$;
