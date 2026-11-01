-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 R-1 — DR-27's expiry, 24 hours (owner 2026-11-01; register §11.82–§11.83).
--  · users.break_glass_expires_at: when the password is an operator's
--    break-glass, the moment it stops signing in. NULL for every other
--    password — an admin's reset has no expiry.
--  · Every existing account reads NULL ("no expiry"): nothing is known about
--    when a password before this column was set, and no account is locked
--    out by the migration.
-- No existing value is changed. The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'break_glass_expires_at') THEN
    RAISE EXCEPTION 'pre-check REFUSED: users.break_glass_expires_at already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: users.break_glass_expires_at does not exist yet';
END $$;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "break_glass_expires_at" timestamp with time zone;
