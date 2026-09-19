ALTER TABLE "customers" ADD COLUMN "source_system" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "source_system" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "migration_batches" ADD COLUMN "obe_residual_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_source_identity_unq" ON "customers" USING btree ("organization_id","source_system","source_id") WHERE source_system IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_source_identity_unq" ON "vendors" USING btree ("organization_id","source_system","source_id") WHERE source_system IS NOT NULL;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- Batch 1C Phase 3 — commit and REVERSAL (decision pack §15.6 "Safety").
--
-- Master-data provenance: customers/vendors carry (source_system, source_id),
-- unique per organisation as a pair, written at commit; a re-import of the
-- same source id resolves to the same record.
--
-- Immutability, refined for the one act a committed migration admits besides
-- reversal itself: UNLINKING. A reversal mirrors the opening journal through
-- the seam, then removes the opening items and deposits it created (never
-- issued documents — no ICV, hash, QR or ZATCA record ever existed for them;
-- the immutable staging rows and the audit record remain the account of what
-- was migrated). Removing them needs their `resolved_*` links cleared first,
-- so the trigger allows an UPDATE on a committed batch's staging row when
-- the ONLY change is a resolved_* column becoming NULL. Everything else on a
-- committed or reversed batch's rows stays refused.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION refuse_committed_migration_change() RETURNS trigger AS $$
DECLARE
  b_status text;
  old_j jsonb;
  new_j jsonb;
  resolved_cols text[] := ARRAY['resolved_category_id', 'resolved_customer_id', 'resolved_vendor_id', 'resolved_invoice_id', 'resolved_bill_id', 'resolved_payment_id'];
  c text;
  unlink_only boolean;
BEGIN
  IF TG_TABLE_NAME = 'migration_batches' THEN
    IF OLD.status IN ('committed', 'reversed') THEN
      IF NEW.status NOT IN ('committed', 'reversed')
         OR NEW.source_system IS DISTINCT FROM OLD.source_system
         OR NEW.cutover_date IS DISTINCT FROM OLD.cutover_date
         OR NEW.opening_date IS DISTINCT FROM OLD.opening_date
         OR NEW.opening_journal_entry_id IS DISTINCT FROM OLD.opening_journal_entry_id
         OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
         OR NEW.committed_at IS DISTINCT FROM OLD.committed_at
         OR NEW.committed_by IS DISTINCT FROM OLD.committed_by
         OR NEW.obe_residual_reason IS DISTINCT FROM OLD.obe_residual_reason
         OR NEW.vat_position IS DISTINCT FROM OLD.vat_position
         OR (OLD.status = 'reversed' AND NEW.status <> 'reversed')
         OR (OLD.clearing_journal_entry_id IS NOT NULL AND NEW.clearing_journal_entry_id IS DISTINCT FROM OLD.clearing_journal_entry_id)
         OR (OLD.reversal_journal_entry_id IS NOT NULL AND NEW.reversal_journal_entry_id IS DISTINCT FROM OLD.reversal_journal_entry_id)
      THEN
        RAISE EXCEPTION 'migration batch % is % and cannot be modified', OLD.id, OLD.status USING ERRCODE = 'check_violation', CONSTRAINT = 'migration_batch_immutable';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO b_status FROM migration_batches WHERE id = COALESCE(NEW.batch_id, OLD.batch_id);
  IF b_status IN ('committed', 'reversed') THEN
    IF TG_OP = 'UPDATE' AND b_status = 'committed' THEN
      old_j := to_jsonb(OLD);
      new_j := to_jsonb(NEW);
      unlink_only := true;
      FOREACH c IN ARRAY resolved_cols LOOP
        IF new_j ? c AND new_j -> c IS DISTINCT FROM old_j -> c AND new_j -> c <> 'null'::jsonb THEN
          unlink_only := false;
        END IF;
        old_j := old_j - c;
        new_j := new_j - c;
      END LOOP;
      IF unlink_only AND old_j = new_j THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'migration batch % is % — staging rows are immutable', COALESCE(NEW.batch_id, OLD.batch_id), b_status USING ERRCODE = 'check_violation', CONSTRAINT = 'migration_rows_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- ── Payments stay APPEND-ONLY, with one construction-level exception ──────
-- D-4 (0074) revoked UPDATE and DELETE on `payments`: the record of money
-- arriving is exactly the row someone would want to quietly fix. A migrated
-- deposit is NOT such a record — it is the migration's reconstruction of a
-- deposit the previous system held, with no cash movement of its own — and
-- a reversal must remove it with the opening position it belongs to. So
-- DELETE is granted, and a trigger refuses it for every row that is not a
-- migration reconstruction (`source = 'opening'`) — the invariant moves from
-- the grant to the row, where it binds every path. UPDATE stays revoked.
GRANT DELETE ON TABLE "payments" TO authenticated;--> statement-breakpoint
CREATE OR REPLACE FUNCTION refuse_payment_delete() RETURNS trigger AS $$
BEGIN
  -- The rule binds the APPLICATION role (RLS-bound). The database owner —
  -- BYPASSRLS, superuser or not — runs fixtures and maintenance and never
  -- serves a request; the same line every RLS policy already draws.
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RETURN OLD;
  END IF;
  IF OLD.source IS DISTINCT FROM 'opening' THEN
    RAISE EXCEPTION 'payment % is append-only: a receipt is never deleted (only a migrated deposit is removed, by the migration''s reversal)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_append_only';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS payments_append_only_trg ON "payments";--> statement-breakpoint
CREATE TRIGGER payments_append_only_trg BEFORE DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION refuse_payment_delete();
