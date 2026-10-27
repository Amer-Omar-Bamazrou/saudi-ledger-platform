-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 — THE PR C CORRECTION ROUTE FOR A REJECTED INVOICE.
-- Owner decision 2 of 2026-10-27 (register §11.30 C), constraints (a)–(e);
-- final-run memo §2 E. Register §11.35.
--
--  · invoice_rejections: ZATCA's rejection of a submission, recorded by an
--    approver with ZATCA's response. APPEND-ONLY for every role (the T1b
--    pattern; replica mode the only bypass). Recording one changes nothing on
--    the invoice or its entry.
--  · invoices.corrects_invoice_id: the link, on the NEW invoice. Fixed once
--    issued. An issued correction must name a REJECTED invoice of its own
--    organisation, company and customer, and carry its date (the tax point).
--    One issued correction per rejected invoice.
--  · 'invoice_correction' joins the journal source types: the entry that, at
--    the correction's issue, mirrors the rejected invoice's entry (a NEW entry;
--    the frozen one is never touched).
--
-- The pre-check refuses, and names, the state this builds on; it repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── PRE-CHECK ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('invoice_is_issued(text, boolean)') IS NULL THEN
    RAISE EXCEPTION 'pre-check REFUSED: invoice_is_issued(text, boolean) (PR C, 0125) does not exist; nothing was changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_entries_source_type_chk' AND conrelid = 'journal_entries'::regclass) THEN
    RAISE EXCEPTION 'pre-check REFUSED: journal_entries_source_type_chk (T1d, 0129) does not exist; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: invoice_is_issued and the T1d source-type check exist';
END $$;--> statement-breakpoint

CREATE TABLE "invoice_rejections" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"invoice_id" integer NOT NULL,
	"einvoice_document_id" uuid,
	"zatca_response" text NOT NULL,
	"reason" text NOT NULL,
	"zatca_rejected_at" timestamp with time zone,
	"recorded_by" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_rejections_evidence_chk" CHECK (length(btrim("invoice_rejections"."zatca_response")) > 0 and length(btrim("invoice_rejections"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "corrects_invoice_id" integer;--> statement-breakpoint
ALTER TABLE "invoice_rejections" ADD CONSTRAINT "invoice_rejections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_rejections" ADD CONSTRAINT "invoice_rejections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_rejections_invoice_unq" ON "invoice_rejections" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_issued_correction_unq" ON "invoices" USING btree ("corrects_invoice_id") WHERE corrects_invoice_id IS NOT NULL AND invoice_is_issued(status, is_opening);--> statement-breakpoint

-- ── Tenancy and grants (the 0130 pattern; owner-only defaults narrowed) ─────
ALTER TABLE public.invoice_rejections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.invoice_rejections
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.invoice_rejections FROM %I', r);
      IF current_setting('server_version_num')::int >= 170000 THEN
        EXECUTE format('REVOKE MAINTAIN ON TABLE public.invoice_rejections FROM %I', r);
      END IF;
      IF r <> 'authenticated' THEN
        EXECUTE format('REVOKE ALL ON TABLE public.invoice_rejections FROM %I', r);
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.invoice_rejections TO authenticated';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.invoice_rejections_id_seq TO authenticated';
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.invoice_rejections FROM authenticated';
  END IF;
END $$;--> statement-breakpoint

-- ── Append-only for EVERY role (the T1b pattern) ─────────────────────────────
CREATE OR REPLACE FUNCTION zz_record_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% on %: this record is append-only for every role; nothing in it is changed or removed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = 'record_append_only';
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER zz_invoice_rejections_append_only BEFORE UPDATE OR DELETE ON "invoice_rejections" FOR EACH ROW EXECUTE FUNCTION zz_record_append_only();--> statement-breakpoint
CREATE TRIGGER zz_invoice_rejections_no_truncate BEFORE TRUNCATE ON "invoice_rejections" FOR EACH STATEMENT EXECUTE FUNCTION zz_record_append_only();--> statement-breakpoint

-- ── A rejection names an ISSUED tax invoice of its own organisation and company ─
CREATE OR REPLACE FUNCTION invoice_rejections_invoice_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- Read as the writer: an invoice the writer cannot see reads as absent, and is refused.
  IF NOT EXISTS (SELECT 1 FROM invoices i
                  WHERE i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id AND i.company_id = NEW.company_id
                    AND i.document_type = 'invoice' AND invoice_is_issued(i.status, i.is_opening)) THEN
    RAISE EXCEPTION 'a rejection names an issued tax invoice of its own organisation and company; invoice % is not one', NEW.invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_rejection_invoice';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER invoice_rejections_invoice_check BEFORE INSERT ON "invoice_rejections" FOR EACH ROW EXECUTE FUNCTION invoice_rejections_invoice_check();--> statement-breakpoint

-- ── The journal source types: 'invoice_correction' joins the T1d list ────────
-- 🔴 Hand-written (drizzle does not track CHECKs). The list is JOURNAL_SOURCE_TYPES; the T1d proof fails if they drift.
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_type_chk";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_type_chk" CHECK (
  source_type IS NULL OR source_type IN (
    'manual', 'recurring', 'reversal',
    'invoice', 'invoice_correction', 'invoice_write_off', 'credit_note_application',
    'customer_payment', 'customer_payment_allocation', 'customer_allocation_correction', 'customer_refund', 'customer_payment_reclassification',
    'bill', 'bill_payment', 'vat_evidence',
    'supplier_payment', 'supplier_advance_allocation', 'supplier_allocation_reversal', 'supplier_payment_reclassification', 'supplier_refund',
    'bank_transfer', 'bank_transaction',
    'payroll_run', 'payroll_net_pay', 'payroll_gosi_payment',
    'depreciation', 'asset_disposal', 'recognition',
    'tax_computation', 'wht_remittance', 'wht_remittance_reversal',
    'migration_opening', 'migration_reversal', 'opening_correction'
  )
);--> statement-breakpoint

-- ── The correction link ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION zz_guard_invoice_correction() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  p invoices%ROWTYPE;
BEGIN
  IF invoice_is_issued(OLD.status, OLD.is_opening) THEN
    IF NEW.corrects_invoice_id IS DISTINCT FROM OLD.corrects_invoice_id THEN
      RAISE EXCEPTION 'invoice % is issued: the invoice it corrects is fixed', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_correction_link_fixed';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.corrects_invoice_id IS NULL OR NOT invoice_is_issued(NEW.status, NEW.is_opening) THEN
    RETURN NEW;
  END IF;
  -- The ISSUING write of a correction: it names a REJECTED, issued tax invoice of its own
  -- organisation, company and customer, and carries its date (the supply's tax point).
  SELECT * INTO p FROM invoices WHERE id = NEW.corrects_invoice_id;
  IF p.id IS NULL OR p.organization_id IS DISTINCT FROM NEW.organization_id OR p.company_id IS DISTINCT FROM NEW.company_id
     OR p.customer_id IS DISTINCT FROM NEW.customer_id OR p.date IS DISTINCT FROM NEW.date
     OR NOT invoice_is_issued(p.status, p.is_opening)
     OR NOT EXISTS (SELECT 1 FROM invoice_rejections r WHERE r.invoice_id = p.id) THEN
    RAISE EXCEPTION 'invoice % corrects invoice %: a correction names a rejected invoice of its own company and customer, and carries its date', NEW.id, NEW.corrects_invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_correction_target';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER zz_invoices_correction_trg BEFORE UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION zz_guard_invoice_correction();
