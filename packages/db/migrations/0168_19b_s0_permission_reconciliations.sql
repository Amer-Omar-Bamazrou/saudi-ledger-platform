-- 🔴 Phase 19B S0 (D10, owner 2026-11-21): the record of every change to the `permissions` table.
--
-- PERMISSION_MATRIX (packages/db/src/permissions.ts) is the one definition of the grants. The API refuses to start
-- while the table differs from it, and the reconcile command (packages/db/src/permissionReconcile.ts) is the only
-- writer that makes them agree. Each run that changes something writes one row here: who, when, the environment, the
-- grants added, and every grant removed IN FULL, so `restore` can put a removal back. From this migration on,
-- migrations do not write `permissions` (tests/permission-grant-migration-ratchet.test.ts).
CREATE TABLE "permission_reconciliations" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"environment" text NOT NULL,
	"database_name" text NOT NULL,
	"actor" text NOT NULL,
	"added" jsonb NOT NULL,
	"removed" jsonb NOT NULL,
	"removal_set_hash" text,
	"approval" text,
	"restores_id" integer,
	"matrix_rows" integer NOT NULL,
	CONSTRAINT "permission_reconciliations_kind_chk" CHECK ("permission_reconciliations"."kind" IN ('apply', 'restore')),
	CONSTRAINT "permission_reconciliations_restores_chk" CHECK (("permission_reconciliations"."kind" = 'restore') = ("permission_reconciliations"."restores_id" IS NOT NULL)),
	CONSTRAINT "permission_reconciliations_approval_chk" CHECK ((jsonb_array_length("permission_reconciliations"."removed") > 0 AND "permission_reconciliations"."kind" = 'apply') = ("permission_reconciliations"."approval" IS NOT NULL AND "permission_reconciliations"."removal_set_hash" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "permission_reconciliations" ADD CONSTRAINT "permission_reconciliations_restores_fk" FOREIGN KEY ("restores_id") REFERENCES "public"."permission_reconciliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 🔴 OWNER-ONLY: the reconcile command runs on the owner connection; the application's role holds NOTHING. Supabase's
-- default privileges grant every new table to these roles, TRUNCATE included (CLAUDE.md §4).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.permission_reconciliations FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.permission_reconciliations_id_seq FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.permission_reconciliations FROM PUBLIC;
END $$;--> statement-breakpoint
-- 🔴 APPEND-ONLY, for every role, the owner included: a record of who removed which grant is not rewritten or erased.
CREATE OR REPLACE FUNCTION permission_reconciliations_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'permission_reconciliations is append-only: % refused', TG_OP
    USING ERRCODE = 'check_violation', CONSTRAINT = 'permission_reconciliations_append_only';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS permission_reconciliations_append_only ON public.permission_reconciliations;--> statement-breakpoint
CREATE TRIGGER permission_reconciliations_append_only BEFORE UPDATE OR DELETE ON public.permission_reconciliations
  FOR EACH ROW EXECUTE FUNCTION permission_reconciliations_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS permission_reconciliations_no_truncate ON public.permission_reconciliations;--> statement-breakpoint
CREATE TRIGGER permission_reconciliations_no_truncate BEFORE TRUNCATE ON public.permission_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION permission_reconciliations_append_only();
