-- PHASE 13B-1 — the input-VAT event ledger, foundation only (2026-09-28).
-- Record: docs/product/phase-13b-vat-claim-ledger-architecture.md §25.
-- Schema reasoning: packages/db/src/schema/inputVatLedger.ts.
CREATE TABLE "input_vat_balances" (
	"document_id" integer PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"held" numeric(15, 2) DEFAULT '0' NOT NULL,
	"claimed" numeric(15, 2) DEFAULT '0' NOT NULL,
	"reversed_unpaid" numeric(15, 2) DEFAULT '0' NOT NULL,
	"blocked" numeric(15, 2) DEFAULT '0' NOT NULL,
	"corrected_blocked" numeric(15, 2) DEFAULT '0' NOT NULL,
	"lapsed" numeric(15, 2) DEFAULT '0' NOT NULL,
	"last_event_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "input_vat_balances_nonnegative_chk" CHECK (held >= 0 AND claimed >= 0 AND reversed_unpaid >= 0 AND blocked >= 0 AND corrected_blocked >= 0 AND lapsed >= 0)
);
--> statement-breakpoint
CREATE TABLE "input_vat_event_transitions" (
	"event_type" text NOT NULL,
	"from_bucket" text NOT NULL,
	"to_bucket" text NOT NULL,
	"journal_role" text,
	"admitted" boolean NOT NULL,
	"enabled_in" text NOT NULL,
	"basis" text NOT NULL,
	CONSTRAINT "input_vat_event_transitions_pk" PRIMARY KEY("event_type","from_bucket","to_bucket"),
	CONSTRAINT "input_vat_event_transitions_bucket_chk" CHECK (from_bucket IN ('NONE', 'HELD', 'CLAIMED', 'REVERSED_UNPAID', 'BLOCKED', 'CORRECTED_BLOCKED', 'LAPSED') AND to_bucket IN ('NONE', 'HELD', 'CLAIMED', 'REVERSED_UNPAID', 'BLOCKED', 'CORRECTED_BLOCKED', 'LAPSED')),
	CONSTRAINT "input_vat_event_transitions_role_chk" CHECK (journal_role IS NULL OR journal_role IN ('own_entry', 'claim_entry', 'event_entry'))
);
--> statement-breakpoint
CREATE TABLE "input_vat_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"document_id" integer NOT NULL,
	"related_document_id" integer,
	"event_type" text NOT NULL,
	"from_bucket" text NOT NULL,
	"to_bucket" text NOT NULL,
	"amount" numeric(15, 2),
	"occurred_on" text NOT NULL,
	"posting_date" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger_month" text,
	"reason" text,
	"cause_type" text,
	"cause_id" integer,
	"follows_event_id" integer,
	"evidence_capture_id" uuid,
	"evidence_snapshot" jsonb,
	"journal_entry_id" integer,
	"journal_role" text,
	"correction_route" text,
	"affected_period_start" text,
	"affected_period_end" text,
	"rule_version" text,
	"actor_user_id" integer,
	"actor_system" text,
	"provenance" text NOT NULL,
	"backfill_migration" text,
	"backfill_source" text,
	"source_record_ref" text,
	"idempotency_key" text NOT NULL,
	"buckets_after" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "input_vat_events_bucket_chk" CHECK (from_bucket IN ('NONE', 'HELD', 'CLAIMED', 'REVERSED_UNPAID', 'BLOCKED', 'CORRECTED_BLOCKED', 'LAPSED') AND to_bucket IN ('NONE', 'HELD', 'CLAIMED', 'REVERSED_UNPAID', 'BLOCKED', 'CORRECTED_BLOCKED', 'LAPSED')),
	CONSTRAINT "input_vat_events_amount_chk" CHECK ((amount IS NULL OR amount > 0) AND (amount IS NOT NULL OR (from_bucket = 'NONE' AND to_bucket = 'NONE'))),
	CONSTRAINT "input_vat_events_dates_chk" CHECK (occurred_on ~ '^\d{4}-\d{2}-\d{2}$' AND posting_date ~ '^\d{4}-\d{2}-\d{2}$' AND posting_date >= occurred_on),
	CONSTRAINT "input_vat_events_trigger_month_chk" CHECK ((trigger_month IS NULL OR trigger_month ~ '^\d{4}-\d{2}$') AND ((event_type = 'reversed_unpaid') = (trigger_month IS NOT NULL))),
	CONSTRAINT "input_vat_events_actor_chk" CHECK ((actor_user_id IS NULL) <> (actor_system IS NULL) AND (actor_user_id IS NULL OR length(btrim(coalesce(reason, ''))) > 0)),
	CONSTRAINT "input_vat_events_provenance_chk" CHECK ((provenance = 'recorded' AND backfill_migration IS NULL AND backfill_source IS NULL AND source_record_ref IS NULL)
       OR (provenance = 'reconstructed' AND backfill_migration IS NOT NULL AND backfill_source IS NOT NULL AND source_record_ref IS NOT NULL
           AND actor_user_id IS NULL AND actor_system LIKE 'migration:%')),
	CONSTRAINT "input_vat_events_journal_chk" CHECK ((journal_role IS NULL) = (journal_entry_id IS NULL) AND (journal_role IS NULL OR journal_role IN ('own_entry', 'claim_entry', 'event_entry'))),
	CONSTRAINT "input_vat_events_idempotency_chk" CHECK (length(btrim(idempotency_key)) > 0)
);
--> statement-breakpoint
ALTER TABLE "input_vat_balances" ADD CONSTRAINT "input_vat_balances_document_id_bills_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_vat_balances" ADD CONSTRAINT "input_vat_balances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_vat_balances" ADD CONSTRAINT "input_vat_balances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD CONSTRAINT "input_vat_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD CONSTRAINT "input_vat_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD CONSTRAINT "input_vat_events_document_id_bills_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD CONSTRAINT "input_vat_events_related_document_id_bills_id_fk" FOREIGN KEY ("related_document_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD CONSTRAINT "input_vat_events_evidence_capture_id_captured_documents_id_fk" FOREIGN KEY ("evidence_capture_id") REFERENCES "public"."captured_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD CONSTRAINT "input_vat_events_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD CONSTRAINT "input_vat_events_transition_fk" FOREIGN KEY ("event_type","from_bucket","to_bucket") REFERENCES "public"."input_vat_event_transitions"("event_type","from_bucket","to_bucket") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_vat_events" ADD CONSTRAINT "input_vat_events_follows_fk" FOREIGN KEY ("follows_event_id") REFERENCES "public"."input_vat_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "input_vat_balances_company_idx" ON "input_vat_balances" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "input_vat_events_idempotency_unq" ON "input_vat_events" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "input_vat_events_document_idx" ON "input_vat_events" USING btree ("company_id","document_id","id");--> statement-breakpoint
CREATE INDEX "input_vat_events_posting_idx" ON "input_vat_events" USING btree ("company_id","posting_date");--> statement-breakpoint
CREATE INDEX "input_vat_events_follows_idx" ON "input_vat_events" USING btree ("follows_event_id");--> statement-breakpoint
CREATE INDEX "input_vat_events_entry_idx" ON "input_vat_events" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "input_vat_events_own_journal_unq" ON "input_vat_events" USING btree ("journal_entry_id") WHERE journal_role IN ('claim_entry', 'event_entry');--> statement-breakpoint
CREATE UNIQUE INDEX "input_vat_events_one_recognition_unq" ON "input_vat_events" USING btree ("document_id","event_type") WHERE event_type LIKE 'recognised\_%';--> statement-breakpoint
CREATE UNIQUE INDEX "input_vat_events_one_claim_unq" ON "input_vat_events" USING btree ("document_id") WHERE event_type = 'claimed';--> statement-breakpoint
CREATE UNIQUE INDEX "input_vat_events_one_reversal_unq" ON "input_vat_events" USING btree ("document_id","trigger_month") WHERE event_type = 'reversed_unpaid';--> statement-breakpoint
CREATE UNIQUE INDEX "input_vat_events_one_restoration_unq" ON "input_vat_events" USING btree ("document_id","cause_id") WHERE event_type = 'restored_on_payment';
--> statement-breakpoint

-- ══════════════════════════════════════════════════════════════════════════
-- PHASE 13B-1 — THE INPUT-VAT EVENT LEDGER, FOUNDATION ONLY (2026-09-28).
-- Hand-written below this line: drizzle tracks neither template rows, seeded
-- reference data, triggers, RLS nor grants.
-- Record: docs/product/phase-13b-vat-claim-ledger-architecture.md §25.
-- 🔴 No production writer of events exists after this migration (13B-3 is the
-- first). The only live behaviour it changes is the generic-reversal guard.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. The two adjustment accounts (A-1), names verbatim. ──────────────────
-- 🔴 A-2: seed_org_chart_of_accounts() is NOT redefined. It copies template
-- ROWS column by column, so a new ROW reaches every new organisation unaided;
-- only a COLUMN change needs the function redefined (the 0088 / 0106
-- precedent; tests/org-seed-trigger.test.ts pins the column sets). CLAUDE.md
-- §4 states the rule more broadly — a recorded discrepancy (architecture §7.3).
INSERT INTO "system_account_templates" (code, name, name_ar, type, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, sort_order)
VALUES ('VAT_ADJ_NONPAYMENT', 'VAT Adjustment – Non-Payment (Art. 40(10))', 'تعديل ضريبة المدخلات – عدم السداد (المادة 40(10))', 'asset', true, false, 'O', false, 'current', 32),
       ('VAT_ADJ_BLOCKED',    'VAT Adjustment – Blocked (Art. 50)',    'تعديل ضريبة المدخلات – غير قابلة للخصم (المادة 50)',    'asset', true, false, 'O', false, 'current', 33)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint
-- Existing organisations get them too: the org-seed trigger fires only for NEW ones.
INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, is_posting)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class, true
  FROM organizations o
  CROSS JOIN system_account_templates t
 WHERE t.code IN ('VAT_ADJ_NONPAYMENT', 'VAT_ADJ_BLOCKED')
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

-- ── 2. An entry the ledger posts itself says so. ───────────────────────────
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_chk";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_chk"
  CHECK (source IS NULL OR source IN ('opening', 'opening_reversal', 'opening_correction', 'input_vat_event'));--> statement-breakpoint

-- ── 3. The transitions: which exist, which the database ADMITS. ────────────
-- ADMITTED ≠ ENABLED: no transition is produced by any writer in 13B-1.
INSERT INTO "input_vat_event_transitions" (event_type, from_bucket, to_bucket, journal_role, admitted, enabled_in, basis) VALUES
  ('recognised_claimed',  'NONE',              'CLAIMED',           'own_entry',   true,  '13B-3', 'Posted with sufficient evidence (live posting path; D13B-17)'),
  ('recognised_held',     'NONE',              'HELD',              'own_entry',   true,  '13B-3', 'Posted awaiting evidence (13A, X1; IR 49(7))'),
  ('recognised_blocked',  'NONE',              'BLOCKED',           'own_entry',   true,  '13B-3', 'Non-deductible at posting (13A, X5; Art. 50)'),
  ('claimed',             'HELD',              'CLAIMED',           'claim_entry', true,  '13B-3', 'Evidence held later: a normal later-period claim, whole amount (D13B-02, D13B-05)'),
  ('advance_deducted',    'NONE',              'NONE',              'own_entry',   true,  '13B-3', 'Annotation: a final bill deducts VAT claimed on the supplier advance invoice (Z-AP1)'),
  ('reversed_unpaid',     'CLAIMED',           'REVERSED_UNPAID',   'event_entry', true,  '13B-6', 'Mandatory Art. 40(10) reversal (D13B-06)'),
  ('restored_on_payment', 'REVERSED_UNPAID',   'CLAIMED',           'event_entry', true,  '13B-7', 'Optional proportional Art. 40(11) restoration (D13B-07)'),
  ('corrected_blocked',   'CLAIMED',           'CORRECTED_BLOCKED', 'event_entry', true,  '13B-8', 'Claimed VAT corrected as non-deductible, Cr VAT_ADJ_BLOCKED (D13B-12, M1b)'),
  ('lapsed_written_off',  'HELD',              'LAPSED',            'event_entry', true,  '13B-8', 'Held VAT judged irrecoverable before expiry (ACC-1)'),
  ('lapsed_expired',      'HELD',              'LAPSED',            'event_entry', true,  '13B-8', 'Deduction window expired with VAT held (D13B-01, ACC-1); posted ONLY on the real expiry date (A-7 / G2)'),
  ('exception_recorded',  'NONE',              'NONE',              NULL,          true,  '13B-6', 'Annotation: Art. 40(10) financing-contract exception'),
  ('exception_withdrawn', 'NONE',              'NONE',              NULL,          true,  '13B-6', 'Annotation: the exception withdrawn'),
  ('supply_date_changed', 'NONE',              'NONE',              NULL,          false, '13B-5', 'NOT ADMITTED: the supply-date column is built in 13B-5 (AD-5)'),
  ('reduced_by_note',     'CLAIMED',           'NONE',              'own_entry',   false, '—',     'NOT ADMITTED: no Phase 13B credit-note integration (A-3 / G3 / B-1)'),
  ('reduced_by_note',     'HELD',              'NONE',              'own_entry',   false, '—',     'NOT ADMITTED: no Phase 13B credit-note integration (A-3 / G3 / B-1)'),
  ('reduced_by_note',     'BLOCKED',           'NONE',              'own_entry',   false, '—',     'NOT ADMITTED: no Phase 13B credit-note integration (A-3 / G3 / B-1)'),
  ('increased_by_note',   'NONE',              'CLAIMED',           'own_entry',   false, '—',     'NOT ADMITTED: no Phase 13B credit-note integration (A-3 / G3 / B-1)'),
  ('increased_by_note',   'NONE',              'HELD',              'own_entry',   false, '—',     'NOT ADMITTED: no Phase 13B credit-note integration (A-3 / G3 / B-1)'),
  ('increased_by_note',   'NONE',              'BLOCKED',           'own_entry',   false, '—',     'NOT ADMITTED: no Phase 13B credit-note integration (A-3 / G3 / B-1)'),
  ('correction_withdrawn','CORRECTED_BLOCKED', 'CLAIMED',           'event_entry', false, '13D',   'NOT ADMITTED: disabled until its return treatment is decided in 13D (AD-11 / A-11)');--> statement-breakpoint

-- ── 4. Is this entry owned by a bill, a supplier note or the VAT ledger? ───
-- ONE definition (architecture §19 rules 1–3), read by the service's refusal
-- AND by both guards below — never restated in TypeScript:
--   'input_vat_event' — an input-VAT event references it;
--   'bill_vat_claim'  — a bill's evidence-claim entry (bills.input_vat_claim_entry_id, VATEV-);
--   'bill' / 'supplier_note' — a POSTED bill's or supplier note's own entry,
--      BILL-<n> / BILLCN-<n> in the same company (exact: both numbers are
--      unique per company; a payment's BILL-<n>-PAY-<id> never names a bill).
-- Opening (Batch 1C) entries never match: no bill's own entry carries an
-- opening source and no event may reference one (§7), so a committed
-- migration still reverses.
--
-- input_vat_journal_owner() runs as the CALLER, under RLS — the service may
-- call it, and it cannot be used to probe another tenant's entries.
-- input_vat_journal_protected() is the guards' SECURITY DEFINER wrapper, so a
-- caller whose tenant settings hide a row cannot make a guard see nothing;
-- EXECUTE on it is revoked from PUBLIC.
CREATE OR REPLACE FUNCTION input_vat_journal_owner(p_entry_id integer) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM input_vat_events v WHERE v.journal_entry_id = p_entry_id) THEN 'input_vat_event'
    WHEN EXISTS (SELECT 1 FROM bills b WHERE b.input_vat_claim_entry_id = p_entry_id) THEN 'bill_vat_claim'
    ELSE (SELECT CASE WHEN e.entry_number LIKE 'BILLCN-%' THEN 'supplier_note' ELSE 'bill' END
            FROM journal_entries e
            JOIN bills b ON b.company_id = e.company_id
                        AND b.bill_number = CASE WHEN e.entry_number LIKE 'BILLCN-%' THEN substr(e.entry_number, 8)
                                                 WHEN e.entry_number LIKE 'BILL-%'   THEN substr(e.entry_number, 6) END
           WHERE e.id = p_entry_id
             AND b.status NOT IN ('draft', 'submitted')
           LIMIT 1)
  END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_journal_owner(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION input_vat_journal_owner(integer) TO authenticated;--> statement-breakpoint
CREATE OR REPLACE FUNCTION input_vat_journal_protected(p_entry_id integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT input_vat_journal_owner(p_entry_id) IS NOT NULL
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION input_vat_journal_protected(integer) FROM PUBLIC;--> statement-breakpoint

-- ── 5. 🔴 Events are immutable — for EVERY role, the owner included. ───────
CREATE OR REPLACE FUNCTION input_vat_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'input VAT events are append-only: % is refused; a wrong event is answered by a new one', TG_OP
    USING ERRCODE = '23514', CONSTRAINT = 'input_vat_events_append_only';
END $$;--> statement-breakpoint
CREATE TRIGGER input_vat_events_immutable BEFORE UPDATE OR DELETE ON "input_vat_events"
  FOR EACH ROW EXECUTE FUNCTION input_vat_events_immutable();--> statement-breakpoint
CREATE TRIGGER input_vat_events_no_truncate BEFORE TRUNCATE ON "input_vat_events"
  FOR EACH STATEMENT EXECUTE FUNCTION input_vat_events_immutable();--> statement-breakpoint

-- ── 6. 🔴 Admission: transition, tenancy, dates, buckets — before the row lands. ─
CREATE OR REPLACE FUNCTION input_vat_events_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t   input_vat_event_transitions%ROWTYPE;
  d   record;
  x   record;
  bal input_vat_balances%ROWTYPE;
  amt numeric(15, 2) := coalesce(NEW.amount, 0);
  window_end text;
BEGIN
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
  SELECT id, organization_id, company_id, status, date INTO d FROM bills WHERE id = NEW.document_id;
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
  IF EXISTS (SELECT 1 FROM input_vat_events WHERE organization_id = NEW.organization_id AND idempotency_key = NEW.idempotency_key) THEN
    RETURN NEW;
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
CREATE TRIGGER input_vat_events_admit BEFORE INSERT ON "input_vat_events"
  FOR EACH ROW EXECUTE FUNCTION input_vat_events_admit();--> statement-breakpoint

-- Applied AFTER the row lands, so an INSERT … ON CONFLICT DO NOTHING that
-- skips a duplicate key moves no balance.
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
         last_event_id     = NEW.id,
         updated_at        = now()
   WHERE document_id = NEW.document_id;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER input_vat_events_apply AFTER INSERT ON "input_vat_events"
  FOR EACH ROW EXECUTE FUNCTION input_vat_events_apply();--> statement-breakpoint

-- 🔴 ONE event per document per statement. Row AFTER triggers fire at the END
-- of the statement, so a second row for the same document would be admitted
-- against the balance before the first was applied — a lost update, silently.
-- Refused instead: a writer records one event per statement per document.
CREATE OR REPLACE FUNCTION input_vat_events_one_per_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM new_rows GROUP BY document_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'input VAT events: one statement may record at most ONE event per document'
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_events_one_per_statement';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER input_vat_events_one_per_statement AFTER INSERT ON "input_vat_events"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION input_vat_events_one_per_document();--> statement-breakpoint

-- ── 7. 🔴 Journal linkage, checked at COMMIT (the writer posts the entry first). ─
CREATE OR REPLACE FUNCTION input_vat_events_journal_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  e record;
  d record;
  acct_dr numeric;
  acct_cr numeric;
  code text;
  side text;
  vat_input_cr numeric;
BEGIN
  IF NEW.journal_entry_id IS NULL THEN RETURN NULL; END IF;
  SELECT id, company_id, status, date, source, entry_number INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
  SELECT bill_number, vat_amount, input_vat_claim_entry_id INTO d FROM bills WHERE id = NEW.document_id;
  IF e.company_id IS DISTINCT FROM NEW.company_id OR e.status IS DISTINCT FROM 'posted' OR e.date IS DISTINCT FROM NEW.posting_date THEN
    RAISE EXCEPTION 'input VAT event %: its entry % must be a POSTED entry of the same company dated % (it is %, dated %)',
      NEW.id, NEW.journal_entry_id, NEW.posting_date, e.status, e.date
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_link';
  END IF;
  IF e.source IN ('opening', 'opening_reversal', 'opening_correction') THEN
    RAISE EXCEPTION 'input VAT event %: an opening (Batch 1C) entry is never an input VAT event''s entry', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_link';
  END IF;
  IF (NEW.journal_role = 'own_entry'   AND e.entry_number NOT IN ('BILL-' || d.bill_number, 'BILLCN-' || d.bill_number))
  OR (NEW.journal_role = 'claim_entry' AND d.input_vat_claim_entry_id IS DISTINCT FROM e.id)
  OR (NEW.journal_role = 'event_entry' AND e.source IS DISTINCT FROM 'input_vat_event') THEN
    RAISE EXCEPTION 'input VAT event %: entry % (%) is not the % its role names', NEW.id, e.id, e.entry_number, NEW.journal_role
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
            WHEN 'lapsed_expired'      THEN 'VAT_AWAITING_EVIDENCE' END;
  side := CASE WHEN NEW.event_type IN ('recognised_claimed', 'recognised_held', 'claimed', 'restored_on_payment') THEN 'dr' ELSE 'cr' END;
  IF code IS NOT NULL THEN
    SELECT coalesce(sum(l.debit_amount), 0), coalesce(sum(l.credit_amount), 0) INTO acct_dr, acct_cr
      FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
     WHERE l.journal_entry_id = e.id AND c.system_code = code;
    IF (side = 'dr' AND acct_dr <> NEW.amount) OR (side = 'cr' AND acct_cr <> NEW.amount) THEN
      RAISE EXCEPTION 'input VAT event % (%): amount % is not the entry''s % % line (% dr / % cr)',
        NEW.id, NEW.event_type, NEW.amount, code, side, acct_dr, acct_cr
        USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_amount';
    END IF;
  ELSIF NEW.amount IS NOT NULL AND NEW.amount > d.vat_amount THEN
    -- recognised_blocked / advance_deducted: their exact rule belongs to the
    -- 13B-3 writer (Z-AP1 netting, partial-recovery assets); bounded here.
    RAISE EXCEPTION 'input VAT event % (%): amount % exceeds the document''s VAT %', NEW.id, NEW.event_type, NEW.amount, d.vat_amount
      USING ERRCODE = '23514', CONSTRAINT = 'input_vat_event_journal_amount';
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
CREATE CONSTRAINT TRIGGER input_vat_events_journal_link AFTER INSERT ON "input_vat_events"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION input_vat_events_journal_link();--> statement-breakpoint

-- An entry the ledger posted itself is referenced by exactly one event.
CREATE OR REPLACE FUNCTION journal_entries_input_vat_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM input_vat_events WHERE journal_entry_id = NEW.id) <> 1 THEN
    RAISE EXCEPTION 'journal entry % (%) is marked input_vat_event but no single input VAT event references it', NEW.id, NEW.entry_number
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_input_vat_link';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_input_vat_link AFTER INSERT ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source = 'input_vat_event')
  EXECUTE FUNCTION journal_entries_input_vat_link();--> statement-breakpoint

-- ── 8. 🔴 The generic reversal cannot cancel an owned entry (A-5). ──────────
-- The 0101 / 0102 pattern. The service refuses first, in words; this is the
-- boundary no path — service, script or future code — can go around.
CREATE OR REPLACE FUNCTION journal_entries_vat_reversal_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'posted' AND NEW.status = 'reversed' AND input_vat_journal_protected(NEW.id) THEN
    RAISE EXCEPTION 'journal entry % (%) belongs to a bill, a supplier note or an input VAT event; it is corrected through that document, never reversed generically',
      NEW.id, NEW.entry_number
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_vat_reversal_guard';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER journal_entries_vat_reversal_guard BEFORE UPDATE OF status ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION journal_entries_vat_reversal_guard();--> statement-breakpoint

-- ── 9. 🔴 …nor can its LINES be rewritten underneath it. ────────────────────
-- Searched: the only triggers on the journal tables guard status transitions
-- (0101, 0102) and line inserts (0073, 0102) — a posted entry's lines were
-- mutable in the database. Scoped to the entries §4 protects; DELETE is
-- refused only for an event-referenced entry, whose parent row the event's
-- FK (ON DELETE RESTRICT) already holds.
CREATE OR REPLACE FUNCTION journal_entry_lines_vat_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM input_vat_events WHERE journal_entry_id = OLD.journal_entry_id) THEN
      RAISE EXCEPTION 'journal line % belongs to an input VAT event''s entry %; it cannot be deleted', OLD.id, OLD.journal_entry_id
        USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_lines_vat_guard';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW IS DISTINCT FROM OLD AND input_vat_journal_protected(OLD.journal_entry_id) THEN
    RAISE EXCEPTION 'journal line % belongs to entry %, which a bill, a supplier note or an input VAT event owns; its lines cannot be changed',
      OLD.id, OLD.journal_entry_id
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_lines_vat_guard';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER journal_entry_lines_vat_guard BEFORE UPDATE OR DELETE ON "journal_entry_lines"
  FOR EACH ROW EXECUTE FUNCTION journal_entry_lines_vat_guard();--> statement-breakpoint

-- ── 10. Supporting index and a frozen provenance. ──────────────────────────
-- The owner predicate looks a VATEV- entry up by bills.input_vat_claim_entry_id
-- on every generic reversal; without an index that is a scan of bills.
CREATE INDEX "bills_input_vat_claim_entry_idx" ON "bills" USING btree ("input_vat_claim_entry_id") WHERE input_vat_claim_entry_id IS NOT NULL;--> statement-breakpoint
-- An entry's source is stated at INSERT and checked there (§7); changing it to
-- or from 'input_vat_event' afterwards would escape that check.
CREATE OR REPLACE FUNCTION journal_entries_input_vat_source_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source IS DISTINCT FROM NEW.source AND (OLD.source = 'input_vat_event' OR NEW.source = 'input_vat_event') THEN
    RAISE EXCEPTION 'journal entry % (%): the input_vat_event source is fixed when the entry is written', NEW.id, NEW.entry_number
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_input_vat_source_frozen';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER journal_entries_input_vat_source_frozen BEFORE UPDATE OF source ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION journal_entries_input_vat_source_frozen();--> statement-breakpoint

-- ── 11. Tenant isolation and grants (the 0101 block). ──────────────────────
ALTER TABLE "input_vat_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."input_vat_events"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
ALTER TABLE "input_vat_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."input_vat_balances"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "input_vat_events" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "input_vat_events_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "input_vat_balances" TO authenticated;--> statement-breakpoint
GRANT SELECT ON TABLE "input_vat_event_transitions" TO authenticated;--> statement-breakpoint
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.input_vat_events FROM %I', r);
      FOREACH t IN ARRAY ARRAY['input_vat_balances', 'input_vat_event_transitions'] LOOP
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END LOOP;
    END IF;
  END LOOP;
END $$;
