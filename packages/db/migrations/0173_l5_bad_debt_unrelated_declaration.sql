-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 L5 (owner, 2026-11-25) — VAT IR Art. 40(7)(b): the customer is not a related party, a STATED declaration made at
-- the bad-debt write-off until the platform records related parties: who and when, on the invoice.
--  · Two nullable columns; set together by the write-off (badDebtService.writeOffWithRelief).
--  · CHECK (hand-written): a declarer is never recorded without the time.
-- No existing row is read or changed: a relief recorded before the rule, and a migrated relief, keep NULL.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "invoices" ADD COLUMN "bad_debt_relief_unrelated_declared_by" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "bad_debt_relief_unrelated_declared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_bad_debt_unrelated_declaration_chk" CHECK (
  "bad_debt_relief_unrelated_declared_by" IS NULL OR "bad_debt_relief_unrelated_declared_at" IS NOT NULL
);
--> statement-breakpoint
-- The issued-invoice freeze (0125) lets the write-off move only the listed columns: the declaration joins the
-- Art. 40(7) facts it already lists. The function is 0125's, verbatim, with the two columns added to `mutable`.
CREATE OR REPLACE FUNCTION guard_issued_invoice() RETURNS trigger AS $$
DECLARE
  -- The columns a writer may still move after the issuing write (header above).
  mutable constant text[] := ARRAY[
    'status', 'qr_code', 'paid_amount', 'paid_at', 'credited_amount', 'written_off_amount',
    'bad_debt_relief_claimed_on', 'bad_debt_relief_vat_amount', 'bad_debt_relief_return_period',
    'bad_debt_relief_certificate_ref', 'bad_debt_relief_legal_ref', 'bad_debt_relief_source',
    'bad_debt_relief_journal_entry_id', 'bad_debt_relief_unrelated_declared_by', 'bad_debt_relief_unrelated_declared_at'];
  o jsonb;
  n jsonb;
  changed text;
  doc_qr text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Issuance is the issuing UPDATE, never an insert: a row born issued was
    -- issued by nothing. (Opening items are the migration's own, and out of scope.)
    IF NOT NEW.is_opening AND (invoice_is_issued(NEW.status, NEW.is_opening) OR NEW.invoice_hash IS NOT NULL) THEN
      RAISE EXCEPTION 'an invoice cannot be inserted already issued (status %, hash %): it is issued only by approval',
        NEW.status, CASE WHEN NEW.invoice_hash IS NULL THEN 'none' ELSE 'set' END
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_inserted_issued';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT invoice_is_issued(OLD.status, OLD.is_opening) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice % is issued and cannot be deleted; it is corrected by a new document', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_issued_frozen';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status IN ('sent', 'paid') AND NEW.status IN ('sent', 'paid')) THEN
    RAISE EXCEPTION 'invoice % is issued: its status can move only between sent and paid (got % to %)', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_issued_frozen';
  END IF;

  IF NEW.qr_code IS DISTINCT FROM OLD.qr_code THEN
    -- Read as the writer: a document the writer cannot see reads as absent,
    -- and the write is refused (fail closed, the 0121 posture).
    SELECT d.qr_code INTO doc_qr FROM einvoice_documents d WHERE d.invoice_id = OLD.id;
    IF doc_qr IS NULL OR NEW.qr_code IS DISTINCT FROM doc_qr THEN
      RAISE EXCEPTION 'invoice % is issued: its QR can change only to the QR of its own signed e-invoice document', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_issued_frozen';
    END IF;
  END IF;

  o := to_jsonb(OLD) - mutable;
  n := to_jsonb(NEW) - mutable;
  IF n IS DISTINCT FROM o THEN
    SELECT string_agg(k, ', ' ORDER BY k) INTO changed
      FROM (SELECT key AS k FROM jsonb_each(n) WHERE o -> key IS DISTINCT FROM n -> key) c;
    RAISE EXCEPTION 'invoice % is issued: % cannot change; it is corrected by a new document', OLD.id, changed
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_issued_frozen';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
