-- 🔴 Phase 19A slice 3 (owner approval of the Phase 19 proposal v2, 2026-11-17): 19.7 centralised security settings.
--
-- org_security_settings: one row per organization; a missing row is the platform default, which is also the WEAKEST
-- value allowed (the CHECKs are the platform's bounds). org_security_setting_changes: a WEAKENING change held for a
-- second admin. Both are identity tables: read before any tenant is resolved, OWNER-ONLY, no RLS (revoked below).
CREATE TABLE "org_security_setting_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"mfa_before" boolean NOT NULL,
	"mfa_after" boolean NOT NULL,
	"lifetime_before" integer NOT NULL,
	"lifetime_after" integer NOT NULL,
	"idle_before" integer NOT NULL,
	"idle_after" integer NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"requested_by" integer NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" integer,
	"decided_at" timestamp with time zone,
	CONSTRAINT "org_security_setting_changes_status_chk" CHECK ("org_security_setting_changes"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "org_security_setting_changes_decision_chk" CHECK (("org_security_setting_changes"."status" = 'pending') = ("org_security_setting_changes"."decided_by" is null and "org_security_setting_changes"."decided_at" is null)),
	CONSTRAINT "org_security_setting_changes_after_chk" CHECK ("org_security_setting_changes"."lifetime_after" between 1 and 12 and "org_security_setting_changes"."idle_after" between 15 and 480)
);
--> statement-breakpoint
CREATE TABLE "org_security_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"mfa_required_for_all" boolean DEFAULT false NOT NULL,
	"session_lifetime_hours" integer DEFAULT 12 NOT NULL,
	"idle_timeout_minutes" integer DEFAULT 480 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "org_security_settings_lifetime_chk" CHECK ("org_security_settings"."session_lifetime_hours" between 1 and 12),
	CONSTRAINT "org_security_settings_idle_chk" CHECK ("org_security_settings"."idle_timeout_minutes" between 15 and 480)
);
--> statement-breakpoint
ALTER TABLE "org_security_setting_changes" ADD CONSTRAINT "org_security_setting_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_security_setting_changes" ADD CONSTRAINT "org_security_setting_changes_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_security_setting_changes" ADD CONSTRAINT "org_security_setting_changes_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_security_settings" ADD CONSTRAINT "org_security_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_security_settings" ADD CONSTRAINT "org_security_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_security_setting_changes_pending_unq" ON "org_security_setting_changes" USING btree ("organization_id") WHERE "org_security_setting_changes"."status" = 'pending';
--> statement-breakpoint
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_security_settings', 'org_security_setting_changes'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
  END LOOP;
END $$;--> statement-breakpoint
-- Tenancy (the 0154 pattern, as journal_source_reviews): RLS and the tenant policy, for any reader that ever reads these
-- as the application — which holds nothing on them today (revoked above); the identity layer reads them as the owner.
ALTER TABLE public.org_security_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON public.org_security_settings;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.org_security_settings
  USING ( (organization_id)::text = current_setting('app.current_org_id', true) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true) );--> statement-breakpoint
ALTER TABLE public.org_security_setting_changes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON public.org_security_setting_changes;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.org_security_setting_changes
  USING ( (organization_id)::text = current_setting('app.current_org_id', true) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true) );--> statement-breakpoint
-- 🔴 THE REQUEST'S OWN RULES (the 0151 pattern): what was asked is never rewritten; a decision is made once, by the
-- person acting (the connection's declared actor); an APPROVAL is a usable admin of the organization who is NOT the
-- requester; a rejection is the requester's or a usable admin's.
CREATE OR REPLACE FUNCTION org_security_setting_change_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  acting integer := (nullif(current_setting('app.current_user_id', true), ''))::integer;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.mfa_before IS DISTINCT FROM OLD.mfa_before OR NEW.mfa_after IS DISTINCT FROM OLD.mfa_after
     OR NEW.lifetime_before IS DISTINCT FROM OLD.lifetime_before OR NEW.lifetime_after IS DISTINCT FROM OLD.lifetime_after
     OR NEW.idle_before IS DISTINCT FROM OLD.idle_before OR NEW.idle_after IS DISTINCT FROM OLD.idle_after THEN
    RAISE EXCEPTION 'a security-settings request is never rewritten'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'security_settings_change_fixed';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'this security-settings request was already decided'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'security_settings_change_decided';
  END IF;
  IF NEW.status = 'pending' THEN RETURN NEW; END IF;
  IF acting IS NULL OR NEW.decided_by IS DISTINCT FROM acting THEN
    RAISE EXCEPTION 'a security-settings decision is recorded for the person acting'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'security_settings_change_actor';
  END IF;
  IF NEW.status = 'approved' THEN
    IF NEW.decided_by = OLD.requested_by THEN
      RAISE EXCEPTION 'the admin who asked for a weaker security setting does not approve it: a second admin does'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'security_settings_second_admin';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM org_usable_admin_ids(NEW.organization_id) a WHERE a = NEW.decided_by) THEN
      RAISE EXCEPTION 'only an admin of this organisation approves a security-settings change'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'security_settings_second_admin';
    END IF;
  ELSIF NEW.decided_by <> OLD.requested_by
        AND NOT EXISTS (SELECT 1 FROM org_usable_admin_ids(NEW.organization_id) a WHERE a = NEW.decided_by) THEN
    RAISE EXCEPTION 'only an admin, or the person who asked, rejects a security-settings change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'security_settings_second_admin';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS org_security_setting_change_guard ON public.org_security_setting_changes;--> statement-breakpoint
CREATE TRIGGER org_security_setting_change_guard BEFORE UPDATE ON public.org_security_setting_changes
  FOR EACH ROW EXECUTE FUNCTION org_security_setting_change_guard();--> statement-breakpoint
-- 🔴 THE DUAL CONTROL ITSELF, AT THE WRITE: in an organization with two or more usable admins, a WEAKENING of the
-- settings (two-step verification for everyone turned off; a longer session lifetime; a longer idle timeout) is refused
-- unless a request for exactly this change was APPROVED IN THIS TRANSACTION by the person acting. A strengthening, and
-- any change in an organization with one admin, needs no second person. An INSERT cannot weaken: the defaults a missing
-- row stands for are the weakest values the CHECKs allow.
CREATE OR REPLACE FUNCTION org_security_settings_dual_control() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  acting integer := (nullif(current_setting('app.current_user_id', true), ''))::integer;
  weaker boolean;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'org_security_settings: a row never moves to another organization'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'security_settings_org_fixed';
  END IF;
  weaker := (OLD.mfa_required_for_all AND NOT NEW.mfa_required_for_all)
         OR NEW.session_lifetime_hours > OLD.session_lifetime_hours
         OR NEW.idle_timeout_minutes > OLD.idle_timeout_minutes;
  IF NOT weaker OR org_usable_admin_count(NEW.organization_id) < 2 THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM org_security_setting_changes r
      WHERE r.organization_id = NEW.organization_id AND r.status = 'approved' AND r.decided_at = now()
        AND r.decided_by IS NOT DISTINCT FROM acting
        AND r.mfa_before = OLD.mfa_required_for_all AND r.mfa_after = NEW.mfa_required_for_all
        AND r.lifetime_before = OLD.session_lifetime_hours AND r.lifetime_after = NEW.session_lifetime_hours
        AND r.idle_before = OLD.idle_timeout_minutes AND r.idle_after = NEW.idle_timeout_minutes) THEN
    RAISE EXCEPTION 'in an organisation with two or more admins, a weaker security setting needs a second admin''s approval — record it as a request'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'security_settings_dual_control';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS org_security_settings_dual_control ON public.org_security_settings;--> statement-breakpoint
CREATE TRIGGER org_security_settings_dual_control BEFORE UPDATE ON public.org_security_settings
  FOR EACH ROW EXECUTE FUNCTION org_security_settings_dual_control();
