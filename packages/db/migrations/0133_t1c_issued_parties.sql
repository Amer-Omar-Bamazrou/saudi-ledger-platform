-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 T1c (Phase 18) — G32: THE PARTIES AN ISSUED DOCUMENT PRINTS, FIXED AT ISSUE.
-- Final-run memo 2026-10-27 §2 B; owner authorisation 2026-10-24 evening item 4.
-- Register §11.33.
--
-- G31/G30 (0121) fixed the seller's name, VAT number and bank details at issue.
-- A reprint still read the rest LIVE: the seller's Arabic name, CR, address and
-- logo from the company, and the whole buyer block from the customer. Here the
-- issuing write captures both blocks from the records themselves, and once a
-- document is issued its capture never changes:
--   issued_seller        {nameAr, crNumber, buildingNumber, street, district, city, postalCode, logoPath}
--   issued_buyer         {name, nameAr, vatNumber, crNumber, buildingNumber, street, district, city, postalCode},
--                        or NULL when the document names no customer
--   parties_captured_at  the moment of capture
-- "Issued" is PR C's one definition, invoice_is_issued(status, is_opening)
-- (0125). Opening invoices are not issued documents and capture nothing.
--
-- 🔴 NEVER ALTERS AN ISSUED ROW. A row issued before this migration keeps NULL
-- captures (no back-fill: today's values are not what it printed); the document
-- says so when it is reprinted. The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── PRE-CHECK: refuse before anything is created. ───────────────────────────
DO $$
DECLARE
  n integer;
  sample jsonb;
BEGIN
  -- 1. PR C's definition of "issued" is the one this builds on.
  IF to_regprocedure('invoice_is_issued(text, boolean)') IS NULL THEN
    RAISE EXCEPTION 'T1c pre-check REFUSED: invoice_is_issued(text, boolean) (PR C, 0125) does not exist; nothing was changed';
  END IF;
  -- 2. Every invoice's customer is in the invoice's own organisation: the capture
  --    is taken from that customer, so a cross-organisation pairing would make the
  --    database's comparison meaningless.
  SELECT count(*)::int, coalesce(jsonb_agg(jsonb_build_object('invoice_id', i.id, 'customer_id', i.customer_id) ORDER BY i.id), '[]'::jsonb)
    INTO n, sample
    FROM invoices i JOIN customers c ON c.id = i.customer_id
   WHERE c.organization_id IS DISTINCT FROM i.organization_id;
  IF n > 0 THEN
    RAISE EXCEPTION 'T1c pre-check REFUSED: % invoice(s) name a customer of another organisation: %; nothing was changed', n, sample
      USING HINT = 'This migration repairs nothing. The owner decides what each listed row is first.';
  END IF;
  RAISE NOTICE 'T1c pre-check: invoice_is_issued exists; every invoice''s customer is in its own organisation';
END $$;--> statement-breakpoint

-- ── The captures. ────────────────────────────────────────────────────────────
ALTER TABLE "invoices" ADD COLUMN "issued_seller" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issued_buyer" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "parties_captured_at" timestamp with time zone;--> statement-breakpoint

-- ── The rule: captured from the records at issue, fixed once issued. ─────────
-- The two shapes, stated once; services/issuedParties.ts writes the same keys.
CREATE OR REPLACE FUNCTION invoice_seller_capture(company uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
  SELECT jsonb_build_object('nameAr', c.name_ar, 'crNumber', c.cr_number, 'buildingNumber', c.building_number, 'street', c.street,
                            'district', c.district, 'city', c.city, 'postalCode', c.postal_code, 'logoPath', c.logo_path)
    FROM companies c WHERE c.id = company
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION invoice_buyer_capture(customer integer) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
  SELECT jsonb_build_object('name', c.name, 'nameAr', c.name_ar, 'vatNumber', c.tax_number, 'crNumber', c.cr_number,
                            'buildingNumber', c.building_number, 'street', c.street, 'district', c.district, 'city', c.city,
                            'postalCode', c.postal_code)
    FROM customers c WHERE c.id = customer
$fn$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION zz_guard_invoice_issued_parties() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF invoice_is_issued(OLD.status, OLD.is_opening) THEN
    IF NEW.issued_seller IS DISTINCT FROM OLD.issued_seller
       OR NEW.issued_buyer IS DISTINCT FROM OLD.issued_buyer
       OR NEW.parties_captured_at IS DISTINCT FROM OLD.parties_captured_at THEN
      RAISE EXCEPTION 'invoice % is issued: the parties it prints were fixed at issue and never change', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_issued_parties_fixed';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT invoice_is_issued(NEW.status, NEW.is_opening) THEN
    RETURN NEW;  -- a draft prints nothing yet
  END IF;
  -- The ISSUING write: both blocks as the records hold them now, read as the writer
  -- (a company or customer the tenant cannot see reads as absent, and is refused).
  IF NEW.parties_captured_at IS NULL
     OR NEW.issued_seller IS DISTINCT FROM invoice_seller_capture(NEW.company_id)
     OR NEW.issued_buyer IS DISTINCT FROM (CASE WHEN NEW.customer_id IS NULL THEN NULL ELSE invoice_buyer_capture(NEW.customer_id) END) THEN
    RAISE EXCEPTION 'invoice % must be issued with its company''s and its customer''s details as the records hold them at issue', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_parties_from_records';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER zz_invoices_issued_parties_trg BEFORE UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION zz_guard_invoice_issued_parties();
