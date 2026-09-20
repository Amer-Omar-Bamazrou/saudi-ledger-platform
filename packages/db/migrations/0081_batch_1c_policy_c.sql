CREATE TABLE "migration_deposit_reversals" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"payment_id" integer NOT NULL,
	"batch_id" integer NOT NULL,
	"reversal_journal_entry_id" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "reversed_by_migration_batch_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "replaces_invoice_id" integer;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "reversed_by_migration_batch_id" integer;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "replaces_bill_id" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "replaces_payment_id" integer;--> statement-breakpoint
ALTER TABLE "migration_batches" ADD COLUMN "replaces_batch_id" integer;--> statement-breakpoint
ALTER TABLE "migration_open_items" ADD COLUMN "ledger_document_number" text;--> statement-breakpoint
ALTER TABLE "migration_deposit_reversals" ADD CONSTRAINT "migration_deposit_reversals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_deposit_reversals" ADD CONSTRAINT "migration_deposit_reversals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_deposit_reversals" ADD CONSTRAINT "migration_deposit_reversals_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_deposit_reversals" ADD CONSTRAINT "migration_deposit_reversals_batch_id_migration_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_deposit_reversals" ADD CONSTRAINT "migration_deposit_reversals_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_deposit_reversals_payment_unq" ON "migration_deposit_reversals" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "migration_deposit_reversals_batch_idx" ON "migration_deposit_reversals" USING btree ("batch_id");;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- Batch 1C (2026-09-20) — hand-written tail. POLICY C AT BATCH LEVEL.
-- Decision record: docs/product/batch-1c-migration-opening-balances-decision-pack.md
-- §16.12.1 (accountant A4): a committed migration's accounting records are
-- NEVER deleted; the reversal MARKS; replacements carry NEW Saudi Ledger
-- numbers with provenance; the source number is provenance only.
--
-- 1. Foreign keys for the columns declared as plain integers in Drizzle
--    (circular schema imports): the reversed marker's batch, the
--    replacement links (self-referencing), the batch's predecessor.
-- 2. CHECKs that make the wrong thing inexpressible: the two marker columns
--    move together; a marker or a replacement link exists only on an
--    `is_opening` row (invoices/bills) or a `source = 'opening'` payment; a
--    row never replaces itself; a NON-opening document can never carry the
--    reserved `OPEN-<n>-<n>` number shape (a customer cannot type a number
--    that collides with a replacement's).
-- 3. Trigger `refuse_opening_reversal_marker` (invoices, bills): a row is
--    never INSERTED reversed; a marker is set ONCE, only on an opening row,
--    only by the batch whose staging row resolves to this document, only
--    while that batch is `committed`; a reversed row is FROZEN (no column
--    changes at all — a correction is a new record, never an edit); a
--    replacement link points at a reversed opening row of the same table.
-- 4. Trigger `refuse_payment_replacement` (payments, INSERT — UPDATE stays
--    revoked): `replaces_payment_id` points at an opening deposit that HAS a
--    superseding reversal record.
-- 5. Trigger `refuse_deposit_reversal` (migration_deposit_reversals, INSERT):
--    the payment is an opening deposit that this batch's staging created.
--    The table is append-only at the grant (SELECT + INSERT).
-- 6. `payments` returns to the 0074 posture: DELETE REVOKED from the app
--    role; the 0079 row trigger that admitted deleting opening deposits is
--    dropped with its function. Nothing deletes a payment.
-- 7. `refuse_committed_migration_change()` is STRICT again: the 0079
--    unlink-only exception is withdrawn (a staging row keeps pointing at the
--    reversed row it produced); `replaces_batch_id` is pinned on a committed
--    batch alongside the other identity columns.
-- 8. Tenant isolation, grants and the owner-only REVOKE pattern for the new
--    table, exactly as 0077 did for the five staging tables.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_reversed_by_batch_fk" FOREIGN KEY ("reversed_by_migration_batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_replaces_invoice_fk" FOREIGN KEY ("replaces_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_reversed_by_batch_fk" FOREIGN KEY ("reversed_by_migration_batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_replaces_bill_fk" FOREIGN KEY ("replaces_bill_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_replaces_payment_fk" FOREIGN KEY ("replaces_payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_batches" ADD CONSTRAINT "migration_batches_replaces_batch_fk" FOREIGN KEY ("replaces_batch_id") REFERENCES "public"."migration_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_reversed_marker_pair_chk" CHECK ((reversed_at IS NULL) = (reversed_by_migration_batch_id IS NULL));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_reversed_opening_only_chk" CHECK (reversed_at IS NULL OR is_opening);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_replaces_opening_only_chk" CHECK (replaces_invoice_id IS NULL OR (is_opening AND replaces_invoice_id <> id));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_reserved_number_chk" CHECK (is_opening OR invoice_number !~ '^OPEN-[0-9]+-[0-9]+$');--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_reversed_marker_pair_chk" CHECK ((reversed_at IS NULL) = (reversed_by_migration_batch_id IS NULL));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_reversed_opening_only_chk" CHECK (reversed_at IS NULL OR is_opening);--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_replaces_opening_only_chk" CHECK (replaces_bill_id IS NULL OR (is_opening AND replaces_bill_id <> id));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_reserved_number_chk" CHECK (is_opening OR bill_number !~ '^OPEN-[0-9]+-[0-9]+$');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_replaces_opening_only_chk" CHECK (replaces_payment_id IS NULL OR (source = 'opening' AND replaces_payment_id <> id));--> statement-breakpoint
ALTER TABLE "migration_batches" ADD CONSTRAINT "migration_batches_replaces_self_chk" CHECK (replaces_batch_id IS NULL OR replaces_batch_id <> id);--> statement-breakpoint

CREATE OR REPLACE FUNCTION refuse_opening_reversal_marker() RETURNS trigger AS $$
DECLARE
  b_status text;
  linked boolean;
  target_reversed boolean;
  old_j jsonb;
  new_j jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reversed_at IS NOT NULL OR NEW.reversed_by_migration_batch_id IS NOT NULL THEN
      RAISE EXCEPTION 'a document is never created already reversed' USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_reversal_marker';
    END IF;
  ELSE
    IF OLD.reversed_at IS NOT NULL THEN
      -- FROZEN: a reversed opening item is history. Nothing on it moves.
      old_j := to_jsonb(OLD); new_j := to_jsonb(NEW);
      IF old_j <> new_j THEN
        RAISE EXCEPTION '% % is a reversed opening item and is frozen: a correction is a new record, never an edit (Policy C, pack §16.12.1)', TG_TABLE_NAME, OLD.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_reversed_frozen';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.reversed_at IS NOT NULL THEN
      IF NOT NEW.is_opening THEN
        RAISE EXCEPTION '% % is not an opening item; only an opening item can be marked reversed by a migration', TG_TABLE_NAME, NEW.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_reversal_marker';
      END IF;
      -- Only the batch whose staging row PRODUCED this row may mark it, and only while that batch is committed.
      IF TG_TABLE_NAME = 'invoices' THEN
        SELECT EXISTS (SELECT 1 FROM migration_open_items o WHERE o.batch_id = NEW.reversed_by_migration_batch_id AND o.resolved_invoice_id = NEW.id) INTO linked;
      ELSE
        SELECT EXISTS (SELECT 1 FROM migration_open_items o WHERE o.batch_id = NEW.reversed_by_migration_batch_id AND o.resolved_bill_id = NEW.id) INTO linked;
      END IF;
      SELECT status INTO b_status FROM migration_batches WHERE id = NEW.reversed_by_migration_batch_id;
      IF NOT coalesce(linked, false) OR b_status IS DISTINCT FROM 'committed' THEN
        RAISE EXCEPTION '% % can only be marked reversed by the committed migration batch that created it (batch %, status %)', TG_TABLE_NAME, NEW.id, NEW.reversed_by_migration_batch_id, coalesce(b_status, 'missing')
          USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_reversal_marker';
      END IF;
    END IF;
  END IF;
  -- A replacement link points at a REVERSED opening row of the same table.
  IF TG_TABLE_NAME = 'invoices' THEN
    IF NEW.replaces_invoice_id IS NOT NULL THEN
      SELECT (i.is_opening AND i.reversed_at IS NOT NULL) INTO target_reversed FROM invoices i WHERE i.id = NEW.replaces_invoice_id;
      IF NOT coalesce(target_reversed, false) THEN
        RAISE EXCEPTION 'invoice % can only replace a REVERSED opening invoice (target %)', NEW.id, NEW.replaces_invoice_id USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_replacement_target';
      END IF;
    END IF;
  ELSE
    IF NEW.replaces_bill_id IS NOT NULL THEN
      SELECT (b.is_opening AND b.reversed_at IS NOT NULL) INTO target_reversed FROM bills b WHERE b.id = NEW.replaces_bill_id;
      IF NOT coalesce(target_reversed, false) THEN
        RAISE EXCEPTION 'bill % can only replace a REVERSED opening bill (target %)', NEW.id, NEW.replaces_bill_id USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_replacement_target';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS invoices_opening_reversal_marker_trg ON "invoices";--> statement-breakpoint
CREATE TRIGGER invoices_opening_reversal_marker_trg BEFORE INSERT OR UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION refuse_opening_reversal_marker();--> statement-breakpoint
DROP TRIGGER IF EXISTS bills_opening_reversal_marker_trg ON "bills";--> statement-breakpoint
CREATE TRIGGER bills_opening_reversal_marker_trg BEFORE INSERT OR UPDATE ON "bills" FOR EACH ROW EXECUTE FUNCTION refuse_opening_reversal_marker();--> statement-breakpoint

CREATE OR REPLACE FUNCTION refuse_payment_replacement() RETURNS trigger AS $$
DECLARE ok boolean;
BEGIN
  IF NEW.replaces_payment_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM payments p JOIN migration_deposit_reversals r ON r.payment_id = p.id
       WHERE p.id = NEW.replaces_payment_id AND p.source = 'opening'
    ) INTO ok;
    IF NOT coalesce(ok, false) THEN
      RAISE EXCEPTION 'a payment can only replace a REVERSED opening deposit (target %)', NEW.replaces_payment_id USING ERRCODE = 'check_violation', CONSTRAINT = 'opening_replacement_target';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS payments_replacement_trg ON "payments";--> statement-breakpoint
CREATE TRIGGER payments_replacement_trg BEFORE INSERT ON "payments" FOR EACH ROW EXECUTE FUNCTION refuse_payment_replacement();--> statement-breakpoint

CREATE OR REPLACE FUNCTION refuse_deposit_reversal() RETURNS trigger AS $$
DECLARE ok boolean; b_status text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM payments p JOIN migration_advances a ON a.resolved_payment_id = p.id
     WHERE p.id = NEW.payment_id AND p.source = 'opening' AND a.batch_id = NEW.batch_id
  ) INTO ok;
  SELECT status INTO b_status FROM migration_batches WHERE id = NEW.batch_id;
  IF NOT coalesce(ok, false) OR b_status IS DISTINCT FROM 'committed' THEN
    RAISE EXCEPTION 'deposit % can only be reversed by the committed migration batch that created it (batch %, status %)', NEW.payment_id, NEW.batch_id, coalesce(b_status, 'missing')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deposit_reversal_source';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS migration_deposit_reversals_source_trg ON "migration_deposit_reversals";--> statement-breakpoint
CREATE TRIGGER migration_deposit_reversals_source_trg BEFORE INSERT ON "migration_deposit_reversals" FOR EACH ROW EXECUTE FUNCTION refuse_deposit_reversal();--> statement-breakpoint

-- 6. payments: nothing deletes a payment. Back to the 0074 posture.
DROP TRIGGER IF EXISTS payments_append_only_trg ON "payments";--> statement-breakpoint
DROP FUNCTION IF EXISTS refuse_payment_delete();--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE DELETE ON TABLE public.payments FROM authenticated';
  END IF;
END $$;--> statement-breakpoint

-- 7. Committed staging is immutable again without exception; replaces_batch_id is pinned.
CREATE OR REPLACE FUNCTION refuse_committed_migration_change() RETURNS trigger AS $$
DECLARE b_status text;
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
         OR NEW.vat_position IS DISTINCT FROM OLD.vat_position
         OR NEW.replaces_batch_id IS DISTINCT FROM OLD.replaces_batch_id
         OR (OLD.status = 'reversed' AND NEW.status <> 'reversed')
         OR (OLD.reversal_journal_entry_id IS NOT NULL AND NEW.reversal_journal_entry_id IS DISTINCT FROM OLD.reversal_journal_entry_id)
      THEN
        RAISE EXCEPTION 'migration batch % is % and cannot be modified', OLD.id, OLD.status USING ERRCODE = 'check_violation', CONSTRAINT = 'migration_batch_immutable';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO b_status FROM migration_batches WHERE id = COALESCE(NEW.batch_id, OLD.batch_id);
  IF b_status IN ('committed', 'reversed') THEN
    -- Resolved-id and ledger-number columns are written INSIDE the commit
    -- transaction, while the batch is still 'validated'; after commit nothing
    -- on a staging row moves — the links stay pointing at the reversed rows.
    RAISE EXCEPTION 'migration batch % is % — staging rows are immutable', COALESCE(NEW.batch_id, OLD.batch_id), b_status USING ERRCODE = 'check_violation', CONSTRAINT = 'migration_rows_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- 8. The new table: tenant isolation, SELECT + INSERT only, owner-only REVOKE.
ALTER TABLE "migration_deposit_reversals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.migration_deposit_reversals
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "migration_deposit_reversals" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "migration_deposit_reversals_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.migration_deposit_reversals FROM %I', r);
    END IF;
  END LOOP;
END $$;
