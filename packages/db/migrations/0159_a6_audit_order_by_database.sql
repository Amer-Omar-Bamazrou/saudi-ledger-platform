-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 audit A6 (G25, "sequence or chain") — THE AUDIT TRAIL'S TIME AND
-- ORDER ARE THE DATABASE'S.
--
-- 0132 took the ACTOR out of the writer's hands. The TIME was still a column
-- DEFAULT: a writer holding INSERT could name its own `created_at`, so a row
-- written today could claim 2020 (or 2030) and read as history in that place.
-- And nothing ordered rows that share one transaction's `now()`.
--
-- From here, a BEFORE INSERT trigger sets, on every row, whatever was supplied:
--   created_at := now()                          — the transaction's time;
--   seq        := nextval('audit_logs_seq_seq')  — the database's own order.
-- The function is SECURITY DEFINER and the app role is granted nothing on the
-- sequence: only the trigger draws from it. Readers order by `seq`.
--
-- Rows written before this migration keep `seq` NULL — they are not renumbered
-- (the table is append-only; history is not rewritten). Readers put them after
-- every sequenced row, by their own time.
--
-- 🔴 THE ONLY BYPASS is `session_replication_role = replica` (owner-only), as
-- 0132 documents for its triggers: the trigger is ordinary (ENABLE ORIGIN), so
-- a test fixture can still plant history. Its name sorts last (`zz_…`), so it
-- runs after 0132's actor trigger and nothing after it re-sets either column.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SEQUENCE "audit_logs_seq_seq" AS bigint;--> statement-breakpoint
REVOKE ALL ON SEQUENCE "audit_logs_seq_seq" FROM PUBLIC;--> statement-breakpoint
-- Named explicitly: a hosted project's default privileges may grant new sequences to these roles (CLAUDE.md §4).
REVOKE ALL ON SEQUENCE "audit_logs_seq_seq" FROM anon, authenticated, service_role;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "seq" bigint;--> statement-breakpoint
ALTER SEQUENCE "audit_logs_seq_seq" OWNED BY "audit_logs"."seq";--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_seq_unq" ON "audit_logs" USING btree ("seq");--> statement-breakpoint

CREATE OR REPLACE FUNCTION zz_audit_logs_database_time_and_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.created_at := now();
  NEW.seq := nextval('audit_logs_seq_seq');
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION zz_audit_logs_database_time_and_order() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER zz_audit_logs_database_time_and_order BEFORE INSERT ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION zz_audit_logs_database_time_and_order();
