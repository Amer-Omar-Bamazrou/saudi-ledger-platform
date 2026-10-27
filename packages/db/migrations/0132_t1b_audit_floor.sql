-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 T1b (Phase 18) — THE AUDIT FLOOR, AND CLOSED MONTHS THAT STAY.
-- G24, G25; DR-09 "trigger now" (owner 2026-10-24 evening); final-run memo
-- 2026-10-27 §2 A and §1.3; contract AU-1, AU-2. Register §11.32.
--
-- AU-1 (G24): `audit_logs` and `security_audit_logs` are append-only for EVERY
--   role, the owner included: an UPDATE or DELETE of a row, and a TRUNCATE,
--   are refused at once. The app role's REVOKEs (0006; M11.1) stand.
-- AU-2 (G25): an `audit_logs` row names the CONNECTION's declared actor, the
--   transaction-local `app.current_user_id` that the tenant connection sets
--   once when it opens (TenantScope.actorUserId). `user_id` defaults to it,
--   and a row naming anyone else, or naming a user when none is declared, is
--   refused. The setting is trusted the way RLS trusts `app.current_org_id`; a
--   statement that re-sets it is not prevented here. That waits on DR-09's
--   separate least-privilege login role (hosting).
-- Closed months (T1e interpretation 2, owner 2026-10-27): a CLOSED lock
--   (`reopened_at IS NULL`) cannot be deleted by any role, and `period_locks`
--   cannot be truncated. A reopened lock is outside this rule; the request's
--   role still cannot delete any lock (0130's REVOKE stands).
--
-- 🔴 THE ONLY BYPASS is `session_replication_role = replica` (owner-only):
-- every trigger here is ordinary (ENABLE ORIGIN), never ENABLE ALWAYS, so the
-- demo reset's replica TRUNCATE and the replica-mode test cleanups still work.
-- Names sort last (`zz_…`), so older, specific guards refuse first.
--
-- The pre-check refuses, and names, the state this migration builds on; it
-- repairs nothing. Existing audit rows are not re-attributed: AU-2 binds new
-- rows only.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── PRE-CHECK: refuse before anything is created. ───────────────────────────
DO $$
DECLARE
  grants text;
  replica_triggers text;
BEGIN
  -- 1. The app role's posture this builds on: no UPDATE, DELETE or TRUNCATE
  --    on audit_logs (0006), and nothing at all on security_audit_logs (M11.1).
  SELECT string_agg(format('%s %s', table_name, privilege_type), ', ' ORDER BY table_name, privilege_type) INTO grants
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee = 'authenticated'
     AND ((table_name = 'audit_logs' AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE'))
       OR table_name = 'security_audit_logs');
  IF grants IS NOT NULL THEN
    RAISE EXCEPTION 'T1b pre-check REFUSED: the app role holds % on the audit tables; nothing was changed', grants
      USING HINT = 'This migration adds a floor that binds the owner ON TOP of the app-role REVOKEs (0006, M11.1). It revokes and repairs nothing: decide why the app role holds these first.';
  END IF;
  -- 2. No trigger on the three tables fires under replica mode: that would make
  --    replica mode something other than the single bypass.
  SELECT string_agg(format('%s.%s (%s)', c.relname, t.tgname, t.tgenabled), ', ') INTO replica_triggers
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname IN ('audit_logs', 'security_audit_logs', 'period_locks')
     AND NOT t.tgisinternal AND t.tgenabled IN ('A', 'R');
  IF replica_triggers IS NOT NULL THEN
    RAISE EXCEPTION 'T1b pre-check REFUSED: trigger(s) % fire under replica mode; nothing was changed', replica_triggers
      USING HINT = 'Replica mode is the single bypass of the audit floor and the closed-lock rule. This migration changes no existing trigger.';
  END IF;
  RAISE NOTICE 'T1b pre-check: the app role holds no mutating grant on audit_logs and nothing on security_audit_logs; no trigger on the three tables fires under replica mode';
END $$;--> statement-breakpoint

-- ── AU-2: the user is the connection's declared actor. ───────────────────────
ALTER TABLE "audit_logs" ALTER COLUMN "user_id" SET DEFAULT (nullif(current_setting('app.current_user_id', true), ''))::integer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_logs_actor_from_session() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  acting integer := (nullif(current_setting('app.current_user_id', true), ''))::integer;
BEGIN
  IF NEW.user_id IS DISTINCT FROM acting THEN
    RAISE EXCEPTION 'this audit row names user %, but the connection''s declared actor is %: an audit row records who is acting, never a user its writer chose', coalesce(NEW.user_id::text, 'none'), coalesce(acting::text, 'none')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_log_actor_from_session';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER audit_logs_actor_from_session BEFORE INSERT ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION audit_logs_actor_from_session();--> statement-breakpoint

-- ── AU-1: both audit tables are append-only for every role. ──────────────────
CREATE OR REPLACE FUNCTION zz_audit_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% on %: an audit trail is append-only for every role; nothing in it is changed or removed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = 'audit_log_append_only';
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER zz_audit_logs_append_only BEFORE UPDATE OR DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION zz_audit_append_only();--> statement-breakpoint
CREATE TRIGGER zz_audit_logs_no_truncate BEFORE TRUNCATE ON "audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION zz_audit_append_only();--> statement-breakpoint
CREATE TRIGGER zz_security_audit_logs_append_only BEFORE UPDATE OR DELETE ON "security_audit_logs" FOR EACH ROW EXECUTE FUNCTION zz_audit_append_only();--> statement-breakpoint
CREATE TRIGGER zz_security_audit_logs_no_truncate BEFORE TRUNCATE ON "security_audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION zz_audit_append_only();--> statement-breakpoint

-- ── A closed month's lock is never deleted, by any role. ─────────────────────
CREATE OR REPLACE FUNCTION zz_period_locks_closed_undeletable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'TRUNCATE on %: a closed month''s lock is never removed; a month is reopened with a reason, and its lock and history are kept', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', CONSTRAINT = 'period_lock_closed_undeletable';
  END IF;
  IF OLD.reopened_at IS NULL THEN
    RAISE EXCEPTION 'period % is closed: its lock is never deleted; the month is reopened with a reason (POST /period-locks/%/reopen), and its lock and history are kept', OLD.period, OLD.period
      USING ERRCODE = 'check_violation', CONSTRAINT = 'period_lock_closed_undeletable';
  END IF;
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER zz_period_locks_closed_undeletable BEFORE DELETE ON "period_locks" FOR EACH ROW EXECUTE FUNCTION zz_period_locks_closed_undeletable();--> statement-breakpoint
CREATE TRIGGER zz_period_locks_no_truncate BEFORE TRUNCATE ON "period_locks" FOR EACH STATEMENT EXECUTE FUNCTION zz_period_locks_closed_undeletable();
