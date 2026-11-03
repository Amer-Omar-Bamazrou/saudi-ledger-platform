-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 R-11b — DR-20 with DR-13 (owner, 2026-11-01; register §11.82,
--    §11.111): "mode by fact, as DR-14: a bookkeeper's tax, cash and equity
--    postings are approver-level where the company has two or more approvers,
--    and flagged where it has one." DR-13: "action-level grants for the acts
--    DR-20 classifies as high-risk, as seeded permission data in the
--    permission matrix, NOT editable at runtime."
--  · THE GRANTS: gl_cash_posting, gl_tax_posting, gl_equity_posting (action
--    approve), seeded for admin and accountant — the matrix's own rows.
--  · THE BOUNDARY, at the draft → posted flip every writer passes (G16): an
--    entry whose DECLARED actor (T1b) is a member without the grant for a
--    class its lines touch is REFUSED where the organisation has two or more
--    usable approvers, and posted with an `unreviewed_posting` control flag
--    (R-11a's store) where it has one. No declared actor (a job, a script) or
--    no membership: no member's act, outside the rule.
--  · Classes, by the account each line names — one definition each:
--    cash = liquidity_class 'cash' or a bank leaf; tax = gl_tax_account_codes(),
--    the mirror of TAX_ACCOUNT_SYSTEM_CODES (a test fails on drift); equity =
--    type 'equity'.
--  · A usable approver: an active membership whose role holds `approve` on
--    journal entries in the matrix, with an active account (G03's "usable").
-- New functions, trigger and grants; the flag store's kind list gains one
-- value. No existing row is read or changed. The pre-check refuses and
-- repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'control_flags_kind_chk') THEN
    RAISE EXCEPTION 'pre-check REFUSED: control_flags_kind_chk (0154) is not present; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM control_flags WHERE kind = 'unreviewed_posting') THEN
    RAISE EXCEPTION 'pre-check REFUSED: unreviewed_posting flags already exist; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN ('org_member_role', 'org_usable_approver_count', 'role_holds_grant', 'gl_tax_account_codes', 'journal_entry_posting_authority')) THEN
    RAISE EXCEPTION 'pre-check REFUSED: a function of 0155 already exists; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM permissions WHERE resource IN ('gl_cash_posting', 'gl_tax_posting', 'gl_equity_posting')) THEN
    RAISE EXCEPTION 'pre-check REFUSED: a posting grant already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: none of 0155''s objects exist yet';
END $$;--> statement-breakpoint
ALTER TABLE "control_flags" DROP CONSTRAINT "control_flags_kind_chk";--> statement-breakpoint
ALTER TABLE "control_flags" ADD CONSTRAINT "control_flags_kind_chk" CHECK ("control_flags"."kind" in ('self_approval', 'pair_approve_pay', 'pair_post_reverse', 'pair_complete_reopen', 'pair_commit_reverse', 'pair_remit_file', 'unreviewed_posting'));--> statement-breakpoint
-- ── DR-13: the grants, seeded (the matrix's rows, packages/db/src/permissions.ts) ──
INSERT INTO "permissions" (role, resource, action) VALUES
  ('admin', 'gl_cash_posting', 'approve'), ('accountant', 'gl_cash_posting', 'approve'),
  ('admin', 'gl_tax_posting', 'approve'), ('accountant', 'gl_tax_posting', 'approve'),
  ('admin', 'gl_equity_posting', 'approve'), ('accountant', 'gl_equity_posting', 'approve')
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- ── The definitions the boundary reads: one each, not executable by the request's roles ──
CREATE FUNCTION org_member_role(org uuid, member integer) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.role FROM organization_memberships m JOIN users u ON u.id = m.user_id
   WHERE m.organization_id = org AND m.user_id = member AND m.status = 'active' AND u.is_active
$$;--> statement-breakpoint
CREATE FUNCTION org_usable_approver_count(org uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM organization_memberships m JOIN users u ON u.id = m.user_id
   WHERE m.organization_id = org AND m.status = 'active' AND u.is_active
     AND m.role IN (SELECT p.role FROM permissions p WHERE p.resource = 'journal_entries' AND p.action = 'approve')
$$;--> statement-breakpoint
CREATE FUNCTION role_holds_grant(member_role text, res text, act text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM permissions p WHERE p.role = member_role AND p.resource = res AND p.action = act)
$$;--> statement-breakpoint
-- 🔴 The mirror of TAX_ACCOUNT_SYSTEM_CODES (packages/db/src/chartOfAccounts.ts); a test fails when they differ.
CREATE FUNCTION gl_tax_account_codes() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT ARRAY['VAT_OUTPUT', 'VAT_INPUT', 'VAT_AWAITING_EVIDENCE', 'VAT_ADJ_NONPAYMENT', 'VAT_ADJ_BLOCKED', 'VAT_PAYMENT',
               'ZAKAT_PAYMENT', 'WHT_PAYABLE', 'ZAKAT_EXPENSE', 'INCOME_TAX_EXPENSE', 'INCOME_TAX_PAYABLE']::text[]
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.org_member_role(uuid, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.org_usable_approver_count(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.role_holds_grant(text, text, text) FROM PUBLIC;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.org_member_role(uuid, integer) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.org_usable_approver_count(uuid) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.role_holds_grant(text, text, text) FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
-- ── THE BOUNDARY: the draft → posted flip ───────────────────────────────────
CREATE FUNCTION journal_entry_posting_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  acting integer := nullif(current_setting('app.current_user_id', true), '')::integer;
  member_role text;
  touches_cash boolean;
  touches_tax boolean;
  touches_equity boolean;
  needs text[] := ARRAY[]::text[];
BEGIN
  -- no declared actor (a scheduled job, a script): no member's act, outside DR-20
  IF acting IS NULL THEN RETURN NEW; END IF;
  member_role := org_member_role(NEW.organization_id, acting);
  IF member_role IS NULL THEN RETURN NEW; END IF;
  SELECT coalesce(bool_or(c.liquidity_class = 'cash' OR c.bank_account_id IS NOT NULL), false),
         coalesce(bool_or(c.system_code = ANY (gl_tax_account_codes())), false),
         coalesce(bool_or(c.type = 'equity'), false)
    INTO touches_cash, touches_tax, touches_equity
    FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
   WHERE l.journal_entry_id = NEW.id;
  IF touches_cash AND NOT role_holds_grant(member_role, 'gl_cash_posting', 'approve') THEN needs := needs || 'cash'::text; END IF;
  IF touches_tax AND NOT role_holds_grant(member_role, 'gl_tax_posting', 'approve') THEN needs := needs || 'tax'::text; END IF;
  IF touches_equity AND NOT role_holds_grant(member_role, 'gl_equity_posting', 'approve') THEN needs := needs || 'equity'::text; END IF;
  IF cardinality(needs) = 0 THEN RETURN NEW; END IF;
  IF org_usable_approver_count(NEW.organization_id) >= 2 THEN
    RAISE EXCEPTION 'journal entry %: it posts to a % account, and where the organisation has two or more approvers that posting is recorded by an approver (an admin or an accountant), not by a %', NEW.entry_number, array_to_string(needs, ' and '), member_role
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_posting_needs_approver';
  END IF;
  -- one approver: the posting stands, and is flagged for review (a flag never blocks)
  INSERT INTO control_flags (organization_id, company_id, kind, entity_type, entity_id, reference, first_act, second_act)
  VALUES (NEW.organization_id, NEW.company_id, 'unreviewed_posting', 'journal_entry', NEW.id::text, NEW.entry_number,
          'posted (' || array_to_string(needs, ', ') || ')', 'one approver');
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER journal_entries_posting_authority BEFORE UPDATE OF status ON "journal_entries" FOR EACH ROW WHEN (OLD.status = 'draft' AND NEW.status = 'posted') EXECUTE FUNCTION journal_entry_posting_authority();
