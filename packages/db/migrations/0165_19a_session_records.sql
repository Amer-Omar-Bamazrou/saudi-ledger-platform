-- 🔴 Phase 19A slice 1 (owner approval of the Phase 19 proposal v2, 2026-11-17): 19.4 session records, 19.5 their
-- revocation, 19.8 the request id on every security event.
--
-- session_records: ONE row per sign-in — what a person sees as "a session" and ends. Identity layer beside
-- user_sessions: no organization, no RLS, OWNER-ONLY (revoked explicitly below). It never holds the session id (a
-- bearer credential, which stays in user_sessions); the session carries this row's id instead.
CREATE TABLE "session_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"kind" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" varchar(45),
	"client" varchar(80),
	"ended_at" timestamp with time zone,
	"ended_by_user_id" integer,
	"end_reason" varchar(30),
	CONSTRAINT "session_records_kind_chk" CHECK ("session_records"."kind" in ('sign_in', 'signup', 'invitation')),
	CONSTRAINT "session_records_end_chk" CHECK (("session_records"."ended_at" is null) = ("session_records"."end_reason" is null)),
	CONSTRAINT "session_records_reason_chk" CHECK ("session_records"."end_reason" is null or "session_records"."end_reason" in ('signed_out', 'ended_by_self', 'ended_by_admin', 'ended_by_operator'))
);
--> statement-breakpoint
ALTER TABLE "security_audit_logs" ADD COLUMN "request_id" varchar(64);--> statement-breakpoint
ALTER TABLE "session_records" ADD CONSTRAINT "session_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_records" ADD CONSTRAINT "session_records_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_records_user_idx" ON "session_records" USING btree ("user_id","created_at");--> statement-breakpoint
-- 🔴 OWNER-ONLY: the identity layer reads and writes it on the owner connection; the application's role holds
-- NOTHING. Supabase's default privileges grant every new table to these roles, TRUNCATE included (CLAUDE.md §4).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.session_records FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.session_records FROM PUBLIC;
END $$;--> statement-breakpoint
-- 🔴 WHO, HOW, WHEN AND FROM WHERE A SESSION WAS OPENED ARE FIXED, AND AN ENDED SESSION STAYS ENDED — for every role,
-- the owner included. While open, only last_seen_at moves, and ending writes ended_at/end_reason/ended_by once. The one
-- change allowed on an ended row is the ON DELETE SET NULL of ended_by_user_id when that account is deleted (tests
-- only: the product never deletes an account).
CREATE OR REPLACE FUNCTION session_records_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.ip_address IS DISTINCT FROM OLD.ip_address
     OR NEW.client IS DISTINCT FROM OLD.client THEN
    RAISE EXCEPTION 'session_records: who, how, when and from where session % was opened are not rewritten', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'session_records_identity_fixed';
  END IF;
  IF OLD.ended_at IS NOT NULL AND (
       NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.end_reason IS DISTINCT FROM OLD.end_reason
       OR NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at
       OR (NEW.ended_by_user_id IS DISTINCT FROM OLD.ended_by_user_id AND NEW.ended_by_user_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'session record % has ended: an ended session is never re-opened or re-attributed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'session_records_ended_is_final';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS session_records_guard ON public.session_records;--> statement-breakpoint
CREATE TRIGGER session_records_guard BEFORE UPDATE ON public.session_records
  FOR EACH ROW EXECUTE FUNCTION session_records_guard();
