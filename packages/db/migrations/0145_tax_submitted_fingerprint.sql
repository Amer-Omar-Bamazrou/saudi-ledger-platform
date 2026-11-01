-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 H-17 — DR-17 (2026-10-27; register §11.68–§11.69; contract G10).
--  · tax_computation_versions.submitted_inputs_fingerprint: the fingerprint of
--    the inputs a version was SUBMITTED on, compared at approval, so an
--    approval covers the figures that were submitted.
--  · Its own column: 0113's transition trigger reserves inputs_fingerprint for
--    the approval. The trigger is NOT changed; it does not name this column.
--  · Every existing version starts NULL (nothing is known about what it was
--    submitted on); the approval does not compare a NULL.
-- No existing value is changed. The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tax_computation_versions' AND column_name = 'submitted_inputs_fingerprint') THEN
    RAISE EXCEPTION 'pre-check REFUSED: tax_computation_versions.submitted_inputs_fingerprint already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: tax_computation_versions.submitted_inputs_fingerprint does not exist yet';
END $$;--> statement-breakpoint
ALTER TABLE "tax_computation_versions" ADD COLUMN "submitted_inputs_fingerprint" text;
