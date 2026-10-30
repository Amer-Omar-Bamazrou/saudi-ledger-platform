-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 H-15 — DR-06 part 1 and DR-27 (2026-10-27; register §11.66).
--  · users.password_change_required: true while the account's password is one
--    someone ELSE set (an admin's create or reset, an operator's break-glass);
--    a signed-in session then reaches only the way to change it.
--  · Every existing account starts false: nothing is known about who set a
--    password before this column existed, and no account is locked out by it.
-- No existing value is changed. The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password_change_required') THEN
    RAISE EXCEPTION 'pre-check REFUSED: users.password_change_required already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: users.password_change_required does not exist yet';
END $$;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_change_required" boolean DEFAULT false NOT NULL;
