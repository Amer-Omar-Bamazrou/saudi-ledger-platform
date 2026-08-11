-- ═══════════════════════════════════════════════════════════════════════════
-- M14 — revoke TRUNCATE / REFERENCES / TRIGGER from the app roles, everywhere
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 🔴 TRUNCATE IS NOT SUBJECT TO ROW-LEVEL SECURITY.
--
-- Unlike DELETE, a TRUNCATE is not filtered by the `tenant_isolation` policy. So
-- a SQL-injection flaw in any of the ~18 business domains — or a compromised app
-- role — could erase EVERY tenant's rows from a table in one statement, with RLS
-- looking on. That is the difference between a tenant-scoped incident and a
-- platform-wide one.
--
-- These grants were never written by our migrations. They come from Supabase's
-- base `ALTER DEFAULT PRIVILEGES`, which hands REFERENCES, TRIGGER and TRUNCATE
-- to anon/authenticated/service_role on every newly created table. Measured on
-- the live local stack: **35 tables carried them**, including the "owner-only"
-- identity tables that were assumed to be granted nothing at all.
--
-- Two tables already closed this individually — `zatca_credentials` (M12.5,
-- because destroying signing keys is unrecoverable) and `einvoice_archive`
-- (M12.8, a legal retention obligation). This closes it for everything else.
--
-- ── Why revoking all three is safe ─────────────────────────────────────────
--   TRUNCATE   — nothing in the application truncates anything. Ever.
--   REFERENCES — needed only to CREATE a foreign key pointing at the table.
--                Only migrations do that, and they run as the owner.
--   TRIGGER    — needed only to CREATE a trigger on the table. Owner-only, same.
--
-- The app role keeps exactly what it uses: SELECT/INSERT/UPDATE/DELETE where it
-- had them, and nothing where it had nothing.

DO $$
DECLARE
  r    text;
  tbl  text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    -- CI bootstraps only `authenticated`; a bare REVOKE against a missing role
    -- aborts the migration.
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);

    FOR tbl IN
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
    LOOP
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', tbl, r);
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Stop it coming back on the NEXT table someone creates
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The REVOKE above fixes today. Without this, the very next `CREATE TABLE`
-- silently re-grants all three from Supabase's defaults, and we are back where
-- we started — which is exactly how 35 tables accumulated them unnoticed.
--
-- This narrows the DEFAULT so future tables never receive them. It does not
-- change what the app role can DO: our migrations grant SELECT/INSERT/UPDATE/
-- DELETE explicitly per table (never `ON ALL TABLES` — see the M4 landmine), so
-- nothing depends on the default for real privileges.
--
-- Applied for the role that owns the schema, which is the role migrations run as
-- and therefore the one whose defaults govern new tables.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM %I', r
    );
  END LOOP;
END $$;
