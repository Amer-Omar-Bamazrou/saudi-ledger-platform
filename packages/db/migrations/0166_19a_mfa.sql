-- 🔴 Phase 19A slice 2 (owner approval of the Phase 19 proposal v2 and the MFA policy, 2026-11-17): 19.1 enrolment,
-- 19.2 verification, 19.3 recovery and the assisted reset.
--
-- user_mfa_factors: ONE TOTP secret per account, sealed as a ZATCA private key is (AES-256-GCM under a per-row data
-- key, itself wrapped by the KMS master key). user_mfa_recovery_codes: single-use codes, stored only as hashes made by
-- the password seam. Both are identity tables: no organization, no RLS, OWNER-ONLY (revoked explicitly below).
CREATE TABLE "user_mfa_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"state" varchar(10) DEFAULT 'pending' NOT NULL,
	"kms_provider" text NOT NULL,
	"kms_key_id" text NOT NULL,
	"wrapped_data_key" "bytea" NOT NULL,
	"encrypted_secret" "bytea" NOT NULL,
	"secret_iv" "bytea" NOT NULL,
	"secret_auth_tag" "bytea" NOT NULL,
	"last_used_step" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "user_mfa_factors_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "user_mfa_factors_state_chk" CHECK ("user_mfa_factors"."state" in ('pending', 'active')),
	CONSTRAINT "user_mfa_factors_activated_chk" CHECK (("user_mfa_factors"."state" = 'active') = ("user_mfa_factors"."activated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "user_mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_mfa_factors" ADD CONSTRAINT "user_mfa_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa_recovery_codes" ADD CONSTRAINT "user_mfa_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_mfa_recovery_codes_user_idx" ON "user_mfa_recovery_codes" USING btree ("user_id");
--> statement-breakpoint
-- 🔴 OWNER-ONLY: Supabase's default privileges grant every new table to these roles, TRUNCATE included (CLAUDE.md §4).
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_mfa_factors', 'user_mfa_recovery_codes'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
  END LOOP;
END $$;--> statement-breakpoint
-- 🔴 AN ACTIVE FACTOR'S SECRET IS NEVER REWRITTEN, it never goes back to pending, and an accepted step never goes
-- backwards (the replay guard cannot be rewound) — for every role, the owner included. Replacing a factor is a RESET:
-- the row is deleted by that audited act and a new one enrolled.
CREATE OR REPLACE FUNCTION user_mfa_factors_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_mfa_factors: a factor is never moved to another account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_mfa_factors_identity_fixed';
  END IF;
  IF OLD.state = 'active' AND (
       NEW.state IS DISTINCT FROM 'active' OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
       OR NEW.encrypted_secret IS DISTINCT FROM OLD.encrypted_secret OR NEW.secret_iv IS DISTINCT FROM OLD.secret_iv
       OR NEW.secret_auth_tag IS DISTINCT FROM OLD.secret_auth_tag OR NEW.wrapped_data_key IS DISTINCT FROM OLD.wrapped_data_key
       OR NEW.kms_provider IS DISTINCT FROM OLD.kms_provider OR NEW.kms_key_id IS DISTINCT FROM OLD.kms_key_id) THEN
    RAISE EXCEPTION 'user_mfa_factors: an active factor is never rewritten or de-activated; replacing it is a reset'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_mfa_factors_active_is_fixed';
  END IF;
  IF OLD.last_used_step IS NOT NULL AND (NEW.last_used_step IS NULL OR NEW.last_used_step < OLD.last_used_step) THEN
    RAISE EXCEPTION 'user_mfa_factors: an accepted step never goes backwards'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_mfa_factors_step_forward';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS user_mfa_factors_guard ON public.user_mfa_factors;--> statement-breakpoint
CREATE TRIGGER user_mfa_factors_guard BEFORE UPDATE ON public.user_mfa_factors
  FOR EACH ROW EXECUTE FUNCTION user_mfa_factors_guard();--> statement-breakpoint
-- 🔴 A RECOVERY CODE IS USED ONCE: its hash and owner are fixed, and used_at is written once and never cleared.
CREATE OR REPLACE FUNCTION user_mfa_recovery_codes_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.code_hash IS DISTINCT FROM OLD.code_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'user_mfa_recovery_codes: a code is never rewritten'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_mfa_recovery_codes_fixed';
  END IF;
  IF OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at THEN
    RAISE EXCEPTION 'user_mfa_recovery_codes: a used code stays used'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_mfa_recovery_codes_used_once';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS user_mfa_recovery_codes_guard ON public.user_mfa_recovery_codes;--> statement-breakpoint
CREATE TRIGGER user_mfa_recovery_codes_guard BEFORE UPDATE ON public.user_mfa_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION user_mfa_recovery_codes_guard();--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 A1 GAINS THE MFA RESET (owner, 2026-11-17: "an MFA reset is an A1 qualifying event"). Only platform security
-- operators reset a factor (never an org admin), so the requester of a bank change is never the reset's actor: the
-- fact that matters is that the APPROVER's second factor was reset within 30 days, whoever asked. An internal control
-- of the platform, not a regulatory requirement.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION bank_detail_approver_recent_mfa_reset(approver integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM security_audit_logs s
     WHERE s.action = 'mfa.reset' AND s.target_user_id = approver AND s.created_at > (now() - interval '30 days'))
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION bank_detail_approver_recent_mfa_reset(integer) FROM PUBLIC;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION bank_detail_approver_recent_mfa_reset(integer) FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
-- 0161's guard, unchanged except the one new refusal after the linked-approver check.
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
    -- 🔴 Phase 19A (19.3; owner 2026-11-17: an MFA reset is an A1 qualifying event): not an identity whose second
    -- factor was reset within 30 days — whoever asked for the reset, the account's control is what is in question.
    IF bank_detail_approver_recent_mfa_reset(NEW.decided_by) THEN
      RAISE EXCEPTION 'user % may not approve this change: that account''s two-step verification was reset within the last 30 days', NEW.decided_by
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_approver_mfa_reset';
    END IF;
  ELSIF NEW.decided_by <> OLD.requested_by
        AND NOT EXISTS (SELECT 1 FROM org_usable_admin_ids(NEW.organization_id) a WHERE a = NEW.decided_by) THEN
    RAISE EXCEPTION 'only an admin, or the person who asked, rejects a bank-detail change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  RETURN NEW;
END $$;
