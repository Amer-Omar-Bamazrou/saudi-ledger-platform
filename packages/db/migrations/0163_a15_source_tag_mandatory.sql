-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 A15 (owner decisions 2026-11-16 and 2026-11-17) — EVERY JOURNAL ENTRY NAMES ITS SOURCE.
--
-- T1d (0129) recorded what produced an entry from 2026-10-27 on, and left every
-- older entry's `source_type` NULL ("no back-fill"). The checks that key on the
-- tag (DR-34's owner check, A15's payroll refusal) could not see those entries:
-- the walk reversed a legacy payroll entry through the generic reverse (L1).
-- The owner approved a mandatory tag, a one-time back-fill from AUTHORITATIVE
-- relationships only, and a narrowly scoped exception to the posted-journal
-- freeze for the two tag columns, for this back-fill alone.
--
-- What this migration does, in order:
--   1. Three new tags, none naming a source row: `legacy_unclassified` (an old
--      entry whose source could not be established — never a guess),
--      `demo_seed` and `test_fixture` (synthetic entries). The source-id CHECK
--      requires all three to carry no source id.
--   2. `journal_source_backfill` — the back-fill's own append-only record: one
--      row per changed entry (previous tag, new tag, rule, evidence, this
--      migration's version, the time). Owner-only: no grant to the application.
--   3. `journal_source_classify()` — the rules, as one read-only function (the
--      dry runs read the same text): F a document's own key, N the number its
--      writer composes (checked), S Batch 1C's `source` column, A the manual
--      route's audit row, R `reversal_of`; anything else, two disagreeing, or a
--      failed check is U → `legacy_unclassified`, with the evidence kept.
--      `journal_source_legacy_payment_candidates()` — the owner's CANDIDATE rule
--      for the old `GL-<invoice>-PAY…` entries, EVIDENCE ONLY here: it is never
--      applied by this migration (owner, 2026-11-17: "Do not apply this rule to
--      any existing database yet").
--   4. `journal_entries_source_tag_guard` — who may write which tag: never
--      `legacy_unclassified` on a new row; `demo_seed` / `test_fixture` only
--      while the transaction declares it (`app.journal_synthetic_source`); a tag
--      is first written onto an existing row ONLY by this back-fill, as the
--      table owner, where the back-fill record holds the same change; the three
--      unsourced tags never change, and nothing becomes one.
--   5. The posted-journal freeze (G16, 0126) gains ONE admission: on a posted or
--      reversed entry, `source_type` / `source_id` written from NULL, nothing
--      else changing, while this back-fill runs and its record holds the same
--      change. Every other column stays frozen exactly as 0126 froze it.
--   6. The back-fill itself, its post-check (no NULL left), and NOT NULL.
--
-- Idempotent and re-runnable: every object is created IF NOT EXISTS / OR
-- REPLACE / after DROP … IF EXISTS; the back-fill touches only rows still NULL
-- and records each entry once (unique entry id); on a second run nothing is
-- classified, nothing changes, and NOT NULL is already in place.
--
-- It changes no amount, account, date, description, number, status or line.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Pre-check: what the back-fill will find (counted, never refused). ────
DO $$
DECLARE
  by_status text;
  n integer;
BEGIN
  SELECT coalesce(sum(k), 0)::int, coalesce(string_agg(s || ' ' || k, ', ' ORDER BY s), 'none')
    INTO n, by_status
    FROM (SELECT status AS s, count(*) AS k FROM journal_entries WHERE source_type IS NULL GROUP BY status) x;
  RAISE NOTICE 'A15 pre-check: % journal entr(y/ies) carry no source tag (by status: %)', n, by_status;
END $$;--> statement-breakpoint

-- ── 1. The tags. 🔴 Hand-written (drizzle does not track these CHECKs; the 0071 precedent). ─────────
-- The list is JOURNAL_SOURCE_TYPES (schema/journalEntries.ts); the T1d proof fails if they drift.
ALTER TABLE "journal_entries" DROP CONSTRAINT IF EXISTS "journal_entries_source_type_chk";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_type_chk" CHECK (
  source_type IS NULL OR source_type IN (
    'manual', 'recurring', 'reversal',
    'invoice', 'invoice_correction', 'invoice_write_off', 'credit_note_application',
    'customer_payment', 'customer_payment_allocation', 'customer_allocation_correction', 'customer_refund', 'customer_payment_reclassification',
    'bill', 'bill_payment', 'vat_evidence',
    'supplier_payment', 'supplier_advance_allocation', 'supplier_allocation_reversal', 'supplier_payment_reclassification', 'supplier_refund',
    'bank_transfer', 'bank_transaction',
    'payroll_run', 'payroll_net_pay', 'payroll_gosi_payment',
    'depreciation', 'asset_disposal', 'recognition',
    'tax_computation', 'wht_remittance', 'wht_remittance_reversal',
    'migration_opening', 'migration_reversal', 'opening_correction',
    'vat_return_filing',
    'legacy_unclassified', 'demo_seed', 'test_fixture'
  )
);--> statement-breakpoint
-- A manual entry IS its document; a recurring rule's id is a uuid; the three unsourced tags name no row. Every other
-- source names its row by a positive id (0149).
ALTER TABLE "journal_entries" DROP CONSTRAINT IF EXISTS "journal_entries_source_id_chk";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_id_chk" CHECK (
  (source_type IS NULL AND source_id IS NULL)
  OR (source_type IN ('manual', 'recurring', 'legacy_unclassified', 'demo_seed', 'test_fixture') AND source_id IS NULL)
  OR (source_type NOT IN ('manual', 'recurring', 'legacy_unclassified', 'demo_seed', 'test_fixture') AND source_id IS NOT NULL AND source_id > 0)
);--> statement-breakpoint

-- ── 2. The back-fill's own record (schema/journalSourceBackfill.ts). ─────────
CREATE TABLE IF NOT EXISTS "journal_source_backfill" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"journal_entry_id" integer NOT NULL,
	"entry_number" text NOT NULL,
	"entry_status" text NOT NULL,
	"previous_source_type" text,
	"previous_source_id" integer,
	"new_source_type" text NOT NULL,
	"new_source_id" integer,
	"rule" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"migration_version" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_source_backfill_entry_unq" UNIQUE("journal_entry_id"),
	CONSTRAINT "journal_source_backfill_rule_chk" CHECK ("journal_source_backfill"."rule" in ('F', 'N', 'S', 'A', 'R', 'U')),
	CONSTRAINT "journal_source_backfill_previous_chk" CHECK ("journal_source_backfill"."previous_source_type" is null and "journal_source_backfill"."previous_source_id" is null),
	CONSTRAINT "journal_source_backfill_unclassified_chk" CHECK (("journal_source_backfill"."rule" = 'U') = ("journal_source_backfill"."new_source_type" = 'legacy_unclassified')),
	CONSTRAINT "journal_source_backfill_not_synthetic_chk" CHECK ("journal_source_backfill"."new_source_type" not in ('demo_seed', 'test_fixture'))
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_source_backfill_organization_id_organizations_id_fk') THEN
    ALTER TABLE "journal_source_backfill" ADD CONSTRAINT "journal_source_backfill_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_source_backfill_company_id_companies_id_fk') THEN
    ALTER TABLE "journal_source_backfill" ADD CONSTRAINT "journal_source_backfill_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_source_backfill_company_idx" ON "journal_source_backfill" USING btree ("company_id","recorded_at");--> statement-breakpoint
-- Tenancy (the 0154 pattern): RLS and the tenant policy, for the day something reads it as the application.
ALTER TABLE public.journal_source_backfill ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON public.journal_source_backfill;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.journal_source_backfill
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
-- 🔴 OWNER-ONLY: written by the back-fill alone; the application's role holds NOTHING on it (no reader is built yet —
-- the review screen, when built, is granted SELECT in its own change). Supabase's default privileges grant every new
-- table to these roles, TRUNCATE included, so each is revoked explicitly (CLAUDE.md §4).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.journal_source_backfill FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.journal_source_backfill_id_seq FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.journal_source_backfill FROM PUBLIC;
END $$;--> statement-breakpoint
-- APPEND-ONLY for every role, the owner included, while its company exists (the control_flags pattern, 0154).
CREATE OR REPLACE FUNCTION journal_source_backfill_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- the company (or the organisation) itself is being removed: its records go with it, by the cascade — never alone
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
       OR NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% on journal_source_backfill: the back-fill''s record is append-only for every role; nothing in it is changed or removed while its company exists', TG_OP
    USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_source_backfill_append_only';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS zz_journal_source_backfill_append_only ON "journal_source_backfill";--> statement-breakpoint
CREATE TRIGGER zz_journal_source_backfill_append_only BEFORE UPDATE OR DELETE ON "journal_source_backfill" FOR EACH ROW EXECUTE FUNCTION journal_source_backfill_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS zz_journal_source_backfill_no_truncate ON "journal_source_backfill";--> statement-breakpoint
CREATE TRIGGER zz_journal_source_backfill_no_truncate BEFORE TRUNCATE ON "journal_source_backfill" FOR EACH STATEMENT EXECUTE FUNCTION journal_source_backfill_append_only();--> statement-breakpoint

-- ── 3a. THE RULES — one read-only function. ─────────────────────────────────
-- With no argument: every entry whose tag is NULL (what the back-fill writes). With ids: those entries AS IF untagged
-- (how the tests hold the rules against entries the product's own writers tagged). One row per entry; `candidates`
-- lists every relationship found, so an ambiguous entry carries its evidence.
-- Rule F's pairs are each writer's own (table, key) → (tag, the id the writer stamps), read from the writers on main
-- 96cab09b. Pointers that ANNOTATE an entry rather than own it (journal lines, bank attributions, WHT withholdings,
-- input-VAT events, asset events, capitalisation and opening pointers, transfer and deposit reversals, WHT
-- corrections) never classify; nor does payment_allocations.journal_entry_id (two writers stamp two tags on it).
CREATE OR REPLACE FUNCTION journal_source_classify(p_entry_ids integer[] DEFAULT NULL)
RETURNS TABLE (entry_id integer, organization_id uuid, company_id uuid, entry_number text, entry_status text,
               new_source_type text, new_source_id integer, rule text, evidence jsonb)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $cls$
WITH u AS (
  SELECT j.id, j.organization_id AS org, j.company_id AS co, j.entry_number AS num, j.date::text AS dt, j.status,
         j.reversal_of, j.source, j.migration_batch_id,
         (SELECT round(coalesce(sum(l.debit_amount), 0)::numeric, 2) FROM journal_entry_lines l WHERE l.journal_entry_id = j.id) AS total,
         NOT EXISTS (SELECT 1 FROM journal_entries d WHERE d.company_id = j.company_id AND d.entry_number = j.entry_number AND d.id <> j.id) AS number_unique
    FROM journal_entries j
   WHERE (p_entry_ids IS NULL AND j.source_type IS NULL) OR j.id = ANY (p_entry_ids)
),
-- F: (entry, tag, the id its writer stamps, where it was found, the document's organisation and company)
f(eid, t, sid, via, org, co) AS (
            SELECT journal_entry_id, 'customer_payment', id, 'payments.journal_entry_id', organization_id, company_id FROM payments WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'bill_payment', id, 'bill_payments.journal_entry_id', organization_id, company_id FROM bill_payments WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'supplier_payment', id, 'supplier_payments.journal_entry_id', organization_id, company_id FROM supplier_payments WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'customer_refund', id, 'customer_refunds.journal_entry_id', organization_id, company_id FROM customer_refunds WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'supplier_refund', supplier_payment_id, 'supplier_refunds.journal_entry_id', organization_id, company_id FROM supplier_refunds WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'bank_transaction', id, 'transactions.journal_entry_id', organization_id, company_id FROM transactions WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'bank_transfer', id, 'bank_transfers.journal_entry_id', organization_id, company_id FROM bank_transfers WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'depreciation', asset_id, 'asset_depreciation_schedule.journal_entry_id', organization_id, company_id FROM asset_depreciation_schedule WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'asset_disposal', asset_id, 'asset_disposals.journal_entry_id', organization_id, company_id FROM asset_disposals WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'recognition', schedule_id, 'recognition_schedule_rows.journal_entry_id', organization_id, company_id FROM recognition_schedule_rows WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT accrual_journal_entry_id, 'tax_computation', id, 'tax_computation_versions.accrual_journal_entry_id', organization_id, company_id FROM tax_computation_versions WHERE accrual_journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'wht_remittance', id, 'wht_remittances.journal_entry_id', organization_id, company_id FROM wht_remittances WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'wht_remittance_reversal', remittance_id, 'wht_remittance_reversals.journal_entry_id', organization_id, company_id FROM wht_remittance_reversals WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT opening_journal_entry_id, 'migration_opening', id, 'migration_batches.opening_journal_entry_id', organization_id, company_id FROM migration_batches WHERE opening_journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT reversal_journal_entry_id, 'migration_reversal', id, 'migration_batches.reversal_journal_entry_id', organization_id, company_id FROM migration_batches WHERE reversal_journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT opening_correction_journal_entry_id, 'opening_correction', migration_open_item_id, 'invoices.opening_correction_journal_entry_id', organization_id, company_id FROM invoices WHERE opening_correction_journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT opening_correction_journal_entry_id, 'opening_correction', migration_open_item_id, 'bills.opening_correction_journal_entry_id', organization_id, company_id FROM bills WHERE opening_correction_journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT bad_debt_relief_journal_entry_id, 'invoice_write_off', id, 'invoices.bad_debt_relief_journal_entry_id', organization_id, company_id FROM invoices WHERE bad_debt_relief_journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'customer_allocation_correction', allocation_id, 'payment_allocation_reversals.journal_entry_id', organization_id, company_id FROM payment_allocation_reversals WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'supplier_advance_allocation', supplier_payment_id, 'supplier_payment_allocations.journal_entry_id', organization_id, company_id FROM supplier_payment_allocations WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'supplier_allocation_reversal', allocation_id, 'supplier_payment_allocation_reversals.journal_entry_id', organization_id, company_id FROM supplier_payment_allocation_reversals WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'customer_payment_reclassification', payment_id, 'payment_classifications.journal_entry_id', organization_id, company_id FROM payment_classifications WHERE journal_entry_id IN (SELECT id FROM u)
  UNION ALL SELECT journal_entry_id, 'supplier_payment_reclassification', supplier_payment_id, 'supplier_payment_classifications.journal_entry_id', organization_id, company_id FROM supplier_payment_classifications WHERE journal_entry_id IN (SELECT id FROM u)
),
-- A recurring rule's journal draft: its run names the entry (`recurring` names no source row — the run log links them)
rr(eid, run_id, rule_id, org, co) AS (
  SELECT r.document_id, r.id, ru.id, ru.organization_id, ru.company_id
    FROM recurring_runs r JOIN recurring_rules ru ON ru.id = r.rule_id
   WHERE ru.entity = 'journal_entry' AND r.document_id IN (SELECT id FROM u)
),
c(eid, t, sid, rl, rank, ev, ok) AS (
  -- F
  SELECT f.eid, f.t, f.sid, 'F', 1,
         jsonb_build_object('via', f.via, 'row', f.sid, 'same_organization_and_company', f.org = u.org AND f.co = u.co),
         f.org = u.org AND f.co = u.co AND f.sid IS NOT NULL
    FROM f JOIN u ON u.id = f.eid
  UNION ALL
  -- F: a recurring rule's run names the entry
  SELECT rr.eid, 'recurring', NULL::integer, 'F', 1,
         jsonb_build_object('via', 'recurring_runs.document_id', 'run', rr.run_id, 'rule', rr.rule_id, 'same_organization_and_company', rr.org = u.org AND rr.co = u.co),
         rr.org = u.org AND rr.co = u.co
    FROM rr JOIN u ON u.id = rr.eid
  UNION ALL
  -- N: an invoice's own entry, GL-<invoice number> (not a receipt's -RCPT-n or an application's -APP-n)
  SELECT u.id, 'invoice', i.id, 'N', 2,
         jsonb_build_object('via', 'GL-<invoice_number>', 'invoice', i.id, 'document_type', i.document_type, 'document_status', i.status,
                            'number_unique', u.number_unique, 'date_agrees', i.date = u.dt, 'total_agrees', round(i.total::numeric, 2) = u.total,
                            'issued', i.status NOT IN ('draft', 'submitted', 'rejected')),
         u.number_unique AND i.date = u.dt AND round(i.total::numeric, 2) = u.total AND i.status NOT IN ('draft', 'submitted', 'rejected')
    FROM u JOIN invoices i ON i.organization_id = u.org AND i.company_id = u.co AND u.num = 'GL-' || i.invoice_number
   WHERE u.num !~ '-(RCPT|APP)-[0-9]+$'
  UNION ALL
  -- N: a bill's own entry, BILL-<bill number> or BILLCN-<bill number> (not a payment's -PAY-n)
  SELECT u.id, 'bill', b.id, 'N', 2,
         jsonb_build_object('via', split_part(u.num, '-', 1) || '-<bill_number>', 'bill', b.id, 'document_status', b.status,
                            'number_unique', u.number_unique, 'date_agrees', b.date = u.dt, 'total_agrees', round(b.total::numeric, 2) = u.total,
                            'issued', b.status NOT IN ('draft', 'submitted', 'rejected')),
         u.number_unique AND b.date = u.dt AND round(b.total::numeric, 2) = u.total AND b.status NOT IN ('draft', 'submitted', 'rejected')
    FROM u JOIN bills b ON b.organization_id = u.org AND b.company_id = u.co AND u.num IN ('BILL-' || b.bill_number, 'BILLCN-' || b.bill_number)
   WHERE u.num !~ '-PAY-[0-9]+$'
  UNION ALL
  -- N: a payroll run's entries, PAY-<period>-R<run>[-NET|-GOSI]
  SELECT u.id,
         CASE m[3] WHEN '-NET' THEN 'payroll_net_pay' WHEN '-GOSI' THEN 'payroll_gosi_payment' ELSE 'payroll_run' END,
         r.id, 'N', 2,
         jsonb_build_object('via', 'PAY-<period>-R<run>' || coalesce(m[3], ''), 'payroll_run', r.id, 'run_period', r.period, 'run_status', r.status,
                            'number_unique', u.number_unique, 'period_agrees', r.period = m[1], 'issued', r.status NOT IN ('draft', 'submitted', 'rejected')),
         u.number_unique AND r.period = m[1] AND r.status NOT IN ('draft', 'submitted', 'rejected')
    FROM u CROSS JOIN LATERAL regexp_match(u.num, '^PAY-([0-9]{4}-[0-9]{2})-R([0-9]+)(-NET|-GOSI)?$') m
    JOIN payroll_runs r ON r.organization_id = u.org AND r.company_id = u.co AND r.id = m[2]::bigint
  UNION ALL
  -- S: Batch 1C's `source` column, written only by the migration service; the batch is the entry's own migration_batch_id
  SELECT u.id,
         CASE u.source WHEN 'opening' THEN 'migration_opening' WHEN 'opening_reversal' THEN 'migration_reversal' ELSE 'opening_correction' END,
         CASE WHEN u.source IN ('opening', 'opening_reversal') THEN u.migration_batch_id END, 'S', 3,
         jsonb_build_object('via', 'journal_entries.source', 'source', u.source, 'migration_batch', u.migration_batch_id),
         true
    FROM u WHERE u.source IN ('opening', 'opening_reversal', 'opening_correction')
  UNION ALL
  -- A: the manual route's own audit row for the entry's creation, in the entry's organisation. 🔴 Not a mirror (the
  -- generic reverse records its mirror's creation the same way) and not a recurring rule's draft (its run names it):
  -- caught by the rules' own test, where a mirror read as `manual` before this exclusion.
  SELECT DISTINCT u.id, 'manual', NULL::integer, 'A', 4,
         jsonb_build_object('via', 'audit_logs', 'entity_type', a.entity_type, 'action', a.action),
         true
    FROM u JOIN audit_logs a ON a.organization_id = u.org AND a.entity_type IN ('journal_entry', 'journal_entries')
                             AND a.entity_id = u.id::text AND a.action IN ('create', 'created', 'POST')
   WHERE u.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM rr WHERE rr.eid = u.id)
),
-- R: reversal_of, only where nothing else claimed the entry
cr AS (
  SELECT * FROM c
  UNION ALL
  SELECT u.id, 'reversal', u.reversal_of, 'R', 5, jsonb_build_object('via', 'journal_entries.reversal_of', 'reversal_of', u.reversal_of), true
    FROM u WHERE u.reversal_of IS NOT NULL AND NOT EXISTS (SELECT 1 FROM c WHERE c.eid = u.id)
),
agg AS (
  SELECT u.id,
         count(cr.eid) AS n,
         count(DISTINCT cr.t) AS ntypes,
         count(DISTINCT cr.sid) AS nsids,
         min(cr.t) AS t,
         min(cr.sid) AS sid,
         coalesce(bool_and(cr.ok), true) AS all_ok,
         (array_agg(cr.rl ORDER BY cr.rank))[1] AS first_rule,
         coalesce(jsonb_agg(jsonb_build_object('rule', cr.rl, 'type', cr.t, 'source_id', cr.sid, 'checks_pass', cr.ok, 'evidence', cr.ev)
                            ORDER BY cr.rank, cr.t, cr.sid) FILTER (WHERE cr.eid IS NOT NULL), '[]'::jsonb) AS candidates
    FROM u LEFT JOIN cr ON cr.eid = u.id
   GROUP BY u.id
)
SELECT u.id AS entry_id, u.org AS organization_id, u.co AS company_id, u.num AS entry_number, u.status AS entry_status,
       CASE WHEN d.ok THEN agg.t ELSE 'legacy_unclassified' END AS new_source_type,
       CASE WHEN d.ok THEN agg.sid END AS new_source_id,
       CASE WHEN d.ok THEN agg.first_rule ELSE 'U' END AS rule,
       jsonb_build_object(
         'outcome', CASE WHEN d.ok THEN 'classified' WHEN agg.n = 0 THEN 'no_authoritative_relationship' ELSE 'ambiguous' END,
         'candidates', agg.candidates) AS evidence
  FROM u JOIN agg ON agg.id = u.id
  CROSS JOIN LATERAL (SELECT
    agg.n > 0 AND agg.ntypes = 1 AND agg.all_ok
    AND CASE WHEN agg.t IN ('manual', 'recurring') THEN agg.nsids = 0 ELSE agg.nsids = 1 END AS ok) d
$cls$;--> statement-breakpoint
REVOKE ALL ON FUNCTION journal_source_classify(integer[]) FROM PUBLIC;--> statement-breakpoint

-- ── 3b. THE OWNER'S CANDIDATE RULE for the old `GL-<invoice>-PAY…` entries — EVIDENCE ONLY, never applied here. ──
-- Owner, 2026-11-17: `customer_payment` only where the entry maps to an actual customer-payment record, uniquely; the
-- record exists; the entry is uniquely identified; its date and amount agree with the PAYMENT (never the invoice's
-- total); and no conflicting relationship exists. `customer_payment` names a `payments` row (T1d), so only a
-- `payments` row can qualify. The pre-D-4 writer recorded these payments in `invoice_payments` (B4), which D-4 never
-- carried into `payments`: such a record is reported (`b4_record_only`), never used as a `payments` id.
-- A `payments` row always names its own entry (journal_entry_id NOT NULL since D-4): one naming THIS entry is rule F's
-- already; one with the same invoice, amount and date naming ANOTHER entry is a CONFLICT (the receipt may stand twice
-- in the ledger) — reported, never resolved here. `qualifies` therefore needs a `payments` row naming no entry, which the
-- schema at 0163 cannot hold; the branch is kept so the rule is the owner's as stated, on any schema it meets.
-- Formats: `GL-<inv>-PAY-<n>` (n = the B4 row's id, N3, 2026-09); `GL-<inv>-PAY` (before N3) and `GL-<inv>-PAY-D<id>`
-- (0066's rename of a duplicate) carry no payment id, so their B4 record is found by invoice, amount and date.
CREATE OR REPLACE FUNCTION journal_source_legacy_payment_candidates(p_entry_ids integer[] DEFAULT NULL)
RETURNS TABLE (entry_id integer, verdict text, payment_id integer, b4_payment_id integer, evidence jsonb)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $cand$
WITH fmt AS (
  -- every old-format entry in the database (whether a record is claimed twice is judged against all of them)
  SELECT j.id, j.organization_id AS org, j.company_id AS co, j.entry_number AS num, j.date::text AS dt, j.source_type,
         m[1] AS invoice_number, coalesce(m[2] = 'D', false) AS renamed, CASE WHEN m[2] = '' THEN m[3]::bigint END AS b4_id,
         (SELECT round(coalesce(sum(l.debit_amount), 0)::numeric, 2) FROM journal_entry_lines l WHERE l.journal_entry_id = j.id) AS total,
         NOT EXISTS (SELECT 1 FROM journal_entries d WHERE d.company_id = j.company_id AND d.entry_number = j.entry_number AND d.id <> j.id) AS number_unique
    FROM journal_entries j CROSS JOIN LATERAL regexp_match(j.entry_number, '^GL-(.+?)-PAY(?:-(D?)([0-9]+))?$') m
   -- 🔴 regexp_match returns NULL, not no row, for a number of another shape: without this every entry was a candidate
   -- (caught by the sl_e2e dry run, 2026-11-17)
   WHERE m IS NOT NULL
),
cu AS (SELECT * FROM fmt WHERE (p_entry_ids IS NULL AND source_type IS NULL) OR id = ANY (p_entry_ids)),
-- the rules' own verdict on each candidate, read ONCE (a dry run inlines this same text)
cl AS (SELECT * FROM journal_source_classify(ARRAY(SELECT id FROM cu))),
inv AS (
  SELECT cu.id AS eid, i.id AS invoice_id, i.status NOT IN ('draft', 'submitted', 'rejected') AS issued
    FROM cu JOIN invoices i ON i.organization_id = cu.org AND i.company_id = cu.co AND i.invoice_number = cu.invoice_number
),
-- a `payments` record of a customer receipt for THIS invoice: same organisation and company, allocated to the
-- invoice, incoming, from a customer, its amount and date equal to the entry's
pm AS (
  SELECT DISTINCT f.id AS eid, p.id AS payment_id, p.journal_entry_id AS p_je
    FROM fmt f
    JOIN invoices i ON i.organization_id = f.org AND i.company_id = f.co AND i.invoice_number = f.invoice_number
    JOIN payment_allocations a ON a.invoice_id = i.id AND a.organization_id = f.org AND a.company_id = f.co
    JOIN payments p ON p.id = a.payment_id AND p.organization_id = f.org AND p.company_id = f.co
   WHERE p.direction = 'in' AND p.party_type = 'customer'
     AND round(p.amount::numeric, 2) = f.total AND p.paid_at::text = f.dt
),
-- the B4 record: by its id where the number carries it, else by invoice, amount and date
b4 AS (
  SELECT DISTINCT f.id AS eid, ip.id AS b4_id, ip.backfilled,
         round(ip.amount::numeric, 2) = f.total AS amount_agrees, ip.paid_at::text = f.dt AS date_agrees
    FROM fmt f
    JOIN invoices i ON i.organization_id = f.org AND i.company_id = f.co AND i.invoice_number = f.invoice_number
    JOIN invoice_payments ip ON ip.invoice_id = i.id AND ip.organization_id = f.org AND ip.company_id = f.co
   WHERE (f.b4_id IS NOT NULL AND ip.id = f.b4_id)
      OR (f.b4_id IS NULL AND round(ip.amount::numeric, 2) = f.total AND ip.paid_at::text = f.dt)
),
x AS (
  SELECT cu.id,
         (SELECT count(*) FROM inv WHERE inv.eid = cu.id) AS n_inv,
         (SELECT min(invoice_id) FROM inv WHERE inv.eid = cu.id) AS invoice_id,
         coalesce((SELECT bool_and(issued) FROM inv WHERE inv.eid = cu.id), false) AS invoice_issued,
         cu.number_unique,
         (SELECT jsonb_agg(cl.evidence -> 'candidates') FROM cl WHERE cl.entry_id = cu.id AND cl.evidence -> 'candidates' <> '[]'::jsonb) AS other_rel,
         (SELECT array_agg(pm.payment_id ORDER BY pm.payment_id) FROM pm WHERE pm.eid = cu.id AND pm.p_je IS NULL) AS free_payments,
         (SELECT array_agg(pm.payment_id ORDER BY pm.payment_id) FROM pm WHERE pm.eid = cu.id AND pm.p_je IS NOT NULL AND pm.p_je <> cu.id) AS taken_payments,
         (SELECT count(DISTINCT pm2.eid) FROM pm pm1 JOIN pm pm2 ON pm2.payment_id = pm1.payment_id WHERE pm1.eid = cu.id AND pm1.p_je IS NULL) AS claimants,
         (SELECT array_agg(b4.b4_id ORDER BY b4.b4_id) FROM b4 WHERE b4.eid = cu.id AND NOT b4.backfilled AND b4.amount_agrees AND b4.date_agrees) AS b4_ok,
         (SELECT array_agg(b4.b4_id ORDER BY b4.b4_id) FROM b4 WHERE b4.eid = cu.id AND (b4.backfilled OR NOT b4.amount_agrees OR NOT b4.date_agrees)) AS b4_bad,
         (SELECT count(DISTINCT b2.eid) FROM b4 b1 JOIN b4 b2 ON b2.b4_id = b1.b4_id WHERE b1.eid = cu.id AND NOT b1.backfilled AND b1.amount_agrees AND b1.date_agrees) AS b4_claimants,
         cu.renamed, cu.b4_id AS number_b4_id
    FROM cu
)
SELECT x.id AS entry_id,
       v.verdict AS verdict,
       CASE WHEN v.verdict = 'qualifies' THEN x.free_payments[1] END AS payment_id,
       CASE WHEN v.verdict = 'b4_record_only' THEN x.b4_ok[1] END AS b4_payment_id,
       jsonb_build_object('rule', 'P (candidate; not applied)', 'verdict', v.verdict, 'invoice', x.invoice_id, 'number_unique', x.number_unique,
                          'number_names_b4_payment', x.number_b4_id, 'renamed_duplicate', x.renamed,
                          'payments_matching', coalesce(to_jsonb(x.free_payments), '[]'::jsonb), 'payments_already_another_entrys', coalesce(to_jsonb(x.taken_payments), '[]'::jsonb),
                          'b4_records_agreeing', coalesce(to_jsonb(x.b4_ok), '[]'::jsonb), 'b4_records_disagreeing_or_aggregate', coalesce(to_jsonb(x.b4_bad), '[]'::jsonb),
                          'other_relationships', coalesce(x.other_rel, '[]'::jsonb)) AS evidence
  FROM x CROSS JOIN LATERAL (SELECT CASE
    WHEN x.n_inv = 0 THEN 'no_invoice'
    WHEN x.n_inv > 1 THEN 'ambiguous'
    WHEN NOT x.invoice_issued THEN 'invoice_not_issued'
    WHEN NOT x.number_unique THEN 'number_not_unique'
    WHEN x.other_rel IS NOT NULL OR coalesce(cardinality(x.taken_payments), 0) > 0 THEN 'conflict'
    WHEN coalesce(cardinality(x.free_payments), 0) = 1 AND x.claimants = 1 THEN 'qualifies'
    WHEN coalesce(cardinality(x.free_payments), 0) > 1 OR x.claimants > 1 THEN 'ambiguous'
    WHEN coalesce(cardinality(x.b4_ok), 0) = 1 AND x.b4_claimants = 1 THEN 'b4_record_only'
    WHEN coalesce(cardinality(x.b4_ok), 0) > 1 OR x.b4_claimants > 1 THEN 'ambiguous'
    ELSE 'no_match' END AS verdict) v
$cand$;--> statement-breakpoint
REVOKE ALL ON FUNCTION journal_source_legacy_payment_candidates(integer[]) FROM PUBLIC;--> statement-breakpoint

-- ── 4. Who may write which tag. An ordinary trigger (the replica-mode bypass is the only one, as for G16). ──
CREATE OR REPLACE FUNCTION journal_entries_source_tag_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  synthetic text := nullif(current_setting('app.journal_synthetic_source', true), '');
  backfill text := nullif(current_setting('app.journal_source_backfill', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_type = 'legacy_unclassified' THEN
      RAISE EXCEPTION 'journal entry % cannot be written as legacy_unclassified: that tag records an entry from before T1d whose source the A15 back-fill could not establish; a new entry names its own source', NEW.entry_number
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_source_unclassified_refused';
    END IF;
    IF NEW.source_type IN ('demo_seed', 'test_fixture') AND synthetic IS DISTINCT FROM NEW.source_type THEN
      RAISE EXCEPTION 'journal entry % cannot be written as %: a synthetic entry is written only by the demo seed or a test fixture, which declare it first', NEW.entry_number, NEW.source_type
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_source_synthetic_refused';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE OF source_type, source_id
  IF NEW.source_type IS NOT DISTINCT FROM OLD.source_type AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id THEN
    RETURN NEW;
  END IF;
  IF OLD.source_type IS NULL THEN
    -- 🔴 The ONE way a tag is first written onto an existing entry: the A15 back-fill, as the table's owner, where its
    -- own record holds this exact change. (Nested, so the record is read only by a role that may read it.)
    IF backfill IS NOT NULL AND NEW.source_type IS NOT NULL AND NEW.source_type NOT IN ('demo_seed', 'test_fixture')
       AND pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
      IF EXISTS (SELECT 1 FROM journal_source_backfill b
                  WHERE b.journal_entry_id = NEW.id AND b.migration_version = backfill
                    AND b.new_source_type = NEW.source_type AND b.new_source_id IS NOT DISTINCT FROM NEW.source_id) THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'journal entry % (%) has no source tag: one is written onto an existing entry only by the A15 back-fill, which records each change first', NEW.id, NEW.entry_number
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_source_backfill_only';
  END IF;
  IF OLD.source_type IN ('legacy_unclassified', 'demo_seed', 'test_fixture') OR NEW.source_type IN ('legacy_unclassified', 'demo_seed', 'test_fixture') THEN
    RAISE EXCEPTION 'journal entry % (%): the tag % cannot become %; an unclassified or synthetic tag never changes, and no entry becomes one', NEW.id, NEW.entry_number, OLD.source_type, NEW.source_type
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_source_tag_fixed';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_entries_source_tag_guard ON "journal_entries";--> statement-breakpoint
CREATE TRIGGER journal_entries_source_tag_guard
  BEFORE INSERT OR UPDATE OF source_type, source_id ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION journal_entries_source_tag_guard();--> statement-breakpoint

-- ── 5. G16's freeze (0126), unchanged except ONE admission, marked 🔴 A15 below. ──────────────────
CREATE OR REPLACE FUNCTION zz_journal_entries_posted_frozen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o jsonb;
  n jsonb;
  changed text;
  dr numeric;
  cr numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- T2: posting is a transition of an existing draft, never an insert, so a
    -- posted header can never exist without the flip that checks its lines.
    IF NEW.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'journal entry % (%) was inserted as %: an entry is written as a draft and posted by its own transition', NEW.id, NEW.entry_number, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_inserted_not_draft';
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('posted', 'reversed') THEN
      RAISE EXCEPTION 'journal entry % (%) is %: it cannot be deleted; it is corrected by a reversal', OLD.id, OLD.entry_number, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_posted_frozen';
    END IF;
    RETURN NULL;
  END IF;

  -- UPDATE
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'draft' THEN
      RETURN NULL;  -- a draft is unrestricted
    END IF;
    IF NEW.status = 'reversed' THEN
      RAISE EXCEPTION 'journal entry % (%) is a draft: it cannot be reversed, only posted or deleted', OLD.id, OLD.entry_number
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_posted_frozen';
    END IF;
    -- T3: draft → posted. Only the status and the posting time change.
    o := to_jsonb(OLD) - ARRAY['status', 'posted_at'];
    n := to_jsonb(NEW) - ARRAY['status', 'posted_at'];
    IF n IS DISTINCT FROM o THEN
      SELECT string_agg(k, ', ' ORDER BY k) INTO changed
        FROM (SELECT key AS k FROM jsonb_each(n) WHERE o -> key IS DISTINCT FROM n -> key) c;
      RAISE EXCEPTION 'journal entry % (%) is being posted: only its status and posting time change at posting (also changed: %)', OLD.id, OLD.entry_number, changed
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_posted_frozen';
    END IF;
    -- The stored lines balance, as they stand at COMMIT (balance only: owner decision 2).
    SELECT coalesce(sum(debit_amount), 0), coalesce(sum(credit_amount), 0) INTO dr, cr
      FROM journal_entry_lines WHERE journal_entry_id = NEW.id;
    IF dr <> cr THEN
      RAISE EXCEPTION 'journal entry % (%) cannot be posted: its stored lines do not balance (debits %, credits %)', NEW.id, NEW.entry_number, dr, cr
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_posted_unbalanced';
    END IF;
    RETURN NULL;
  END IF;

  -- OLD is posted or reversed.
  IF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
    -- T5/T6: only the status changes …
    o := to_jsonb(OLD) - 'status';
    n := to_jsonb(NEW) - 'status';
    IF n IS DISTINCT FROM o THEN
      SELECT string_agg(k, ', ' ORDER BY k) INTO changed
        FROM (SELECT key AS k FROM jsonb_each(n) WHERE o -> key IS DISTINCT FROM n -> key) c;
      RAISE EXCEPTION 'journal entry % (%) is being reversed: only its status changes (also changed: %)', OLD.id, OLD.entry_number, changed
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_posted_frozen';
    END IF;
    -- … a mirror is never itself reversed …
    IF OLD.reversal_of IS NOT NULL THEN
      RAISE EXCEPTION 'journal entry % (%) is the mirror of entry %: a reversal is never itself reversed', OLD.id, OLD.entry_number, OLD.reversal_of
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_posted_frozen';
    END IF;
    -- … and its posted mirror exists (read AT COMMIT: owner decision 3).
    IF NOT EXISTS (SELECT 1 FROM journal_entries m
                    WHERE m.reversal_of = OLD.id AND m.organization_id = OLD.organization_id
                      AND m.company_id = OLD.company_id AND m.status = 'posted') THEN
      RAISE EXCEPTION 'journal entry % (%) was marked reversed, but no posted mirror of it exists in its organisation and company', OLD.id, OLD.entry_number
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_reversal_mirror_missing';
    END IF;
    RETURN NULL;
  END IF;

  -- 🔴 A15 (owner, 2026-11-17: "a narrowly scoped migration exception … limited to the two source-tag metadata
  -- columns"): a posted or reversed entry's source tag, written from NULL, with NOTHING else changing (status
  -- included), while the A15 back-fill runs and its own record holds this exact change. The record is written only by
  -- the back-fill, as the table owner (the application's role holds no privilege on it), and
  -- `journal_entries_source_tag_guard` has already required the owner role. Anything else falls through to the refusal.
  IF OLD.status = NEW.status AND OLD.source_type IS NULL AND NEW.source_type IS NOT NULL
     AND nullif(current_setting('app.journal_source_backfill', true), '') IS NOT NULL THEN
    o := to_jsonb(OLD) - ARRAY['source_type', 'source_id'];
    n := to_jsonb(NEW) - ARRAY['source_type', 'source_id'];
    IF n IS NOT DISTINCT FROM o AND EXISTS (
         SELECT 1 FROM journal_source_backfill b
          WHERE b.journal_entry_id = NEW.id AND b.migration_version = current_setting('app.journal_source_backfill', true)
            AND b.new_source_type = NEW.source_type AND b.new_source_id IS NOT DISTINCT FROM NEW.source_id) THEN
      RETURN NULL;
    END IF;
  END IF;

  RAISE EXCEPTION 'journal entry % (%) is %: it cannot change (% to %); it is corrected by a reversal', OLD.id, OLD.entry_number, OLD.status, OLD.status, NEW.status
    USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_posted_frozen';
END $$;--> statement-breakpoint

-- ── 6. The back-fill: record first, then write exactly what was recorded; check; NOT NULL. ──────────
DO $$
DECLARE
  v constant text := '0163_a15_source_tag_mandatory';
  recorded integer;
  written integer;
  left_null integer;
  t record;
BEGIN
  PERFORM set_config('app.journal_source_backfill', v, true);
  INSERT INTO journal_source_backfill
    (organization_id, company_id, journal_entry_id, entry_number, entry_status, new_source_type, new_source_id, rule, evidence, migration_version)
  SELECT c.organization_id, c.company_id, c.entry_id, c.entry_number, c.entry_status, c.new_source_type, c.new_source_id, c.rule,
         c.evidence || CASE WHEN c.rule = 'U' AND p.entry_id IS NOT NULL
                            THEN jsonb_build_object('legacy_payment_candidate', p.evidence) ELSE '{}'::jsonb END,
         v
    FROM journal_source_classify() c
    LEFT JOIN journal_source_legacy_payment_candidates() p ON p.entry_id = c.entry_id
  ON CONFLICT (journal_entry_id) DO NOTHING;
  GET DIAGNOSTICS recorded = ROW_COUNT;
  UPDATE journal_entries j SET source_type = b.new_source_type, source_id = b.new_source_id
    FROM journal_source_backfill b
   WHERE b.journal_entry_id = j.id AND b.migration_version = v AND j.source_type IS NULL;
  GET DIAGNOSTICS written = ROW_COUNT;
  -- G16's checks run AT COMMIT; run them NOW, while the back-fill is declared (and so no trigger event is pending when
  -- NOT NULL is set below). Each deferred trigger on the table goes back to deferred afterwards.
  FOR t IN SELECT tgname FROM pg_trigger WHERE tgrelid = 'journal_entries'::regclass AND tgdeferrable AND tginitdeferred LOOP
    EXECUTE format('SET CONSTRAINTS %I IMMEDIATE', t.tgname);
  END LOOP;
  FOR t IN SELECT tgname FROM pg_trigger WHERE tgrelid = 'journal_entries'::regclass AND tgdeferrable AND tginitdeferred LOOP
    EXECUTE format('SET CONSTRAINTS %I DEFERRED', t.tgname);
  END LOOP;
  PERFORM set_config('app.journal_source_backfill', '', true);
  SELECT count(*) INTO left_null FROM journal_entries WHERE source_type IS NULL;
  IF left_null > 0 THEN
    RAISE EXCEPTION 'A15 back-fill REFUSED: % journal entr(y/ies) still carry no source tag after the back-fill; nothing was changed', left_null;
  END IF;
  RAISE NOTICE 'A15 back-fill: % entr(y/ies) recorded, % written (this run); none left without a tag', recorded, written;
END $$;--> statement-breakpoint
ALTER TABLE "journal_entries" ALTER COLUMN "source_type" SET NOT NULL;
