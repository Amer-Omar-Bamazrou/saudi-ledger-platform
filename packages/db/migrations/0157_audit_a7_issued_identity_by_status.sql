-- ═════════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 audit (2026-11-09), finding A7 — G31's seller check applies to EVERY
-- issuing write.
--
-- 0121's guard decided "issued" by the homegrown hash: a writer that moved a draft
-- to an issued status WITHOUT a hash (its parties captured as 0133 requires) stored
-- any seller name and VAT number, and 0125 then froze the row as issued. PR C
-- (0125) decides "issued" by status: invoice_is_issued(status, is_opening). Both
-- branches here now use it beside the hash, so the two definitions cannot diverge:
--   · frozen:  OLD has a hash, OR OLD is issued by status;
--   · issuing: NEW has a hash, OR NEW is issued by status — its seller must be its
--     company's own, and an invoice must capture the default bank as it stands.
-- The product's approval mints the hash and the status in one write, so it is
-- checked exactly as before. Same function name; the 0121 trigger is unchanged.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION guard_invoice_issued_identity() RETURNS trigger AS $$
DECLARE
  co_name text;
  co_vat text;
  b_id integer;
  b_bank_name text;
  b_iban text;
  b_name text;
BEGIN
  -- An ISSUED document: what it states about its seller and its payment
  -- details is fixed. A correction is a credit note, never an edit.
  IF OLD.invoice_hash IS NOT NULL OR invoice_is_issued(OLD.status, OLD.is_opening) THEN
    IF NEW.seller_name IS DISTINCT FROM OLD.seller_name
       OR NEW.seller_vat_number IS DISTINCT FROM OLD.seller_vat_number
       OR NEW.issued_bank_account_id IS DISTINCT FROM OLD.issued_bank_account_id
       OR NEW.issued_bank_name IS DISTINCT FROM OLD.issued_bank_name
       OR NEW.issued_bank_iban IS DISTINCT FROM OLD.issued_bank_iban
       OR NEW.issued_bank_account_name IS DISTINCT FROM OLD.issued_bank_account_name THEN
      RAISE EXCEPTION 'invoice % is issued: its seller identity and printed bank details are fixed by the issued document; correct it with a credit note', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_issued_identity_frozen';
    END IF;
    RETURN NEW;
  END IF;

  -- Not issuing: a draft's columns are not a legal document yet.
  IF NEW.invoice_hash IS NULL AND NOT invoice_is_issued(NEW.status, NEW.is_opening) THEN
    RETURN NEW;
  END IF;

  -- The ISSUING write. Read as the writer, so a company or bank the tenant
  -- cannot see reads as absent and the write is refused (fail closed).
  SELECT c.name, c.vat_number INTO co_name, co_vat FROM companies c WHERE c.id = NEW.company_id;
  IF co_vat IS NULL OR NEW.seller_vat_number IS DISTINCT FROM co_vat OR NEW.seller_name IS DISTINCT FROM co_name THEN
    RAISE EXCEPTION 'invoice % must be issued under its company''s own name and VAT number; got % / %', NEW.id, NEW.seller_name, NEW.seller_vat_number
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_seller_identity_from_company';
  END IF;

  IF NEW.document_type = 'invoice' THEN
    -- The same choice the issuing service makes: the company's first default
    -- bank by name (bankAccountsRepository.lockDefaultForIssue).
    SELECT b.id, b.bank_name, b.iban, b.name INTO b_id, b_bank_name, b_iban, b_name
      FROM bank_accounts b
     WHERE b.company_id = NEW.company_id AND b.is_default
     ORDER BY b.name
     LIMIT 1;
    IF NEW.issued_bank_account_id IS DISTINCT FROM b_id
       OR NEW.issued_bank_name IS DISTINCT FROM b_bank_name
       OR NEW.issued_bank_iban IS DISTINCT FROM b_iban
       OR NEW.issued_bank_account_name IS DISTINCT FROM b_name THEN
      RAISE EXCEPTION 'invoice % must capture the company''s default bank details as they stand at issue', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_bank_capture_from_default';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
