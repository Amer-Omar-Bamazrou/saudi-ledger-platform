-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 G16 (Phase 18) — THE POSTED-JOURNAL FREEZE: a posted or reversed journal
-- entry, and its lines, cannot be changed, deleted or truncated at the
-- database, by any role (the owner included). Design:
-- docs/phase-18-g16-posted-journal-freeze-design.md; owner decisions of
-- 2026-10-22 (§5) and 2026-10-23 (afternoon, item 3).
--
-- The lifecycle (states draft, posted, reversed; "reject" of a draft is a hard
-- delete):
--   T2  ∅ → draft          a header is INSERTED only as a draft
--   T3  draft → posted     the approval, and the posting seam's flip
--                          (postJournalEntry: draft header → lines → flip);
--                          only `status` and `posted_at` change, and the
--                          stored lines must balance (Σdebit = Σcredit;
--                          owner decision 2: balance only, no line-count rule)
--   T4  draft → deleted    unrestricted (its lines cascade)
--   T5/T6 posted → reversed  only `status` changes, the entry is not itself a
--                          mirror, and its posted mirror (`reversal_of` = id,
--                          same organisation and company) exists AT COMMIT
--                          (owner decision 3: deferred)
-- Everything else on a posted or reversed row is refused AT COMMIT (owner
-- decision 4): any other UPDATE (including a no-op), a DELETE, and draft →
-- reversed. Lines: an UPDATE or DELETE of a line whose entry is posted or
-- reversed is refused at COMMIT; an INSERT into a posted or reversed entry is
-- refused AT ONCE (see L1 below for why that one cannot wait); TRUNCATE of
-- either table is refused.
--
-- 🔴 WHY AT COMMIT. The checks are DEFERRABLE INITIALLY DEFERRED constraint
-- triggers. A refusal at COMMIT raises from the COMMIT itself, which the
-- request pipeline (lib/responseCommit.ts) answers as an error before the
-- first byte of the response — proven through a real request by
-- phase18-g16-commit-refusal-gate.test.ts, the owner's condition for this
-- decision. A transaction that is rolled back is never checked (probes that
-- roll back keep their assertions).
--
-- 🔴 THE ONLY BYPASS is `session_replication_role = replica` (owner-only):
-- every trigger here is ordinary (ENABLE ORIGIN), never ENABLE ALWAYS, so the
-- demo reset's replica TRUNCATE and the tests' replica cleanups still work.
--
-- 🔴 NAMES SORT LAST (`zz_…`): Postgres fires same-timing triggers in name
-- order, so every older, specific guard (bank reconciliation 0101/0102, input
-- VAT 0107/0108, WHT 0113/0117, mirror admission 0119, the non-posting account
-- guard) refuses first and keeps its own constraint name.
--
-- This migration refuses, and lists, existing rows that break the invariants it
-- freezes (the five pre-checks). It repairs, reclassifies and deletes nothing.
-- The separate least-privilege login role (decision 7) waits for hosting.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── THE FIVE PRE-CHECKS, stated once (the DO block below and the probe tests
--    both read this function). Each row is one violation. ─────────────────────
CREATE OR REPLACE FUNCTION g16_journal_precheck_violations()
RETURNS TABLE (check_no integer, entry_id integer, detail text)
LANGUAGE sql STABLE AS $fn$
  -- 1. The status domain (required before the CHECK below).
  SELECT 1, h.id, 'status ' || coalesce(h.status, 'NULL') || ' is not draft, posted or reversed'
    FROM journal_entries h
   WHERE h.status IS NULL OR h.status NOT IN ('draft', 'posted', 'reversed')
  UNION ALL
  -- 2. Every reversed entry has its posted mirror, in its own organisation and company.
  SELECT 2, o.id, 'reversed, but no posted mirror (reversal_of = ' || o.id || ') in its organisation and company'
    FROM journal_entries o
   WHERE o.status = 'reversed'
     AND NOT EXISTS (SELECT 1 FROM journal_entries m
                      WHERE m.reversal_of = o.id AND m.organization_id = o.organization_id
                        AND m.company_id = o.company_id AND m.status = 'posted')
  UNION ALL
  -- 3. Every mirror is posted, and its original exists in the same organisation
  --    and company and is reversed.
  SELECT 3, m.id,
         CASE WHEN m.status IS DISTINCT FROM 'posted' THEN 'mirror of ' || m.reversal_of || ' is ' || coalesce(m.status, 'NULL') || ', not posted'
              WHEN o.id IS NULL THEN 'mirror of ' || m.reversal_of || ', which is not in its organisation and company'
              ELSE 'mirror of ' || o.id || ', which is ' || o.status || ', not reversed' END
    FROM journal_entries m
    LEFT JOIN journal_entries o
      ON o.id = m.reversal_of AND o.organization_id = m.organization_id AND o.company_id = m.company_id
   WHERE m.reversal_of IS NOT NULL
     AND (m.status IS DISTINCT FROM 'posted' OR o.id IS NULL OR o.status IS DISTINCT FROM 'reversed')
  UNION ALL
  -- 4. Every line sits in its entry's organisation and company.
  SELECT 4, l.journal_entry_id, 'line ' || l.id || ' is in another organisation or company than its entry'
    FROM journal_entry_lines l
    JOIN journal_entries h ON h.id = l.journal_entry_id
   WHERE l.organization_id IS DISTINCT FROM h.organization_id OR l.company_id IS DISTINCT FROM h.company_id
  UNION ALL
  -- 5. Every posted or reversed entry balances over its stored lines (owner
  --    decision 2: balance only). LEFT JOIN, so an entry with no lines is SEEN
  --    (it balances at 0 = 0).
  SELECT 5, h.id, 'debits ' || coalesce(sum(l.debit_amount), 0) || ' vs credits ' || coalesce(sum(l.credit_amount), 0)
    FROM journal_entries h
    LEFT JOIN journal_entry_lines l ON l.journal_entry_id = h.id
   WHERE h.status IN ('posted', 'reversed')
   GROUP BY h.id
  HAVING coalesce(sum(l.debit_amount), 0) <> coalesce(sum(l.credit_amount), 0)
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION g16_journal_precheck_violations() FROM PUBLIC;--> statement-breakpoint

-- ── PRE-CHECK: refuse, and list, before anything is created. ────────────────
DO $$
DECLARE
  n integer;
  per_check text;
  first_50 jsonb;
BEGIN
  SELECT count(*)::int,
         coalesce(jsonb_agg(jsonb_build_object('check', v.check_no, 'entry_id', v.entry_id, 'detail', v.detail)
                            ORDER BY v.check_no, v.entry_id) FILTER (WHERE v.rn <= 50), '[]'::jsonb)
    INTO n, first_50
    FROM (SELECT p.*, row_number() OVER (ORDER BY p.check_no, p.entry_id) AS rn FROM g16_journal_precheck_violations() p) v;
  IF n > 0 THEN
    SELECT string_agg(format('check %s: %s', c.check_no, c.k), '; ' ORDER BY c.check_no) INTO per_check
      FROM (SELECT check_no, count(*) AS k FROM g16_journal_precheck_violations() GROUP BY check_no) c;
    RAISE EXCEPTION 'G16 pre-check REFUSED: % journal row(s) break the invariants this migration freezes (%); nothing was changed. First 50: %', n, per_check, first_50
      USING HINT = 'This migration freezes posted journal entries as they stand. It does not repair, reclassify or delete any row: the owner decides what each listed row is before it is frozen.';
  END IF;
  RAISE NOTICE 'G16 pre-check: checks 1-5 pass (status domain, reversed has its mirror, mirror and original agree, lines in their entry''s organisation and company, posted entries balance)';
END $$;--> statement-breakpoint

-- ── The status domain (pre-check 1 above). ───────────────────────────────────
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_status_chk" CHECK (status IN ('draft', 'posted', 'reversed'));--> statement-breakpoint

-- ── The header, checked AT COMMIT against the row as each event saw it. ─────
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

  RAISE EXCEPTION 'journal entry % (%) is %: it cannot change (% to %); it is corrected by a reversal', OLD.id, OLD.entry_number, OLD.status, OLD.status, NEW.status
    USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_posted_frozen';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS zz_journal_entries_posted_frozen ON "journal_entries";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER zz_journal_entries_posted_frozen
  AFTER INSERT OR UPDATE OR DELETE ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION zz_journal_entries_posted_frozen();--> statement-breakpoint

-- ── L1: a line INTO a posted or reversed entry, refused AT ONCE. ─────────────
-- 🔴 The one rule that cannot wait for COMMIT: by then the header of a
-- legitimate posting is posted too (draft → lines → flip, in one transaction),
-- so a commit-time check could not tell a line written into the draft from one
-- written into the posted entry. No product path writes a line into a posted
-- entry (the seam and the generic reverse write lines into their own draft).
CREATE OR REPLACE FUNCTION zz_journal_entry_lines_posted_frozen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  header_status text;
BEGIN
  SELECT status INTO header_status FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF header_status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'journal entry % is %: a line cannot be added to it; it is corrected by a reversal', NEW.journal_entry_id, header_status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_line_posted_frozen';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS zz_journal_entry_lines_posted_frozen ON "journal_entry_lines";--> statement-breakpoint
CREATE TRIGGER zz_journal_entry_lines_posted_frozen
  BEFORE INSERT ON "journal_entry_lines"
  FOR EACH ROW EXECUTE FUNCTION zz_journal_entry_lines_posted_frozen();--> statement-breakpoint

-- ── L2/L3: a line of a posted or reversed entry is neither changed nor
--    deleted, checked AT COMMIT against its entry as it then stands (a draft's
--    lines, and lines cascading with a deleted draft, are unrestricted). ──────
CREATE OR REPLACE FUNCTION zz_journal_entry_lines_posted_frozen_at_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  frozen text;
BEGIN
  SELECT string_agg(format('%s (%s)', h.id, h.status), ', ' ORDER BY h.id) INTO frozen
    FROM journal_entries h
   WHERE h.status IN ('posted', 'reversed')
     AND h.id IN (OLD.journal_entry_id, CASE WHEN TG_OP = 'UPDATE' THEN NEW.journal_entry_id END);
  IF frozen IS NOT NULL THEN
    RAISE EXCEPTION 'journal line % belongs to posted or reversed entry %: it cannot be %', OLD.id, frozen,
      CASE WHEN TG_OP = 'DELETE' THEN 'deleted' ELSE 'changed' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_line_posted_frozen';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS zz_journal_entry_lines_posted_frozen_at_commit ON "journal_entry_lines";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER zz_journal_entry_lines_posted_frozen_at_commit
  AFTER UPDATE OR DELETE ON "journal_entry_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION zz_journal_entry_lines_posted_frozen_at_commit();--> statement-breakpoint

-- ── TRUNCATE bypasses every row trigger, so it is refused outright. ──────────
CREATE OR REPLACE FUNCTION zz_journal_truncate_refused() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated: posted journal entries are permanent', TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_truncate_refused';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS zz_journal_entries_truncate_refused ON "journal_entries";--> statement-breakpoint
CREATE TRIGGER zz_journal_entries_truncate_refused
  BEFORE TRUNCATE ON "journal_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION zz_journal_truncate_refused();--> statement-breakpoint
DROP TRIGGER IF EXISTS zz_journal_entry_lines_truncate_refused ON "journal_entry_lines";--> statement-breakpoint
CREATE TRIGGER zz_journal_entry_lines_truncate_refused
  BEFORE TRUNCATE ON "journal_entry_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION zz_journal_truncate_refused();
