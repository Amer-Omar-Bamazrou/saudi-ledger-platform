-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 19B S3 (v4 §6.3, D2; owner 2026-11-21/22/23) — A VENDOR'S AND AN
--    EMPLOYEE'S IBAN IS HELD AT ENTRY AND ON EVERY CHANGE.
--  · bank_detail_change_requests gains the employee kind (employee_id, a
--    tenant-keyed foreign key), the fallback status
--    'applied_without_second_approver' and its `reason`; and `at_creation` — the
--    IBAN was entered with the record (its first), so it is not a CHANGE for the
--    change-then-pay finding (H-9/A23), as before S3; fixed once written.
--  · org_bank_detail_approver_ids(org): the active members whose role holds the
--    `bank_detail:approve` grant, read LIVE from `permissions` (the one matrix,
--    S0) — not executable by the request's roles.
--  · The request guard (0151 → 0161 → 0166, redefined here, every refusal kept):
--      - a vendor or employee IBAN is approved by an approver who is not the
--        requester (A1's linked-approver and MFA-reset refusals unchanged); the
--        company's own bank accounts keep DR-23's usable admin;
--      - the FALLBACK row is inserted closed, by the requester, at now(), with a
--        reason — only when the requester is an approver and NO other approver
--        exists (one A1-blocked still counts: the IBAN waits for them).
--  · THE WRITE BOUNDARY: a vendor's or employee's IBAN is never INSERTED (it
--    enters through the hold, which needs the record first), and an UPDATE that
--    changes it needs a matching request decided in THIS transaction by the
--    acting user — approved by them, or the fallback they recorded. This
--    replaces 0151's vendor trigger (held only where two admins existed).
--  · The only bypass stays session_replication_role = replica (owner only).
-- New column, kinds, functions and triggers; no existing row is read or changed.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bank_detail_change_requests' AND column_name IN ('employee_id', 'reason')) THEN
    RAISE EXCEPTION 'pre-check REFUSED: bank_detail_change_requests already has employee_id or reason; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_org_id_unq') THEN
    RAISE EXCEPTION 'pre-check REFUSED: employees_org_id_unq already exists; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN ('org_bank_detail_approver_ids', 'party_iban_hold')) THEN
    RAISE EXCEPTION 'pre-check REFUSED: a function of 0170 already exists; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'role_holds_grant') THEN
    RAISE EXCEPTION 'pre-check REFUSED: role_holds_grant (0155) is missing; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: none of 0170''s objects exist yet';
END $$;--> statement-breakpoint
-- G04: the target of the request's tenant-carrying reference (id is the primary key, so this cannot fail on data).
ALTER TABLE "employees" ADD CONSTRAINT "employees_org_id_unq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" DROP CONSTRAINT "bank_detail_change_kind_chk";--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" DROP CONSTRAINT "bank_detail_change_status_chk";--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" DROP CONSTRAINT "bank_detail_change_subject_chk";--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD COLUMN "employee_id" integer;--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD COLUMN "at_creation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD CONSTRAINT "bank_detail_change_employee_tenant_fk" FOREIGN KEY ("organization_id","employee_id") REFERENCES "public"."employees"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_detail_change_pending_employee_unq" ON "bank_detail_change_requests" USING btree ("employee_id") WHERE "bank_detail_change_requests"."status" = 'pending' and "bank_detail_change_requests"."kind" = 'employee_iban';--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD CONSTRAINT "bank_detail_change_fallback_chk" CHECK (("bank_detail_change_requests"."status" = 'applied_without_second_approver') = ("bank_detail_change_requests"."reason" is not null) and ("bank_detail_change_requests"."status" <> 'applied_without_second_approver' or "bank_detail_change_requests"."kind" in ('vendor_iban', 'employee_iban')));--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD CONSTRAINT "bank_detail_change_at_creation_chk" CHECK (not "bank_detail_change_requests"."at_creation" or ("bank_detail_change_requests"."iban_before" is null and "bank_detail_change_requests"."kind" in ('vendor_iban', 'employee_iban')));--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD CONSTRAINT "bank_detail_change_kind_chk" CHECK ("bank_detail_change_requests"."kind" in ('vendor_iban', 'employee_iban', 'bank_account_iban', 'default_bank_account'));--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD CONSTRAINT "bank_detail_change_status_chk" CHECK ("bank_detail_change_requests"."status" in ('pending', 'approved', 'rejected', 'applied_without_second_approver'));--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD CONSTRAINT "bank_detail_change_subject_chk" CHECK (("bank_detail_change_requests"."kind" = 'vendor_iban' and "bank_detail_change_requests"."vendor_id" is not null and "bank_detail_change_requests"."employee_id" is null and "bank_detail_change_requests"."bank_account_id" is null) or ("bank_detail_change_requests"."kind" = 'employee_iban' and "bank_detail_change_requests"."employee_id" is not null and "bank_detail_change_requests"."vendor_id" is null and "bank_detail_change_requests"."bank_account_id" is null) or ("bank_detail_change_requests"."kind" in ('bank_account_iban', 'default_bank_account') and "bank_detail_change_requests"."bank_account_id" is not null and "bank_detail_change_requests"."vendor_id" is null and "bank_detail_change_requests"."employee_id" is null));--> statement-breakpoint
-- ── Who could ever approve a party IBAN: ONE definition, read live from the matrix ──
CREATE FUNCTION org_bank_detail_approver_ids(org uuid) RETURNS SETOF integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.user_id FROM organization_memberships m JOIN users u ON u.id = m.user_id
   WHERE m.organization_id = org AND m.status = 'active' AND u.is_active
     AND role_holds_grant(m.role, 'bank_detail', 'approve')
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.org_bank_detail_approver_ids(uuid) FROM PUBLIC;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.org_bank_detail_approver_ids(uuid) FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
-- ── The request's flow: 0166's guard, with the party kinds and the fallback ──
CREATE OR REPLACE FUNCTION bank_detail_change_request_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  acting integer := (nullif(current_setting('app.current_user_id', true), ''))::integer;
  link text;
  party boolean := NEW.kind IN ('vendor_iban', 'employee_iban');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF acting IS NULL OR NEW.requested_by IS DISTINCT FROM acting THEN
      RAISE EXCEPTION 'this request names user %, but the connection''s declared actor is %: a request records who asked, never a user its writer chose', coalesce(NEW.requested_by::text, 'none'), coalesce(acting::text, 'none')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
    END IF;
    IF NEW.status = 'pending' THEN
      IF NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
        RAISE EXCEPTION 'a bank-detail change is recorded as pending; only a decision moves it'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
      END IF;
      RETURN NEW;
    END IF;
    -- 🔴 19B S3: the fallback — recorded closed by the requester, now, with its reason, and only when the requester is
    -- the one member who could ever approve it.
    IF NEW.status = 'applied_without_second_approver' AND party THEN
      IF NEW.decided_by IS DISTINCT FROM acting OR NEW.decided_at IS DISTINCT FROM now() OR NEW.reason IS NULL THEN
        RAISE EXCEPTION 'an IBAN applied without a second approver is recorded by the person who entered it, at the present moment, with its reason'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM org_bank_detail_approver_ids(NEW.organization_id) a WHERE a = acting) THEN
        RAISE EXCEPTION 'user % cannot approve bank details, so the IBAN they entered cannot apply without a second approver: it is held', acting
          USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_fallback_not_sole_approver';
      END IF;
      IF EXISTS (SELECT 1 FROM org_bank_detail_approver_ids(NEW.organization_id) a WHERE a <> acting) THEN
        RAISE EXCEPTION 'another member of this organisation can approve bank details, so the IBAN waits for them'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_fallback_not_sole_approver';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a bank-detail change is recorded as pending; only a decision moves it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'bank-detail change request % was already %: a decision is final', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.company_id, NEW.kind, NEW.vendor_id, NEW.employee_id, NEW.bank_account_id, NEW.iban_before, NEW.iban_after, NEW.requested_by, NEW.requested_at, NEW.reason, NEW.at_creation)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.company_id, OLD.kind, OLD.vendor_id, OLD.employee_id, OLD.bank_account_id, OLD.iban_before, OLD.iban_after, OLD.requested_by, OLD.requested_at, OLD.reason, OLD.at_creation) THEN
    RAISE EXCEPTION 'only the decision on bank-detail change request % may change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected') OR acting IS NULL OR NEW.decided_by IS DISTINCT FROM acting OR NEW.decided_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'a decision on a bank-detail change is approved or rejected, by the declared actor (%), at the present moment', coalesce(acting::text, 'none')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  IF NEW.status = 'approved' THEN
    IF NEW.decided_by = OLD.requested_by THEN
      RAISE EXCEPTION 'a bank-detail change is approved by a second person, never by the person who asked for it'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_second_admin';
    END IF;
    IF party THEN
      -- 🔴 19B S3 (v4 §6.3): a member whose role holds bank_detail:approve (an accountant or an admin), read live.
      IF NOT EXISTS (SELECT 1 FROM org_bank_detail_approver_ids(NEW.organization_id) a WHERE a = NEW.decided_by) THEN
        RAISE EXCEPTION 'user % cannot approve bank details: only a member whose role can approve them (an accountant or an admin) approves a supplier''s or an employee''s IBAN', NEW.decided_by
          USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_second_admin';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM org_usable_admin_ids(NEW.organization_id) a WHERE a = NEW.decided_by) THEN
      RAISE EXCEPTION 'user % is not a usable admin of this organisation: only an admin approves a change of the company''s own bank details', NEW.decided_by
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_second_admin';
    END IF;
    -- 🔴 A1 (owner, 2026-11-16): not an identity the requester created, re-activated or reset within 30 days.
    link := bank_detail_approver_link(OLD.requested_by, NEW.decided_by);
    IF link IS NOT NULL THEN
      RAISE EXCEPTION 'user % may not approve this change: the requester (user %) acted on that account within the last 30 days (%)', NEW.decided_by, OLD.requested_by, link
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_linked_approver';
    END IF;
    -- 🔴 Phase 19A (19.3): not an identity whose second factor was reset within 30 days.
    IF bank_detail_approver_recent_mfa_reset(NEW.decided_by) THEN
      RAISE EXCEPTION 'user % may not approve this change: that account''s two-step verification was reset within the last 30 days', NEW.decided_by
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_approver_mfa_reset';
    END IF;
  ELSIF NEW.decided_by <> OLD.requested_by THEN
    IF party AND NOT EXISTS (SELECT 1 FROM org_bank_detail_approver_ids(NEW.organization_id) a WHERE a = NEW.decided_by) THEN
      RAISE EXCEPTION 'only a member who can approve bank details, or the person who asked, rejects a supplier''s or an employee''s IBAN change'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
    ELSIF NOT party AND NOT EXISTS (SELECT 1 FROM org_usable_admin_ids(NEW.organization_id) a WHERE a = NEW.decided_by) THEN
      RAISE EXCEPTION 'only an admin, or the person who asked, rejects a bank-detail change'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- ── The write boundary for a party's IBAN ───────────────────────────────────
CREATE FUNCTION party_iban_hold() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  acting integer := (nullif(current_setting('app.current_user_id', true), ''))::integer;
  k text := CASE TG_TABLE_NAME WHEN 'vendors' THEN 'vendor_iban' ELSE 'employee_iban' END;
  what text := CASE TG_TABLE_NAME WHEN 'vendors' THEN 'supplier' ELSE 'employee' END;
  ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.iban IS NOT NULL THEN
      RAISE EXCEPTION 'a new %''s IBAN is not written with the record: it is entered through the hold (19B S3), which needs the record first', what
        USING ERRCODE = 'check_violation', CONSTRAINT = 'party_iban_hold';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.iban IS NOT DISTINCT FROM OLD.iban THEN
    RETURN NEW;
  END IF;
  SELECT EXISTS (SELECT 1 FROM bank_detail_change_requests r
    WHERE r.organization_id = NEW.organization_id AND r.kind = k
      AND (CASE k WHEN 'vendor_iban' THEN r.vendor_id ELSE r.employee_id END) = NEW.id
      AND r.decided_at = now()
      AND r.iban_before IS NOT DISTINCT FROM OLD.iban AND r.iban_after IS NOT DISTINCT FROM NEW.iban
      AND ((r.status = 'approved' AND r.decided_by IS NOT DISTINCT FROM acting)
        OR (r.status = 'applied_without_second_approver' AND r.requested_by IS NOT DISTINCT FROM acting))) INTO ok;
  IF NOT ok THEN
    RAISE EXCEPTION '% %: an IBAN change is held for a second approver (an accountant or admin who did not ask for it) — record it as a request', what, NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'party_iban_hold';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.party_iban_hold() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER "vendors_bank_detail_dual_control_trg" ON "vendors";--> statement-breakpoint
CREATE TRIGGER vendors_party_iban_hold_trg BEFORE INSERT OR UPDATE OF iban ON "vendors" FOR EACH ROW EXECUTE FUNCTION party_iban_hold();--> statement-breakpoint
CREATE TRIGGER employees_party_iban_hold_trg BEFORE INSERT OR UPDATE OF iban ON "employees" FOR EACH ROW EXECUTE FUNCTION party_iban_hold();
