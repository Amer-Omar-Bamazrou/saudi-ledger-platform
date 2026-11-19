-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 A15 REVIEW (owner decisions 2026-11-17 and 2026-11-19) — THE REVIEW ROUTE
-- FOR `legacy_unclassified` JOURNAL ENTRIES.
--
-- 0163 tagged every old entry from authoritative relationships only and left
-- the rest `legacy_unclassified`: the generic reverse refuses them, and an
-- unclassified DRAFT is never posted — "classify it through the review route
-- first" (owner, 2026-11-19). The owner's terms (2026-11-17): the admin review
-- screen exposes the evidence and the review status; an administrator's stated
-- reason alone never reclassifies an entry as `manual`; classification as
-- `manual` waits for an accountant-approved policy.
--
-- So the review classifies an entry ONLY as a candidate 0163's own rules
-- (`journal_source_classify`) confirm AT THE MOMENT OF THE ACT — the same text
-- the back-fill read, never a second definition — and never as `manual`.
--
-- What this migration does:
--   1. `journal_source_reviews` — the review's own append-only record: the
--      candidate chosen, every candidate found, who chose it and when.
--      Owner-only: the application's role holds no privilege on it.
--   2. `journal_source_review_list()` — the screen's ONE reader: the current
--      organisation's (and company's) entries the back-fill left unclassified,
--      with the back-fill's evidence, the rules' candidates today, and the
--      review, if any. SECURITY DEFINER, scoped by the tenant settings.
--   3. `journal_source_review_classify()` — the review act: an active admin of
--      the organisation, an entry still `legacy_unclassified`, a candidate the
--      rules confirm now (rule F, N, S or R; never `manual`). Records first,
--      then writes exactly the recorded tag.
--   4. `journal_entries_source_tag_guard` admits ONE more change: a
--      `legacy_unclassified` tag becoming the reviewed tag, as the table owner,
--      while the review is declared and its record holds the same change.
--   5. The posted-journal freeze admits the same change on a posted or reversed
--      entry — the two tag columns only, nothing else changing, status
--      included. Every other column stays frozen exactly as 0126 froze it.
--
-- Idempotent: every object is created IF NOT EXISTS / OR REPLACE / after
-- DROP … IF EXISTS. It changes no row.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The review's own record (schema/journalSourceReviews.ts). ─────────────
CREATE TABLE IF NOT EXISTS "journal_source_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"journal_entry_id" integer NOT NULL,
	"entry_number" text NOT NULL,
	"entry_status" text NOT NULL,
	"previous_source_type" text NOT NULL,
	"new_source_type" text NOT NULL,
	"new_source_id" integer,
	"rule" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"reviewed_by" integer NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_source_reviews_entry_unq" UNIQUE("journal_entry_id"),
	CONSTRAINT "journal_source_reviews_rule_chk" CHECK ("journal_source_reviews"."rule" in ('F', 'N', 'S', 'R')),
	CONSTRAINT "journal_source_reviews_previous_chk" CHECK ("journal_source_reviews"."previous_source_type" = 'legacy_unclassified'),
	CONSTRAINT "journal_source_reviews_new_chk" CHECK ("journal_source_reviews"."new_source_type" not in ('legacy_unclassified', 'demo_seed', 'test_fixture', 'manual'))
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_source_reviews_organization_id_organizations_id_fk') THEN
    ALTER TABLE "journal_source_reviews" ADD CONSTRAINT "journal_source_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_source_reviews_company_id_companies_id_fk') THEN
    ALTER TABLE "journal_source_reviews" ADD CONSTRAINT "journal_source_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "journal_source_reviews_company_idx" ON "journal_source_reviews" USING btree ("company_id","reviewed_at");--> statement-breakpoint
-- Tenancy (the 0154 pattern): RLS and the tenant policy, for any reader that ever reads it as the application.
ALTER TABLE public.journal_source_reviews ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON public.journal_source_reviews;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.journal_source_reviews
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
-- 🔴 OWNER-ONLY: written by the review function alone and read through the list function; the application's role
-- holds NOTHING on the table. Supabase's default privileges grant every new table to these roles, TRUNCATE included,
-- so each is revoked explicitly (CLAUDE.md §4).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.journal_source_reviews FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.journal_source_reviews_id_seq FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.journal_source_reviews FROM PUBLIC;
END $$;--> statement-breakpoint
-- APPEND-ONLY for every role, the owner included, while its company exists (the control_flags pattern, 0154).
CREATE OR REPLACE FUNCTION journal_source_reviews_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- the company (or the organisation) itself is being removed: its records go with it, by the cascade — never alone
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
       OR NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% on journal_source_reviews: the review''s record is append-only for every role; nothing in it is changed or removed while its company exists', TG_OP
    USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_source_reviews_append_only';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS zz_journal_source_reviews_append_only ON "journal_source_reviews";--> statement-breakpoint
CREATE TRIGGER zz_journal_source_reviews_append_only BEFORE UPDATE OR DELETE ON "journal_source_reviews" FOR EACH ROW EXECUTE FUNCTION journal_source_reviews_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS zz_journal_source_reviews_no_truncate ON "journal_source_reviews";--> statement-breakpoint
CREATE TRIGGER zz_journal_source_reviews_no_truncate BEFORE TRUNCATE ON "journal_source_reviews" FOR EACH STATEMENT EXECUTE FUNCTION journal_source_reviews_append_only();--> statement-breakpoint

-- ── 2. The screen's one reader. ──────────────────────────────────────────────
-- The current organisation's entries the 0163 back-fill recorded as `legacy_unclassified` (rule U) — in the current
-- company when one is set — newest first, paged, with the back-fill's evidence, the candidates 0163's rules find TODAY
-- for each entry still unclassified, and the review that classified it, if any. SECURITY DEFINER because the records
-- are owner-only; the tenant settings scope it exactly as the tenant policy scopes a table (a missing organisation
-- reads nothing: it is refused). The rules run as the owner, so they see every relationship the back-fill saw.
CREATE OR REPLACE FUNCTION journal_source_review_list(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_entry_id integer DEFAULT NULL)
RETURNS TABLE (entry_id integer, entry_number text, entry_date text, entry_status text, description text, total numeric,
               current_source_type text, current_source_id integer, backfill_evidence jsonb, candidates jsonb,
               review jsonb, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org text := nullif(current_setting('app.current_org_id', true), '');
  co text := nullif(current_setting('app.current_company_id', true), '');
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  off integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'the unclassified-entries review is read inside an organisation'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'journal_source_review_no_tenant';
  END IF;
  RETURN QUERY
  WITH universe AS (
    SELECT b.journal_entry_id AS id, b.evidence AS bev, j.date AS dt
      FROM journal_source_backfill b
      JOIN journal_entries j ON j.id = b.journal_entry_id
     WHERE b.rule = 'U' AND b.organization_id::text = org AND (co IS NULL OR b.company_id::text = co)
       AND (p_entry_id IS NULL OR b.journal_entry_id = p_entry_id)
  ),
  page AS (
    SELECT u.id, u.bev, u.dt, count(*) OVER () AS n
      FROM universe u
     ORDER BY u.dt DESC, u.id DESC
     LIMIT lim OFFSET off
  ),
  open_ids AS (
    SELECT coalesce(array_agg(p.id), ARRAY[]::integer[]) AS ids
      FROM page p JOIN journal_entries j ON j.id = p.id
     WHERE j.source_type = 'legacy_unclassified'
  ),
  cls AS (SELECT c.entry_id AS eid, c.evidence AS ev FROM journal_source_classify((SELECT ids FROM open_ids)) c)
  SELECT j.id, j.entry_number, j.date::text, j.status, j.description,
         (SELECT round(coalesce(sum(l.debit_amount), 0)::numeric, 2) FROM journal_entry_lines l WHERE l.journal_entry_id = j.id),
         j.source_type, j.source_id, p.bev,
         coalesce(cls.ev -> 'candidates', '[]'::jsonb),
         (SELECT to_jsonb(r) - ARRAY['organization_id', 'company_id'] FROM journal_source_reviews r WHERE r.journal_entry_id = j.id),
         p.n
    FROM page p
    JOIN journal_entries j ON j.id = p.id
    LEFT JOIN cls ON cls.eid = j.id
   ORDER BY p.dt DESC, p.id DESC;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION journal_source_review_list(integer, integer, integer) FROM PUBLIC;--> statement-breakpoint

-- ── 3. The review act. ───────────────────────────────────────────────────────
-- Refused, each by name: no organisation or user in the transaction; the user is not an active admin of the
-- organisation; the entry is not the organisation's (and company's); it is no longer `legacy_unclassified`;
-- `manual` (an accountant-approved policy first); a tag no source row stands behind; a candidate the rules do not
-- confirm NOW. Then: record first, declare the review, write exactly the recorded tag, run the freeze's deferred
-- checks while the review is declared, and end the declaration.
CREATE OR REPLACE FUNCTION journal_source_review_classify(p_entry_id integer, p_source_type text, p_source_id integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org text := nullif(current_setting('app.current_org_id', true), '');
  co text := nullif(current_setting('app.current_company_id', true), '');
  uid integer := nullif(current_setting('app.current_user_id', true), '')::integer;
  e journal_entries%ROWTYPE;
  ev jsonb;
  chosen jsonb;
  rid integer;
  t record;
BEGIN
  IF org IS NULL OR uid IS NULL THEN
    RAISE EXCEPTION 'an unclassified entry is classified inside an organisation, by a signed-in user'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'journal_source_review_no_tenant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organization_memberships m
                  WHERE m.organization_id::text = org AND m.user_id = uid AND m.role = 'admin' AND m.status = 'active') THEN
    RAISE EXCEPTION 'user % is not an active admin of this organisation: only an admin classifies an unclassified entry', uid
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'journal_source_review_admin_only';
  END IF;
  SELECT * INTO e FROM journal_entries j
   WHERE j.id = p_entry_id AND j.organization_id::text = org AND (co IS NULL OR j.company_id::text = co)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal entry % is not an entry of this organisation and company', p_entry_id
      USING ERRCODE = 'no_data_found', CONSTRAINT = 'journal_source_review_entry_not_found';
  END IF;
  IF e.source_type IS DISTINCT FROM 'legacy_unclassified' THEN
    RAISE EXCEPTION 'journal entry % (%) is %, not legacy_unclassified: only an unclassified entry is classified by review', e.id, e.entry_number, e.source_type
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_source_review_not_unclassified';
  END IF;
  IF p_source_type = 'manual' THEN
    RAISE EXCEPTION 'journal entry % (%) cannot be classified as manual by review: that waits for an accountant-approved policy', e.id, e.entry_number
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_source_review_manual_needs_policy';
  END IF;
  IF p_source_type IS NULL OR p_source_type IN ('legacy_unclassified', 'demo_seed', 'test_fixture') THEN
    RAISE EXCEPTION 'journal entry % (%) cannot be classified as %: a review names a source the rules found', e.id, e.entry_number, coalesce(p_source_type, 'nothing')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_source_review_type_invalid';
  END IF;
  SELECT cls.evidence INTO ev FROM journal_source_classify(ARRAY[e.id]) cls;
  SELECT c INTO chosen
    FROM jsonb_array_elements(coalesce(ev -> 'candidates', '[]'::jsonb)) c
   WHERE c ->> 'type' = p_source_type
     AND (c ->> 'source_id')::integer IS NOT DISTINCT FROM p_source_id
     AND (c ->> 'checks_pass')::boolean
     AND c ->> 'rule' IN ('F', 'N', 'S', 'R')
   LIMIT 1;
  IF chosen IS NULL THEN
    RAISE EXCEPTION 'journal entry % (%): the rules find no relationship to % % whose checks pass today; nothing was classified', e.id, e.entry_number, p_source_type, coalesce(p_source_id::text, '')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_source_review_no_evidence';
  END IF;
  INSERT INTO journal_source_reviews
    (organization_id, company_id, journal_entry_id, entry_number, entry_status, previous_source_type, new_source_type,
     new_source_id, rule, evidence, reviewed_by)
  VALUES (e.organization_id, e.company_id, e.id, e.entry_number, e.status, 'legacy_unclassified', p_source_type,
          p_source_id, chosen ->> 'rule',
          jsonb_build_object('chosen', chosen, 'outcome', ev -> 'outcome', 'candidates', ev -> 'candidates'), uid)
  RETURNING id INTO rid;
  PERFORM set_config('app.journal_source_review', rid::text, true);
  UPDATE journal_entries SET source_type = p_source_type, source_id = p_source_id WHERE id = e.id;
  -- G16's checks run AT COMMIT; run them NOW, while the review is declared. Each deferred trigger goes back after.
  FOR t IN SELECT tgname FROM pg_trigger WHERE tgrelid = 'journal_entries'::regclass AND tgdeferrable AND tginitdeferred LOOP
    EXECUTE format('SET CONSTRAINTS %I IMMEDIATE', t.tgname);
  END LOOP;
  FOR t IN SELECT tgname FROM pg_trigger WHERE tgrelid = 'journal_entries'::regclass AND tgdeferrable AND tginitdeferred LOOP
    EXECUTE format('SET CONSTRAINTS %I DEFERRED', t.tgname);
  END LOOP;
  PERFORM set_config('app.journal_source_review', '', true);
  RETURN rid;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION journal_source_review_classify(integer, text, integer) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION journal_source_review_list(integer, integer, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION journal_source_review_classify(integer, text, integer) TO authenticated;
  END IF;
END $$;--> statement-breakpoint

-- ── 4. Who may write which tag: 0163's guard, unchanged except ONE admission, marked 🔴 A15 review below. ──
CREATE OR REPLACE FUNCTION journal_entries_source_tag_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  synthetic text := nullif(current_setting('app.journal_synthetic_source', true), '');
  backfill text := nullif(current_setting('app.journal_source_backfill', true), '');
  review text := nullif(current_setting('app.journal_source_review', true), '');
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
    -- 🔴 The ONE way a tag is first written onto an existing entry: the A15 back-fill, as the table owner, where its
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
  -- 🔴 A15 review (owner, 2026-11-19): the ONE way an unclassified tag changes — the review function, as the table
  -- owner, while the review is declared and its own record holds this exact change (never `manual`, never another
  -- unsourced tag). The application's role holds no privilege on the record, and a direct UPDATE by it is refused
  -- below whatever it declares, because it is not the owner.
  IF OLD.source_type = 'legacy_unclassified' AND review IS NOT NULL AND NEW.source_type IS NOT NULL
     AND NEW.source_type NOT IN ('legacy_unclassified', 'demo_seed', 'test_fixture', 'manual')
     AND pg_has_role(current_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
    IF EXISTS (SELECT 1 FROM journal_source_reviews r
                WHERE r.id::text = review AND r.journal_entry_id = NEW.id
                  AND r.new_source_type = NEW.source_type AND r.new_source_id IS NOT DISTINCT FROM NEW.source_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF OLD.source_type IN ('legacy_unclassified', 'demo_seed', 'test_fixture') OR NEW.source_type IN ('legacy_unclassified', 'demo_seed', 'test_fixture') THEN
    RAISE EXCEPTION 'journal entry % (%): the tag % cannot become %; an unclassified or synthetic tag never changes, and no entry becomes one', NEW.id, NEW.entry_number, OLD.source_type, NEW.source_type
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_source_tag_fixed';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ── 5. G16's freeze (0126, with 0163's admission), unchanged except ONE more admission, marked 🔴 A15 review. ──
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

  -- 🔴 A15 review (owner, 2026-11-19: "classify it through the review route first"): the SAME two tag columns, from
  -- `legacy_unclassified` to the reviewed tag, with NOTHING else changing (status included), while the review is
  -- declared and its own record holds this exact change. The record is written only by the review function, as the
  -- table owner, and `journal_entries_source_tag_guard` has already required the owner role. Anything else falls
  -- through to the refusal.
  IF OLD.status = NEW.status AND OLD.source_type = 'legacy_unclassified' AND NEW.source_type IS DISTINCT FROM 'legacy_unclassified'
     AND nullif(current_setting('app.journal_source_review', true), '') IS NOT NULL THEN
    o := to_jsonb(OLD) - ARRAY['source_type', 'source_id'];
    n := to_jsonb(NEW) - ARRAY['source_type', 'source_id'];
    IF n IS NOT DISTINCT FROM o AND EXISTS (
         SELECT 1 FROM journal_source_reviews r
          WHERE r.id::text = current_setting('app.journal_source_review', true) AND r.journal_entry_id = NEW.id
            AND r.new_source_type = NEW.source_type AND r.new_source_id IS NOT DISTINCT FROM NEW.source_id) THEN
      RETURN NULL;
    END IF;
  END IF;

  RAISE EXCEPTION 'journal entry % (%) is %: it cannot change (% to %); it is corrected by a reversal', OLD.id, OLD.entry_number, OLD.status, OLD.status, NEW.status
    USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_posted_frozen';
END $$;
