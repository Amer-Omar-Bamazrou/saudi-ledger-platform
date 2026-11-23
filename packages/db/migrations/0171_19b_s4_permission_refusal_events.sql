-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 19B S4 (v4 §8, D6) — THE REFUSAL EVENT: who tried to take what, and was refused
--    (a refused export, schedule, schedule run, delivery, or field write).
--  · No column can hold a value: the fields are named, never their contents.
--  · OWNER-ONLY: the application's roles hold nothing (the security_audit_logs
--    pattern); it is written on the owner connection, outside the refused
--    request's transaction.
--  · APPEND-ONLY for every role, the owner included (0132's function); replica
--    mode is the only bypass, as for the audit tables.
--  · Its time is the database's (0159's rule for audit rows).
-- A new table; no existing row is read or changed.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE "permission_refusal_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" varchar(64),
	"actor_user_id" integer,
	"organization_id" uuid NOT NULL,
	"company_id" uuid,
	"action" varchar(32) NOT NULL,
	"resource" varchar(128) NOT NULL,
	"refusal_code" varchar(64) NOT NULL,
	"field_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"field_classes" text[] DEFAULT '{}'::text[] NOT NULL,
	"recipient_user_id" integer,
	CONSTRAINT "permission_refusal_events_action_chk" CHECK ("permission_refusal_events"."action" in ('export', 'schedule', 'schedule_run', 'deliver', 'field_write'))
);
--> statement-breakpoint
ALTER TABLE "permission_refusal_events" ADD CONSTRAINT "permission_refusal_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_refusal_events" ADD CONSTRAINT "permission_refusal_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_refusal_events" ADD CONSTRAINT "permission_refusal_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_refusal_events" ADD CONSTRAINT "permission_refusal_events_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "permission_refusal_events_org_idx" ON "permission_refusal_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
-- 🔴 OWNER-ONLY: Supabase's default privileges grant every new table to these roles, TRUNCATE included (CLAUDE.md §4).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.permission_refusal_events FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.permission_refusal_events_id_seq FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.permission_refusal_events FROM PUBLIC;
END $$;--> statement-breakpoint
-- 🔴 The time is the database's: a writer cannot name when a refusal happened.
CREATE OR REPLACE FUNCTION permission_refusal_events_time() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.occurred_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER permission_refusal_events_time BEFORE INSERT ON "permission_refusal_events" FOR EACH ROW EXECUTE FUNCTION permission_refusal_events_time();--> statement-breakpoint
CREATE TRIGGER zz_permission_refusal_events_append_only BEFORE UPDATE OR DELETE ON "permission_refusal_events" FOR EACH ROW EXECUTE FUNCTION zz_audit_append_only();--> statement-breakpoint
CREATE TRIGGER zz_permission_refusal_events_no_truncate BEFORE TRUNCATE ON "permission_refusal_events" FOR EACH STATEMENT EXECUTE FUNCTION zz_audit_append_only();
