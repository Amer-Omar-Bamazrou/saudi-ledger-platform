-- ═══════════════════════════════════════════════════════════════════════════
-- B4 hotfix: INSERT needs USAGE on the serial columns' SEQUENCES.
--
-- 0046 granted SELECT + INSERT on the tables and the local Supabase stack
-- passed — its default privileges cover new sequences. CI's plain Postgres
-- does not, so every pay() there failed with 42501 while the same suite was
-- green locally. (The recurring/captured tables never hit this because they
-- use uuid primary keys — no sequence.) The M14 re-check note in CLAUDE.md
-- §5 exists for exactly this class: grants measured per environment, never
-- assumed from the schema.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT USAGE, SELECT ON SEQUENCE invoice_payments_id_seq TO authenticated;
    GRANT USAGE, SELECT ON SEQUENCE bill_payments_id_seq TO authenticated;
  END IF;
END $$;--> statement-breakpoint
