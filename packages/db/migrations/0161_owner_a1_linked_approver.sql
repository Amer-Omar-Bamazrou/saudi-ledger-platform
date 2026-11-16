-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 owner decision A1 (2026-11-16) — DR-23'S SECOND ADMIN IS NOT AN
-- IDENTITY THE REQUESTER CONTROLS.
--
-- 0151 refuses the requester as the approver of its own held bank-detail
-- change. The audit's A1: an admin can CREATE another admin identity (or
-- reset its password, or re-activate it) and approve from it. The owner's
-- rule: approval is refused when the approver is an identity the requester
-- CREATED, RE-ACTIVATED or RESET within the preceding 30 days.
--
-- The facts are the security trail's (security_audit_logs), actor = the
-- requester, target = the approver, at an instant AFTER now() − 30 days:
--   created      user.created
--   re-activated user.reactivated; membership.status_changed / .role_changed
--                whose metadata goes from a non-active to an 'active' status;
--                membership.assigned to 'active' from a non-active `before`
--                (an event with no `before`, written before this migration,
--                counts — it cannot show it was not a re-activation)
--   reset        user.password_reset
-- MFA resets join this list in the change that builds MFA (Phase 19).
--
-- Enforced here, in the guard that already owns the decision (0151), so no
-- path approves around it; the API maps the constraint to a named refusal.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION bank_detail_approver_link(requester integer, approver integer) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.action
    FROM security_audit_logs s
   WHERE s.actor_user_id = requester
     AND s.target_user_id = approver
     AND s.created_at > (now() - interval '30 days')
     AND (
       s.action IN ('user.created', 'user.reactivated', 'user.password_reset')
       OR (s.action IN ('membership.status_changed', 'membership.role_changed')
           AND s.metadata -> 'after' ->> 'status' = 'active'
           AND (s.metadata -> 'before' ->> 'status') IS DISTINCT FROM 'active')
       OR (s.action = 'membership.assigned'
           AND s.metadata ->> 'status' = 'active'
           AND (s.metadata -> 'before' ->> 'status') IS DISTINCT FROM 'active')
     )
   ORDER BY s.created_at DESC
   LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION bank_detail_approver_link(integer, integer) FROM PUBLIC;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION bank_detail_approver_link(integer, integer) FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- 0151's guard, unchanged except the one new refusal in the approve branch.
CREATE OR REPLACE FUNCTION bank_detail_change_request_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  acting integer := (nullif(current_setting('app.current_user_id', true), ''))::integer;
  link text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a bank-detail change is recorded as pending; only a decision moves it'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
    END IF;
    IF acting IS NULL OR NEW.requested_by IS DISTINCT FROM acting THEN
      RAISE EXCEPTION 'this request names user %, but the connection''s declared actor is %: a request records who asked, never a user its writer chose', coalesce(NEW.requested_by::text, 'none'), coalesce(acting::text, 'none')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'bank-detail change request % was already %: a decision is final', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.company_id, NEW.kind, NEW.vendor_id, NEW.bank_account_id, NEW.iban_before, NEW.iban_after, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.company_id, OLD.kind, OLD.vendor_id, OLD.bank_account_id, OLD.iban_before, OLD.iban_after, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'only the decision on bank-detail change request % may change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected') OR acting IS NULL OR NEW.decided_by IS DISTINCT FROM acting OR NEW.decided_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'a decision on a bank-detail change is approved or rejected, by the declared actor (%), at the present moment', coalesce(acting::text, 'none')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  IF NEW.status = 'approved' THEN
    IF NEW.decided_by = OLD.requested_by THEN
      RAISE EXCEPTION 'a bank-detail change is approved by a second admin, never by the person who asked for it'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_second_admin';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM org_usable_admin_ids(NEW.organization_id) a WHERE a = NEW.decided_by) THEN
      RAISE EXCEPTION 'user % is not a usable admin of this organisation: only an admin approves a bank-detail change', NEW.decided_by
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_second_admin';
    END IF;
    -- 🔴 A1 (owner, 2026-11-16): not an identity the requester created, re-activated or reset within 30 days.
    link := bank_detail_approver_link(OLD.requested_by, NEW.decided_by);
    IF link IS NOT NULL THEN
      RAISE EXCEPTION 'user % may not approve this change: the requester (user %) acted on that account within the last 30 days (%)', NEW.decided_by, OLD.requested_by, link
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_linked_approver';
    END IF;
  ELSIF NEW.decided_by <> OLD.requested_by
        AND NOT EXISTS (SELECT 1 FROM org_usable_admin_ids(NEW.organization_id) a WHERE a = NEW.decided_by) THEN
    RAISE EXCEPTION 'only an admin, or the person who asked, rejects a bank-detail change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  RETURN NEW;
END $$;
