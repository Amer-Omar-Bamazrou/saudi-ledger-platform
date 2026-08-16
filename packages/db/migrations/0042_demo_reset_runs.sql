-- ═══════════════════════════════════════════════════════════════════════════
-- DEMO — the weekly reset's own record (owner-only platform infrastructure)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 🔴 WHY A TABLE AND NOT A LOG LINE. The demo banner says "sample data, wiped
-- weekly". That is a PROMISE about data deletion made to whoever is looking at
-- the screen. A promise nobody can check is worse than no promise: if the job
-- dies, the banner keeps making the claim, and the longer it runs the more
-- confidently wrong it gets. (Owner: "if it silently fails, 'data is wiped
-- weekly' becomes a false claim on the banner.")
--
-- So the banner does not assert a SCHEDULE — it reports the last run that
-- actually SUCCEEDED, read from here. When there isn't one, it says so.
--
-- This is the same shape as `alert_state` (0035): state in a row, not in a
-- process, so it survives restarts and is true across instances. It is also the
-- reason the reset is a transaction — a run is either recorded as succeeded or
-- it is not, and "not" is visible.
--
-- Owner-only, like the other platform tables: no RLS, no app-role grants, and
-- the Supabase base ALTER DEFAULT PRIVILEGES grants revoked explicitly (M12.5's
-- lesson — TRUNCATE bypasses RLS and needs no DELETE privilege). A table that
-- records wipes must not be writable by the roles a wipe would be aimed at.
CREATE TABLE IF NOT EXISTS "demo_reset_runs" (
  "id"          serial PRIMARY KEY,
  "started_at"  timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "status"      text NOT NULL,
  -- What happened, in words: the table count on success, the refusal or the
  -- error on failure. A failed run that says only "failed" cannot be acted on.
  "detail"      text,
  CONSTRAINT "demo_reset_runs_status_chk"
    CHECK ("status" IN ('running', 'succeeded', 'failed'))
);--> statement-breakpoint

-- The banner's read is "the newest succeeded run", on every page load.
CREATE INDEX IF NOT EXISTS "demo_reset_runs_status_started_idx"
  ON "demo_reset_runs" ("status", "started_at" DESC);--> statement-breakpoint

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "demo_reset_runs" FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE "demo_reset_runs_id_seq" FROM %I', r);
    END IF;
  END LOOP;
END $$;
