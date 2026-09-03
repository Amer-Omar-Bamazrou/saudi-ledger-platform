-- ═══════════════════════════════════════════════════════════════════════════
-- N1 — SAME-ORG CROSS-COMPANY ISOLATION, ENFORCED AT THE ROW (2026-09-03)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two companies in one organization are SEPARATE SETS OF BOOKS — their own
-- document sequences, fiscal calendars and period locks. Until this migration,
-- `app.current_company_id` was set on every request and read by NOTHING at the
-- database: it existed only as the column DEFAULT for `company_id`
-- (0004_m4_rls_enforcement). Every `tenant_isolation` policy tested
-- `organization_id` alone, so company separation lived per query, in the
-- repositories — and fifteen repositories never wrote the filter
-- (`apps/api/src/tests/cross-company-isolation.test.ts`, the pinned list).
--
-- The measured consequence (ERPNext comparison, 2026-09-03): a two-company
-- org's trial balance, GL, income statement, balance sheet and VAT return ADD
-- BOTH COMPANIES' BOOKS and present the result as one entity's figures — a
-- 10×-wrong statutory filing in the fixture — while the trial balance reports
-- `balanced: true`, because two balanced books sum to a balanced book. The
-- report's only self-check cannot distinguish correct from corrupted.
--
-- ── THE RULE THIS MIGRATION ADDS ───────────────────────────────────────────
--
-- Every `tenant_isolation` policy on a table carrying `company_id` gains a
-- company arm:
--
--   • company GUC SET   → only that company's rows (plus, on tables where
--     `company_id` is NULLABLE, org-level rows with `company_id IS NULL` —
--     `findings` and `ai_usage`, whose NULL rows are org-wide facts a
--     company-scoped page must still see).
--   • company GUC EMPTY → org-scoped, exactly as before.
--   • org GUC EMPTY     → nothing, exactly as before (fail-closed).
--
-- ── 🔴 WHY THE EMPTY-GUC ARM IS ORG-WIDE, AND WHY THAT IS NOT "THE FALLBACK
--        RULE" BEING BROKEN ──────────────────────────────────────────────────
-- §4 forbids re-adding a silent fallback where `db` once fell back to the
-- OWNER connection — that fallback crossed TENANTS with RLS bypassed. This arm
-- never leaves the organization and exists for a NAMED caller:
-- `findings.schedule.service.ts` deliberately opens org-wide tenant
-- connections (no companyId) to compute per-org findings. Making the empty
-- GUC return zero rows would silently break that job — a confident zero, the
-- worse failure. A request path that forgets the company GUC now reads
-- org-wide at the DB while the report repositories' own company predicates
-- (added alongside this migration) match nothing — so a misconfigured request
-- yields an EMPTY report, never a doubled one, and the two layers disagree
-- loudly instead of agreeing on the wrong answer.
--
-- Owner-only tables (`zatca_credentials`, `zatca_credential_reminders`) have
-- no tenant_isolation policy and are deliberately untouched.
--
-- 🔴 The enumeration below is an INVENTORY, not a hand-kept list: it reads the
-- catalog for tables that have BOTH a tenant_isolation policy AND a company_id
-- column, so it cannot miss a table this rule applies to today. A table
-- created AFTER this migration is the gap the catalog cannot close — that is
-- pinned by `apps/api/src/tests/cross-company-isolation.test.ts`, which
-- asserts every such policy references `current_company_id`.

DO $$
DECLARE
  t record;
  org_arm text := $arm$ (organization_id)::text = current_setting('app.current_org_id'::text, true) $arm$;
  company_match text;
  qual text;
BEGIN
  FOR t IN
    SELECT p.tablename,
           (SELECT c.is_nullable = 'YES'
              FROM information_schema.columns c
             WHERE c.table_schema = 'public'
               AND c.table_name = p.tablename
               AND c.column_name = 'company_id') AS company_nullable
      FROM pg_policies p
     WHERE p.schemaname = 'public'
       AND p.policyname = 'tenant_isolation'
       AND EXISTS (SELECT 1
                     FROM information_schema.columns c
                    WHERE c.table_schema = 'public'
                      AND c.table_name = p.tablename
                      AND c.column_name = 'company_id')
     ORDER BY p.tablename
  LOOP
    company_match := format(
      $m$ ( COALESCE(current_setting('app.current_company_id'::text, true), '') = ''
            %s
            OR (company_id)::text = current_setting('app.current_company_id'::text, true) ) $m$,
      CASE WHEN t.company_nullable THEN 'OR company_id IS NULL' ELSE '' END
    );
    qual := '(' || org_arm || ' AND ' || company_match || ')';
    EXECUTE format(
      'ALTER POLICY tenant_isolation ON public.%I USING %s WITH CHECK %s',
      t.tablename, qual, qual
    );
    RAISE NOTICE 'tenant_isolation on % now company-aware (nullable arm: %)', t.tablename, t.company_nullable;
  END LOOP;

  -- The migration refuses to succeed vacuously: if the loop matched nothing,
  -- the catalog read is broken and "done" would be a confident zero.
  IF (SELECT count(*) FROM pg_policies p
       WHERE p.schemaname = 'public' AND p.policyname = 'tenant_isolation'
         AND p.qual::text LIKE '%current_company_id%') < 30 THEN
    RAISE EXCEPTION 'N1 company arm applied to fewer than 30 policies — the inventory query is wrong, not the schema';
  END IF;
END $$;
