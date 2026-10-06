-- ═══════════════════════════════════════════════════════════════════════════
-- Pre-Phase-18 integrity hardening (owner decision D-0, 2026-10-07):
-- G01, G31, G30 — each a defect in a control the platform already claims.
--
-- G01 — an operator is a member of NO organization (M11.3). Until now that
--   premise was a convention: nothing refused a membership row naming an
--   operator, and a tenant admin could create one. Two triggers make it a
--   constraint, from both sides, serialised per user by one advisory lock so
--   a membership and an operator grant racing for the same account cannot
--   both commit.
--
-- G31 — the seller identity on an issued tax invoice is the COMPANY's, read
--   at issue, and fixed from then on. The issuing write (invoice_hash NULL →
--   set) must carry the company's own name and VAT number; after issue the
--   seller identity cannot change.
--
-- G30 — an issued invoice prints the bank details in force when it was
--   issued. Four capture columns, written only by the issuing write, which
--   must equal the company's default bank at that moment (or be NULL when
--   there is none); frozen after issue.
--
-- Existing rows: no row is changed. Issued invoices from before this
-- migration keep NULL capture columns — NOT backfilled (owner decision
-- pending; a backfilled value must never be presented as the original). The
-- checks below bind only NEW issuing writes and changes to issued rows.
-- An INSERT of an already-issued row is not checked: no product path does it
-- (create allowlists refuse every issuance field, H1).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "invoices" ADD COLUMN "issued_bank_account_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issued_bank_name" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issued_bank_iban" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issued_bank_account_name" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("issued_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── G30: the capture is whole, and only on an issued INVOICE ────────────────
-- A bank account may have no IBAN (the document then prints an empty IBAN,
-- as it always did), so the IBAN alone may be NULL inside a capture.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_bank_capture_whole_chk" CHECK (
  (issued_bank_account_id IS NULL) = (issued_bank_name IS NULL)
  AND (issued_bank_account_id IS NULL) = (issued_bank_account_name IS NULL)
  AND (issued_bank_account_id IS NOT NULL OR issued_bank_iban IS NULL)
);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_bank_capture_scope_chk" CHECK (
  issued_bank_account_id IS NULL OR (invoice_hash IS NOT NULL AND document_type = 'invoice')
);--> statement-breakpoint

-- ── G31 + G30: the issuing write, and the frozen issued row ──────────────────
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
  IF OLD.invoice_hash IS NOT NULL THEN
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
  IF NEW.invoice_hash IS NULL THEN
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
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS invoices_issued_identity_trg ON "invoices";--> statement-breakpoint
CREATE TRIGGER invoices_issued_identity_trg BEFORE UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION guard_invoice_issued_identity();--> statement-breakpoint

-- ── G01: an operator holds no membership — from both sides ──────────────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM organization_memberships m JOIN platform_operators p ON p.user_id = m.user_id;
  IF n > 0 THEN
    RAISE EXCEPTION 'G01: % membership row(s) name a platform operator; remove them (or the operator grant) before applying 0121 — this migration does not choose which', n;
  END IF;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION refuse_operator_membership() RETURNS trigger AS $$
BEGIN
  -- One lock per account, taken by both triggers, so a membership and an
  -- operator grant for the same user serialise: the second to arrive reads
  -- the first's committed row (READ COMMITTED, a fresh snapshot per statement).
  PERFORM pg_advisory_xact_lock(hashtext('g01_operator_membership'), NEW.user_id);
  IF EXISTS (SELECT 1 FROM platform_operators p WHERE p.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'user % is a platform operator, and an operator is a member of no organization', NEW.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'operator_holds_no_membership';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS organization_memberships_no_operator_trg ON "organization_memberships";--> statement-breakpoint
CREATE TRIGGER organization_memberships_no_operator_trg BEFORE INSERT OR UPDATE OF user_id ON "organization_memberships" FOR EACH ROW EXECUTE FUNCTION refuse_operator_membership();--> statement-breakpoint

CREATE OR REPLACE FUNCTION refuse_operator_with_membership() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('g01_operator_membership'), NEW.user_id);
  IF EXISTS (SELECT 1 FROM organization_memberships m WHERE m.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'user % holds an organization membership (any status), so cannot be a platform operator', NEW.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'operator_holds_no_membership';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS platform_operators_no_membership_trg ON "platform_operators";--> statement-breakpoint
CREATE TRIGGER platform_operators_no_membership_trg BEFORE INSERT OR UPDATE OF user_id ON "platform_operators" FOR EACH ROW EXECUTE FUNCTION refuse_operator_with_membership();
