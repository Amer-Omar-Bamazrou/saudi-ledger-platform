-- ═══════════════════════════════════════════════════════════════════════════
-- C1 — the shared rate-limit counter.
--
-- Every limiter used an in-memory, per-process store, so horizontal scaling
-- silently multiplied every limit (2 instances ⇒ double the stated maximum,
-- with nothing reporting it). This table is the shared counter.
--
-- 🔴 NOT tenant data — deliberately. Rate limiting happens BEFORE tenant
-- resolution (it protects login and signup, where no tenant exists yet), so
-- the table carries no `organization_id` and no RLS policy; it is owner-only
-- infrastructure like `alert_state` (M35) and `demo_reset_runs`. The
-- rls-coverage guard exempts it by construction, since it has no
-- organization_id column to protect.
--
-- The app role gets NO grants at all: the limiter runs on the owner pool
-- before any tenant transaction exists.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "rate_limit_hits" (
  "key" text PRIMARY KEY,
  "hits" integer NOT NULL DEFAULT 0,
  "expires_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

-- Lets the periodic sweep (and resetAll) find expired rows without a scan.
CREATE INDEX IF NOT EXISTS "rate_limit_hits_expiry_idx"
  ON "rate_limit_hits" USING btree ("expires_at");--> statement-breakpoint

-- Owner-only: revoke the Supabase default grants (M14's rule — the base
-- ALTER DEFAULT PRIVILEGES re-grants TRUNCATE/REFERENCES/TRIGGER on every
-- CREATE TABLE, and TRUNCATE bypasses RLS).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.rate_limit_hits FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
