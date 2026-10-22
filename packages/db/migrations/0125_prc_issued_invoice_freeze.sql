-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 PR C (Phase 18, T1c) — THE ISSUED-INVOICE FREEZE: G29 and G49. (G50 is
-- fixed in the e-invoice loader: the signed document states the seller the
-- issuing write stamped, never a second, live read of the company.)
--
-- Owner decisions (2026-10-21, decisions 4 and 5; authorisation 2026-10-22 §4):
--   * "Issued" = APPROVED: the issuing write that assigns the number, ICV and
--     hash and signs the XML, for standard and simplified documents alike. The
--     freeze never depends on ZATCA clearance status.
--   * The freeze is keyed on the ISSUED STATUS, never on the hash (G49: 0121
--     and 0083 keyed on `invoice_hash IS NOT NULL`, so clearing the hash took
--     an issued invoice out of both freezes in two statements).
--   * Existing issued rows are IN, including any whose hash is missing or was
--     cleared. Opening invoices (`is_opening`) are OUT and listed.
--   * The pre-check REFUSES, and lists, any issued row whose stored fields
--     disagree with its signed XML. Nothing is repaired, reclassified or
--     deleted by this migration.
--
-- ISSUED, stated once (`invoice_is_issued`): not an opening item, and a status
-- other than the two unissued ones the application defines
-- (`UNISSUED_STATUSES` = draft, submitted; a test pins the two definitions
-- together). Any other status — sent, paid, or a value nothing writes today —
-- is issued: the freeze fails CLOSED on a status it does not know.
--
-- What an issued invoice may still change (the writers that run after the
-- issuing write, each named):
--   status            sent ↔ paid only (payment allocation / its correction)
--   paid_amount, paid_at, credited_amount          the settlement caches
--   written_off_amount, bad_debt_relief_*           the Art. 40(7) write-off
--   qr_code           ONLY to the QR its signed e-invoice document carries
--                     (the Phase-2 overwrite inside the issuing transaction)
-- Every other column — including any column added later — is frozen. DELETE
-- is refused. A row cannot be INSERTED already issued: issuance is the
-- issuing write, never an insert. Its lines and its prepayment adjustments
-- are frozen with it, and its e-invoice document's signed artefacts can be
-- neither changed nor deleted (the transmission state stays the worker's).
--
-- The 0121 trigger (seller/bank capture checked at the issuing write) is
-- KEPT unchanged; this freeze is in addition to it.
--
-- 🔴 Not changed here: the ICV allocation, the homegrown and ZATCA chains,
-- numbering, clearance/reporting and the worker's response handling.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The one definition of ISSUED at the database ────────────────────────────
CREATE OR REPLACE FUNCTION invoice_is_issued(status text, is_opening boolean) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$ SELECT NOT is_opening AND status NOT IN ('draft', 'submitted') $$;--> statement-breakpoint

-- ── R1, the comparison the pre-check refuses on, as a function: an issued
--    row whose stored fields disagree with its signed XML (or whose signed
--    XML cannot be read), one row per invoice with every reason. Read-only;
--    kept after the migration as a standing check. ───────────────────────────
CREATE OR REPLACE FUNCTION issued_invoice_xml_disagreements()
  RETURNS TABLE (invoice_id integer, company_id uuid, why text[])
  LANGUAGE sql STABLE AS $fn$
  WITH ns AS (
    SELECT ARRAY[
      ARRAY['inv', 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'],
      ARRAY['cac', 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2'],
      ARRAY['cbc', 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2'],
      ARRAY['ext', 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2'],
      ARRAY['ds', 'http://www.w3.org/2000/09/xmldsig#']
    ] AS n
  ),
  issued AS (
    SELECT i.id, i.company_id, i.invoice_number, i.zatca_uuid, i.icv, i.issued_at, i.document_type,
           i.seller_name, i.seller_vat_number, i.subtotal, i.vat_amount, i.total, i.qr_code,
           d.flow, d.zatca_uuid AS doc_uuid, d.invoice_hash AS doc_hash, d.previous_invoice_hash AS doc_pih,
           d.qr_code AS doc_qr, d.signed_xml
      FROM invoices i
      JOIN einvoice_documents d ON d.invoice_id = i.id
     WHERE invoice_is_issued(i.status, i.is_opening)
  ),
  x AS (
    SELECT s.*, coalesce(xml_is_well_formed_document(s.signed_xml), false) AS readable FROM issued s
  ),
  f AS (
    SELECT x.id, x.company_id, x.readable,
           x.invoice_number, x.zatca_uuid, x.icv, x.issued_at, x.document_type, x.seller_name, x.seller_vat_number,
           x.subtotal, x.vat_amount, x.total, x.qr_code, x.flow, x.doc_uuid, x.doc_hash, x.doc_pih, x.doc_qr,
           (xpath('string(/inv:Invoice/cbc:ID)', p.doc, ns.n))[1]::text AS x_number,
           (xpath('string(/inv:Invoice/cbc:UUID)', p.doc, ns.n))[1]::text AS x_uuid,
           (xpath('string(/inv:Invoice/cbc:IssueDate)', p.doc, ns.n))[1]::text AS x_date,
           (xpath('string(/inv:Invoice/cbc:IssueTime)', p.doc, ns.n))[1]::text AS x_time,
           (xpath('string(/inv:Invoice/cbc:InvoiceTypeCode)', p.doc, ns.n))[1]::text AS x_type,
           (xpath('string(/inv:Invoice/cbc:InvoiceTypeCode/@name)', p.doc, ns.n))[1]::text AS x_subtype,
           (xpath('string(/inv:Invoice/cac:AdditionalDocumentReference[cbc:ID=''ICV'']/cbc:UUID)', p.doc, ns.n))[1]::text AS x_icv,
           (xpath('string(/inv:Invoice/cac:AdditionalDocumentReference[cbc:ID=''PIH'']/cac:Attachment/cbc:EmbeddedDocumentBinaryObject)', p.doc, ns.n))[1]::text AS x_pih,
           (xpath('string(/inv:Invoice/cac:AdditionalDocumentReference[cbc:ID=''QR'']/cac:Attachment/cbc:EmbeddedDocumentBinaryObject)', p.doc, ns.n))[1]::text AS x_qr,
           (xpath('string(/inv:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName)', p.doc, ns.n))[1]::text AS x_seller_name,
           (xpath('string(/inv:Invoice/cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID)', p.doc, ns.n))[1]::text AS x_seller_vat,
           (xpath('string(/inv:Invoice/cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount)', p.doc, ns.n))[1]::text AS x_tax_exclusive,
           (xpath('string(/inv:Invoice/cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount)', p.doc, ns.n))[1]::text AS x_tax_inclusive,
           (xpath('string(/inv:Invoice/cac:TaxTotal[1]/cbc:TaxAmount)', p.doc, ns.n))[1]::text AS x_tax,
           (xpath('string(//ds:Reference[@Id=''invoiceSignedData'']/ds:DigestValue)', p.doc, ns.n))[1]::text AS x_digest
      FROM x CROSS JOIN ns
      CROSS JOIN LATERAL (SELECT CASE WHEN x.readable THEN x.signed_xml::xml END AS doc) p
  ),
  reasons AS (
    SELECT f.id, f.company_id, array_remove(ARRAY[
      CASE WHEN NOT f.readable THEN 'signed XML is missing or not a well-formed document' END,
      CASE WHEN f.readable AND f.invoice_number IS DISTINCT FROM f.x_number THEN 'invoice_number <> cbc:ID' END,
      CASE WHEN f.readable AND f.zatca_uuid::text IS DISTINCT FROM f.x_uuid THEN 'zatca_uuid <> cbc:UUID' END,
      CASE WHEN f.readable AND f.doc_uuid::text IS DISTINCT FROM f.x_uuid THEN 'einvoice_documents.zatca_uuid <> cbc:UUID' END,
      CASE WHEN f.readable AND f.icv::text IS DISTINCT FROM f.x_icv THEN 'icv <> ICV reference' END,
      CASE WHEN f.readable AND to_char(f.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') IS DISTINCT FROM f.x_date THEN 'issued_at date <> cbc:IssueDate' END,
      CASE WHEN f.readable AND to_char(f.issued_at AT TIME ZONE 'UTC', 'HH24:MI:SS') IS DISTINCT FROM f.x_time THEN 'issued_at time <> cbc:IssueTime' END,
      CASE WHEN f.readable AND (CASE f.document_type WHEN 'invoice' THEN '388' WHEN 'debit_note' THEN '383' WHEN 'credit_note' THEN '381'
                                   WHEN 'advance_invoice' THEN '386' WHEN 'advance_credit_note' THEN '381' WHEN 'recovery_invoice' THEN '388' END)
                                  IS DISTINCT FROM f.x_type THEN 'document_type <> cbc:InvoiceTypeCode' END,
      CASE WHEN f.readable AND (CASE left(f.x_subtype, 2) WHEN '01' THEN 'clearance' WHEN '02' THEN 'reporting' END) IS DISTINCT FROM f.flow
           THEN 'einvoice_documents.flow <> the InvoiceTypeCode subtype' END,
      CASE WHEN f.readable AND f.doc_pih IS DISTINCT FROM f.x_pih THEN 'einvoice_documents.previous_invoice_hash <> PIH reference' END,
      CASE WHEN f.readable AND f.doc_qr IS DISTINCT FROM f.x_qr THEN 'einvoice_documents.qr_code <> QR reference' END,
      CASE WHEN f.readable AND f.qr_code IS DISTINCT FROM f.doc_qr THEN 'invoices.qr_code <> the signed document''s QR' END,
      CASE WHEN f.readable AND f.doc_hash IS DISTINCT FROM f.x_digest THEN 'einvoice_documents.invoice_hash <> the signed invoice digest' END,
      CASE WHEN f.readable AND f.seller_name IS NOT NULL
                AND f.seller_name IS DISTINCT FROM replace(replace(replace(replace(replace(f.x_seller_name, '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&apos;', ''''), '&amp;', '&')
           THEN 'seller_name <> the supplier''s RegistrationName' END,
      CASE WHEN f.readable AND f.seller_vat_number IS NOT NULL AND f.seller_vat_number IS DISTINCT FROM f.x_seller_vat
           THEN 'seller_vat_number <> the supplier''s CompanyID' END,
      CASE WHEN f.readable AND (coalesce(f.x_tax_exclusive, '') !~ '^-?[0-9]+(\.[0-9]+)?$' OR f.subtotal IS DISTINCT FROM f.x_tax_exclusive::numeric) THEN 'subtotal <> TaxExclusiveAmount' END,
      CASE WHEN f.readable AND (coalesce(f.x_tax_inclusive, '') !~ '^-?[0-9]+(\.[0-9]+)?$' OR f.total IS DISTINCT FROM f.x_tax_inclusive::numeric) THEN 'total <> TaxInclusiveAmount' END,
      CASE WHEN f.readable AND (coalesce(f.x_tax, '') !~ '^-?[0-9]+(\.[0-9]+)?$' OR f.vat_amount IS DISTINCT FROM f.x_tax::numeric) THEN 'vat_amount <> TaxTotal/TaxAmount' END
    ], NULL) AS why
      FROM f
  )
  SELECT reasons.id, reasons.company_id, reasons.why FROM reasons WHERE cardinality(reasons.why) > 0
$fn$;--> statement-breakpoint

-- ── PRE-CHECK: refuse, and list, what this migration would freeze in a state
--    that disagrees with its own signed document. Lists what is excluded or
--    unusual without refusing. Writes nothing. ───────────────────────────────
DO $$
DECLARE
  refused jsonb;
  n_refused integer;
  listing record;
BEGIN
  -- R1: an issued row whose stored fields disagree with its signed XML (or
  -- whose signed XML cannot be read). Compared field by field with the
  -- element the XML builder writes it to (ubl/buildInvoiceXml.ts,
  -- crypto/assembleSignedInvoice.ts).
  SELECT count(*)::int, coalesce(jsonb_agg(jsonb_build_object('invoice_id', r.invoice_id, 'company_id', r.company_id, 'why', r.why) ORDER BY r.invoice_id)
                                 FILTER (WHERE r.rn <= 50), '[]'::jsonb)
    INTO n_refused, refused
    FROM (SELECT d.*, row_number() OVER (ORDER BY d.invoice_id) AS rn FROM issued_invoice_xml_disagreements() d) r;

  -- Listed, NOT refused. Each is frozen (or excluded) exactly as it stands.
  FOR listing IN
    SELECT 'L1 issued, no invoice_hash (cleared or never set) — IN scope, frozen as it stands' AS what,
           count(*)::int AS n, (array_agg(id ORDER BY id))[1:50] AS ids
      FROM invoices WHERE invoice_is_issued(status, is_opening) AND invoice_hash IS NULL
    UNION ALL
    SELECT 'L2 opening invoices (is_opening) — OUT of PR C until the owner defines their issued state',
           count(*)::int, (array_agg(id ORDER BY id))[1:50]
      FROM invoices WHERE is_opening
    UNION ALL
    SELECT 'L3 issued, no seller stamp (issued before 0121) — frozen as it stands',
           count(*)::int, (array_agg(id ORDER BY id))[1:50]
      FROM invoices WHERE invoice_is_issued(status, is_opening) AND seller_vat_number IS NULL
    UNION ALL
    SELECT 'L4 issued under a status other than sent/paid — frozen (fail closed)',
           count(*)::int, (array_agg(id ORDER BY id))[1:50]
      FROM invoices WHERE invoice_is_issued(status, is_opening) AND status NOT IN ('sent', 'paid')
    UNION ALL
    SELECT 'L5 unissued (draft/submitted) yet carrying a hash or a signed document — not frozen by status (0121 still freezes a hashed row''s seller)',
           count(*)::int, (array_agg(id ORDER BY id))[1:50]
      FROM invoices i WHERE NOT is_opening AND NOT invoice_is_issued(status, is_opening)
       AND (invoice_hash IS NOT NULL OR EXISTS (SELECT 1 FROM einvoice_documents d WHERE d.invoice_id = i.id))
    UNION ALL
    SELECT 'L6 issued without a signed e-invoice document (company not onboarded at issue) — nothing to compare; frozen',
           count(*)::int, NULL::int[]
      FROM invoices i WHERE invoice_is_issued(status, is_opening)
       AND NOT EXISTS (SELECT 1 FROM einvoice_documents d WHERE d.invoice_id = i.id)
  LOOP
    RAISE NOTICE 'PR C pre-check: % — % row(s)%', listing.what, listing.n,
      CASE WHEN listing.n > 0 AND listing.ids IS NOT NULL THEN format(' (ids, first 50: %s)', listing.ids) ELSE '' END;
  END LOOP;

  IF n_refused > 0 THEN
    RAISE EXCEPTION 'PR C pre-check REFUSED: % issued invoice(s) state fields that disagree with their own signed e-invoice document; nothing was changed. First 50: %', n_refused, refused
      USING HINT = 'This migration freezes issued invoices as they stand. It does not repair, reclassify or delete any row: the owner decides what each listed row is before it is frozen.';
  END IF;
  RAISE NOTICE 'PR C pre-check: R1 — no issued invoice disagrees with its signed e-invoice document';
END $$;--> statement-breakpoint

-- ── G29 + G49: the issued invoice ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION guard_issued_invoice() RETURNS trigger AS $$
DECLARE
  -- The columns a writer may still move after the issuing write (header above).
  mutable constant text[] := ARRAY[
    'status', 'qr_code', 'paid_amount', 'paid_at', 'credited_amount', 'written_off_amount',
    'bad_debt_relief_claimed_on', 'bad_debt_relief_vat_amount', 'bad_debt_relief_return_period',
    'bad_debt_relief_certificate_ref', 'bad_debt_relief_legal_ref', 'bad_debt_relief_source',
    'bad_debt_relief_journal_entry_id'];
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
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- DELETE is refused BEFORE the row goes, so no cascade to the lines or the
-- e-invoice document starts. INSERT and UPDATE are checked AFTER the row is
-- written: the guards that already refuse a part of this — 0121's seller and
-- bank-capture trigger, the bank-capture CHECKs — run first and keep their
-- own refusals, and this freeze refuses whatever they let through.
DROP TRIGGER IF EXISTS invoices_issued_freeze_trg ON "invoices";--> statement-breakpoint
CREATE TRIGGER invoices_issued_freeze_trg BEFORE DELETE ON "invoices" FOR EACH ROW EXECUTE FUNCTION guard_issued_invoice();--> statement-breakpoint
DROP TRIGGER IF EXISTS invoices_issued_status_freeze_trg ON "invoices";--> statement-breakpoint
CREATE TRIGGER invoices_issued_status_freeze_trg AFTER INSERT OR UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION guard_issued_invoice();--> statement-breakpoint

-- ── G29: the issued invoice's lines ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION guard_issued_invoice_lines() RETURNS trigger AS $$
DECLARE
  hit integer;
BEGIN
  -- Both sides of an UPDATE: a line may neither leave nor join an issued invoice.
  SELECT i.id INTO hit FROM invoices i
   WHERE i.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.invoice_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.invoice_id END)
     AND invoice_is_issued(i.status, i.is_opening)
   LIMIT 1;
  IF hit IS NOT NULL THEN
    RAISE EXCEPTION 'invoice % is issued: its lines are stated by the issued document and cannot be %', hit,
      CASE TG_OP WHEN 'INSERT' THEN 'added to' WHEN 'DELETE' THEN 'deleted' ELSE 'changed' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_issued_lines_frozen';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS invoice_items_issued_freeze_trg ON "invoice_items";--> statement-breakpoint
CREATE TRIGGER invoice_items_issued_freeze_trg BEFORE INSERT OR UPDATE OR DELETE ON "invoice_items" FOR EACH ROW EXECUTE FUNCTION guard_issued_invoice_lines();--> statement-breakpoint

-- ── G29: the signed e-invoice document ──────────────────────────────────────
-- The signed artefacts are fixed from the moment the document is queued; the
-- transmission state stays the worker's, and ZATCA's verdict (cleared,
-- reported, rejected) is final once recorded. No document is ever deleted.
CREATE OR REPLACE FUNCTION guard_einvoice_document() RETURNS trigger AS $$
DECLARE
  transmission constant text[] := ARRAY[
    'status', 'cleared_xml', 'submitted_at', 'completed_at', 'attempt_count', 'next_attempt_at',
    'claimed_at', 'claimed_by', 'ambiguous', 'zatca_status', 'zatca_warnings', 'last_error', 'updated_at'];
  verdict constant text[] := ARRAY['status', 'cleared_xml', 'completed_at', 'zatca_status', 'zatca_warnings'];
  changed text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'e-invoice document % (invoice %) is a signed record and cannot be deleted', OLD.id, OLD.invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'einvoice_document_frozen';
  END IF;
  IF (to_jsonb(NEW) - transmission) IS DISTINCT FROM (to_jsonb(OLD) - transmission) THEN
    SELECT string_agg(key, ', ' ORDER BY key) INTO changed
      FROM jsonb_each(to_jsonb(NEW) - transmission) WHERE (to_jsonb(OLD) - transmission) -> key IS DISTINCT FROM value;
    RAISE EXCEPTION 'e-invoice document % (invoice %) is signed: % cannot change', OLD.id, OLD.invoice_id, changed
      USING ERRCODE = 'check_violation', CONSTRAINT = 'einvoice_document_frozen';
  END IF;
  IF (OLD.status IN ('cleared', 'reported', 'rejected') OR OLD.cleared_xml IS NOT NULL)
     AND EXISTS (SELECT 1 FROM unnest(verdict) v WHERE to_jsonb(OLD) -> v IS DISTINCT FROM to_jsonb(NEW) -> v) THEN
    RAISE EXCEPTION 'e-invoice document % (invoice %) carries ZATCA''s verdict (%), which cannot change', OLD.id, OLD.invoice_id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'einvoice_document_frozen';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS einvoice_documents_frozen_trg ON "einvoice_documents";--> statement-breakpoint
CREATE TRIGGER einvoice_documents_frozen_trg BEFORE UPDATE OR DELETE ON "einvoice_documents" FOR EACH ROW EXECUTE FUNCTION guard_einvoice_document();--> statement-breakpoint

-- ── G49: the AP-2 prepayment freeze (0083), re-keyed on the issued status ───
-- Identical to 0083 except for how "issued" is read: the hash is no longer
-- the key, so clearing it no longer releases the adjustment rows.
CREATE OR REPLACE FUNCTION refuse_issued_prepayment_change() RETURNS trigger AS $$
DECLARE
  issued boolean;
  old_j jsonb;
  new_j jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT invoice_is_issued(i.status, i.is_opening) INTO issued FROM invoices i WHERE i.id = NEW.invoice_id;
    IF coalesce(issued, false) THEN
      RAISE EXCEPTION 'invoice % is issued; a prepayment adjustment is stated on the draft and frozen by the signed document', NEW.invoice_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'prepayment_issued_frozen';
    END IF;
    RETURN NEW;
  END IF;
  SELECT invoice_is_issued(i.status, i.is_opening) INTO issued FROM invoices i WHERE i.id = OLD.invoice_id;
  IF NOT coalesce(issued, false) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prepayment adjustment % of issued invoice % is frozen: the signed document states it; correct with a credit note', OLD.id, OLD.invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'prepayment_issued_frozen';
  END IF;
  -- The approval's own act: allocation_id NULL → set, once. Every other column is frozen.
  old_j := to_jsonb(OLD) - 'allocation_id'; new_j := to_jsonb(NEW) - 'allocation_id';
  IF old_j <> new_j OR (OLD.allocation_id IS NOT NULL AND NEW.allocation_id IS DISTINCT FROM OLD.allocation_id) THEN
    RAISE EXCEPTION 'prepayment adjustment % of issued invoice % is frozen: the signed document states it; correct with a credit note', OLD.id, OLD.invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'prepayment_issued_frozen';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
