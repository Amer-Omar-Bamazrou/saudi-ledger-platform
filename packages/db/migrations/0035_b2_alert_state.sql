-- ═══════════════════════════════════════════════════════════════════════════
-- B2 — alert dedupe state (owner-only platform infrastructure)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 🔴 Idempotency is a DB CONSTRAINT, not a scheduling assumption — the same
-- reasoning M12.8 applied to renewal reminders. The alarm job may run on more
-- than one instance and restarts freely; in-memory cooldown state would page
-- twice on every deploy and forget everything on restart, which trains people
-- to ignore the channel.
--
-- One row per CONDITION (`key`), not per occurrence: a stuck outbox is one
-- problem however many documents are in it.
--
-- Owner-only, like the other platform tables: no RLS, no app-role grants, and
-- the Supabase base ALTER DEFAULT PRIVILEGES grants are revoked explicitly
-- (M12.5's lesson — TRUNCATE bypasses RLS and needs no DELETE privilege).
CREATE TABLE IF NOT EXISTS "alert_state" (
  "key"            text PRIMARY KEY,
  "severity"       text NOT NULL,
  "title"          text NOT NULL,
  "first_fired_at" timestamptz NOT NULL DEFAULT now(),
  "last_fired_at"  timestamptz NOT NULL DEFAULT now(),
  "last_sent"      boolean NOT NULL DEFAULT false,
  "fire_count"     integer NOT NULL DEFAULT 1
);--> statement-breakpoint

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "alert_state" FROM %I', r);
    END IF;
  END LOOP;
END $$;
