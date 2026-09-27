-- Z-AP1 (2026-09-24) — the supplier's ADVANCE tax invoice, claimed in its own
-- period, and the final bill's prepayment adjustment that stops the same
-- input VAT being claimed twice. Accountant answer A. Record: Phase 12
-- decision pack §8; schema reasoning: schema/supplierPayments.ts.
CREATE TABLE "bill_prepayments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"bill_id" integer NOT NULL,
	"advance_bill_id" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"taxable_amount" numeric(15, 2) NOT NULL,
	"tax_amount" numeric(15, 2) NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"allocation_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_prepayments_amount_chk" CHECK (amount > 0 AND taxable_amount >= 0 AND tax_amount >= 0 AND amount = taxable_amount + tax_amount)
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "advance_supplier_payment_id" integer;--> statement-breakpoint
ALTER TABLE "bill_prepayments" ADD CONSTRAINT "bill_prepayments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_prepayments" ADD CONSTRAINT "bill_prepayments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_prepayments" ADD CONSTRAINT "bill_prepayments_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_prepayments" ADD CONSTRAINT "bill_prepayments_advance_bill_id_bills_id_fk" FOREIGN KEY ("advance_bill_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_prepayments" ADD CONSTRAINT "bill_prepayments_allocation_id_supplier_payment_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."supplier_payment_allocations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_prepayments_pair_unq" ON "bill_prepayments" USING btree ("bill_id","advance_bill_id");--> statement-breakpoint
CREATE INDEX "bill_prepayments_advance_idx" ON "bill_prepayments" USING btree ("advance_bill_id");--> statement-breakpoint

-- ── Z-AP1: the purchase-side advance documents ──────────────────────────────
-- advance_invoice      the SUPPLIER'S advance-payment tax invoice (their 386),
--                      received for an advance we paid; claims its input VAT
--                      in its own period (accountant answer A, 2026-09-24).
-- advance_credit_note  the supplier's credit note against that invoice (the
--                      advance refunded or cancelled); reverses the VAT in the
--                      note's period (IR Art. 40(6)).
ALTER TABLE "bills" DROP CONSTRAINT "bills_document_type_chk";--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_document_type_chk"
  CHECK (document_type IN ('bill', 'credit_note', 'debit_note', 'advance_invoice', 'advance_credit_note'));--> statement-breakpoint
-- A note adjusts a document and says which; a bill and an advance invoice adjust nothing.
ALTER TABLE "bills" DROP CONSTRAINT "bills_note_against_chk";--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_note_against_chk"
  CHECK ((document_type IN ('bill', 'advance_invoice')) = (credit_note_against_bill_id IS NULL));--> statement-breakpoint
-- An advance invoice names the supplier payment it invoices; nothing else does.
ALTER TABLE "bills" ADD CONSTRAINT "bills_advance_reference_chk"
  CHECK ((document_type = 'advance_invoice') = (advance_supplier_payment_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_advance_supplier_payment_fk"
  FOREIGN KEY ("advance_supplier_payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE restrict;--> statement-breakpoint
-- An advance document buys nothing: it never capitalises an asset.
ALTER TABLE "bills" ADD CONSTRAINT "bills_advance_not_capitalised_chk"
  CHECK (document_type NOT IN ('advance_invoice', 'advance_credit_note') OR capitalises_asset_id IS NULL);--> statement-breakpoint

-- ── What a note may point at, and whose it is (FK checks run outside RLS) ──
-- credit/debit note → a BILL; advance credit note → an ADVANCE INVOICE; an
-- advance invoice → an ADVANCE-classified supplier payment. Each reference must
-- be this company's and, for a note, the same supplier's.
CREATE OR REPLACE FUNCTION check_bill_references() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target record; pay record;
BEGIN
  IF NEW.credit_note_against_bill_id IS NOT NULL THEN
    SELECT b.document_type, b.company_id, b.vendor_id INTO target FROM bills b WHERE b.id = NEW.credit_note_against_bill_id;
    IF target.company_id IS DISTINCT FROM NEW.company_id
       OR target.vendor_id IS DISTINCT FROM NEW.vendor_id
       OR (NEW.document_type = 'advance_credit_note' AND target.document_type <> 'advance_invoice')
       OR (NEW.document_type IN ('credit_note', 'debit_note') AND target.document_type <> 'bill') THEN
      RAISE EXCEPTION 'bill %: a % must adjust a % of the same company and supplier', NEW.id, NEW.document_type,
        CASE WHEN NEW.document_type = 'advance_credit_note' THEN 'supplier advance tax invoice' ELSE 'bill' END
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.advance_supplier_payment_id IS NOT NULL THEN
    SELECT p.company_id, p.vendor_id INTO pay FROM supplier_payments p WHERE p.id = NEW.advance_supplier_payment_id;
    IF pay.company_id IS DISTINCT FROM NEW.company_id OR pay.vendor_id IS DISTINCT FROM NEW.vendor_id THEN
      RAISE EXCEPTION 'bill %: an advance tax invoice must name a supplier payment of the same company and supplier', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER bills_references_check BEFORE INSERT OR UPDATE OF credit_note_against_bill_id, advance_supplier_payment_id, vendor_id, company_id ON bills
  FOR EACH ROW EXECUTE FUNCTION check_bill_references();--> statement-breakpoint

-- ── bill_prepayments: tenancy, grants ───────────────────────────────────────
ALTER TABLE "bill_prepayments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."bill_prepayments"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
-- A DRAFT bill's selection is edited like its lines (delete and re-insert);
-- the trigger below freezes it the moment the bill is approved.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "bill_prepayments" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "bill_prepayments_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.bill_prepayments FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- ── bill_prepayments: shape, ownership, and the freeze ──────────────────────
-- A row joins a BILL (the final invoice) to an ADVANCE INVOICE of the same
-- company and supplier. While the bill is a draft (or submitted) its rows may
-- be inserted, edited and deleted; once approved they are FROZEN — the only
-- permitted change is the approval's own act, setting allocation_id from
-- NULL, once. A correction is a supplier credit note on the final bill.
CREATE OR REPLACE FUNCTION check_bill_prepayment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE fin record; adv record; row_bill integer;
BEGIN
  row_bill := CASE WHEN TG_OP = 'DELETE' THEN OLD.bill_id ELSE NEW.bill_id END;
  SELECT b.status, b.document_type, b.company_id, b.vendor_id INTO fin FROM bills b WHERE b.id = row_bill;
  IF TG_OP = 'DELETE' THEN
    IF fin.status NOT IN ('draft', 'submitted') THEN
      RAISE EXCEPTION 'bill %: its prepayment adjustments are frozen once it is approved', row_bill USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND fin.status NOT IN ('draft', 'submitted') THEN
    IF OLD.allocation_id IS NULL AND NEW.allocation_id IS NOT NULL
       AND (to_jsonb(NEW) - 'allocation_id') = (to_jsonb(OLD) - 'allocation_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'bill %: its prepayment adjustments are frozen once it is approved', row_bill USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND fin.status NOT IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'bill %: a prepayment adjustment is added only while the bill is a draft', row_bill USING ERRCODE = '23514';
  END IF;
  SELECT b.document_type, b.company_id, b.vendor_id INTO adv FROM bills b WHERE b.id = NEW.advance_bill_id;
  IF fin.document_type <> 'bill' OR adv.document_type IS DISTINCT FROM 'advance_invoice'
     OR fin.company_id IS DISTINCT FROM NEW.company_id OR adv.company_id IS DISTINCT FROM NEW.company_id
     OR adv.vendor_id IS DISTINCT FROM fin.vendor_id THEN
    RAISE EXCEPTION 'bill %: a prepayment adjustment joins a bill to an advance tax invoice of the same company and supplier', NEW.bill_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER bill_prepayments_check BEFORE INSERT OR UPDATE OR DELETE ON bill_prepayments
  FOR EACH ROW EXECUTE FUNCTION check_bill_prepayment();
