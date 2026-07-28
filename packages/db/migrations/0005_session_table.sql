-- M6 · Session store table for connect-pg-simple.
--
-- Previously the API relied on `createTableIfMissing: true`, which reads the
-- library's `table.sql` at runtime — a path that fails in the esbuild bundle
-- (the asset isn't bundled), so a fresh database could not create the session
-- table and login 500'd. This migration creates the table up front (matching
-- connect-pg-simple's schema) so `createTableIfMissing` can be turned off.
--
-- Owned/accessed by the app's login role via a dedicated session pool; it is
-- NOT tenant-scoped (no RLS, no grants to the app role). Idempotent so it is
-- safe on databases where the table was already auto-created.

CREATE TABLE IF NOT EXISTS "user_sessions" (
  "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "user_sessions" ("expire");
