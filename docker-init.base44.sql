-- Base44 dev init: create the non-owner `authenticated` role the app drops to
-- per request so PostgreSQL Row-Level Security is enforced (see docs/local-setup.md
-- §7, "role 'authenticated' does not exist"). Supabase CLI creates this
-- automatically; plain Postgres does not.
CREATE ROLE authenticated NOLOGIN;
GRANT authenticated TO postgres;
