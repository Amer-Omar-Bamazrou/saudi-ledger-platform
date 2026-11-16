-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 audit A8 (G29) — AN E-INVOICE DOCUMENT IS INSERTED ONLY IN THE
-- ISSUANCE'S OWN SHAPE.
--
-- 0125 froze a document against UPDATE and DELETE and 0150 against TRUNCATE;
-- INSERT was unguarded and the app role holds it. A writer could queue a
-- document for any invoice — a draft, another company's, one issued long ago —
-- and §5.5 forbids removing it again. The chain head is read from these rows
-- (`invoicesRepository.zatcaPreviousInvoiceHash`), so a forged row would become
-- the next document's previous-invoice hash.
--
-- The issuance writes the document inside the company's sequence lock, right
-- after the invoice is issued and given its ICV and UUID (`invoices.approvable`
-- → `enqueueEInvoice`). So a row is admitted only when its invoice
--   · exists, in the row's own organization AND company;
--   · is issued (`invoice_is_issued`, 0125) and holds an ICV;
--   · carries the row's `zatca_uuid`;
--   · holds its company's NEWEST ICV — the one the issuance just allocated.
-- The function is SECURITY DEFINER so it reads the invoice and its company's
-- ICVs whatever the caller's RLS company scope.
--
-- 🔴 THE ONLY BYPASS is `session_replication_role = replica` (owner-only), the
-- fixtures' established writer (`writeIssuedFixture`); the trigger is ordinary
-- (ENABLE ORIGIN), never ENABLE ALWAYS.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION guard_einvoice_document_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv record;
  newest integer;
BEGIN
  SELECT i.organization_id, i.company_id, i.status, i.is_opening, i.icv, i.zatca_uuid
    INTO inv FROM invoices i WHERE i.id = NEW.invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'e-invoice document for invoice %: there is no such invoice', NEW.invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'einvoice_document_issuance_shape';
  END IF;
  IF inv.organization_id IS DISTINCT FROM NEW.organization_id OR inv.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'e-invoice document for invoice %: filed under another organization or company than the invoice''s', NEW.invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'einvoice_document_issuance_shape';
  END IF;
  IF NOT invoice_is_issued(inv.status, inv.is_opening) OR inv.icv IS NULL THEN
    RAISE EXCEPTION 'invoice % is not issued: only its issuance writes its e-invoice document', NEW.invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'einvoice_document_issuance_shape';
  END IF;
  IF NEW.zatca_uuid IS DISTINCT FROM inv.zatca_uuid THEN
    RAISE EXCEPTION 'e-invoice document for invoice %: its UUID is not the invoice''s', NEW.invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'einvoice_document_issuance_shape';
  END IF;
  SELECT max(i.icv) INTO newest FROM invoices i WHERE i.company_id = inv.company_id;
  IF inv.icv IS DISTINCT FROM newest THEN
    RAISE EXCEPTION 'invoice % holds ICV %, not its company''s newest (%): a document is written by the issuance that allocates the ICV', NEW.invoice_id, inv.icv, newest
      USING ERRCODE = 'check_violation', CONSTRAINT = 'einvoice_document_issuance_shape';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION guard_einvoice_document_insert() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS einvoice_documents_issuance_shape ON "einvoice_documents";--> statement-breakpoint
CREATE TRIGGER einvoice_documents_issuance_shape BEFORE INSERT ON "einvoice_documents"
  FOR EACH ROW EXECUTE FUNCTION guard_einvoice_document_insert();
