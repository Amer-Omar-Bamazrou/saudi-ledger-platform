-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 G4c-1 — WHT owner decision 15 (2026-10-27): the payer bears the
-- tax, a PER-CONTRACT setting the user confirms. Register §11.44.
--  · wht_contracts: a non-resident supplier's contract and its setting,
--    tax_inclusive (no gross-up) or net_of_tax (the supplier receives the full
--    amount; gross = net ÷ (1 − rate), the tax on the gross). Append-only for
--    the request's role (SELECT, INSERT): a changed setting is a new contract.
--  · wht_withholdings gains contract_id, tax_bearing and net_amount (all NULL
--    on every existing row: no contract was named, the base is the payment
--    amount — exactly what 0123 enforced).
--  · WHT_BORNE_EXPENSE: a template ROW (not a column), so
--    seed_org_chart_of_accounts() is unchanged (the 0107 AD-13 refinement, the
--    0113 precedent); every existing organisation is back-filled.
--  · wht_withholdings_admit() is redefined from 0123 with two changes only: a
--    net-of-tax row's base must be exactly round(payment ÷ (1 − rate), 2) with
--    its net the payment amount (every other row keeps base = the payment's
--    own); a named contract must be this company's contract with the row's
--    supplier, its setting copied unchanged.
-- No existing row is changed. The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wht_contracts') THEN
    RAISE EXCEPTION 'pre-check REFUSED: wht_contracts already exists; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'wht_withholdings' AND column_name IN ('contract_id', 'tax_bearing', 'net_amount')) THEN
    RAISE EXCEPTION 'pre-check REFUSED: a 0141 column already exists on wht_withholdings; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM system_account_templates WHERE code = 'WHT_BORNE_EXPENSE') OR EXISTS (SELECT 1 FROM categories WHERE system_code = 'WHT_BORNE_EXPENSE') THEN
    RAISE EXCEPTION 'pre-check REFUSED: a WHT_BORNE_EXPENSE account already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: no 0141 table, column or account exists yet';
END $$;--> statement-breakpoint
CREATE TABLE "wht_contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"vendor_id" integer NOT NULL,
	"reference" text NOT NULL,
	"tax_bearing" text NOT NULL,
	"note" text,
	"confirmed_by" integer,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wht_contracts_org_id_unq" UNIQUE("organization_id","id"),
	CONSTRAINT "wht_contracts_bearing_chk" CHECK ("wht_contracts"."tax_bearing" in ('tax_inclusive', 'net_of_tax')),
	CONSTRAINT "wht_contracts_reference_chk" CHECK (length(btrim("wht_contracts"."reference")) > 0)
);
--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD COLUMN "contract_id" integer;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD COLUMN "tax_bearing" text;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD COLUMN "net_amount" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "wht_contracts" ADD CONSTRAINT "wht_contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_contracts" ADD CONSTRAINT "wht_contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_contracts" ADD CONSTRAINT "wht_contracts_vendor_tenant_fk" FOREIGN KEY ("organization_id","vendor_id") REFERENCES "public"."vendors"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wht_contracts_vendor_idx" ON "wht_contracts" USING btree ("company_id","vendor_id");--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_contract_tenant_fk" FOREIGN KEY ("organization_id","contract_id") REFERENCES "public"."wht_contracts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_bearing_chk" CHECK ("wht_withholdings"."tax_bearing" is null or "wht_withholdings"."tax_bearing" in ('tax_inclusive', 'net_of_tax'));--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_contract_chk" CHECK (("wht_withholdings"."contract_id" is null) = ("wht_withholdings"."tax_bearing" is null) and ("wht_withholdings"."contract_id" is null or "wht_withholdings"."status" = 'withheld'));--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_net_chk" CHECK ((coalesce("wht_withholdings"."tax_bearing", '') = 'net_of_tax') = ("wht_withholdings"."net_amount" is not null));--> statement-breakpoint
-- ── The account: a template row, then every existing organisation (the 0113 pattern) ──
INSERT INTO "system_account_templates" (code, name, name_ar, type, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, sort_order)
VALUES ('WHT_BORNE_EXPENSE', 'Withholding tax borne by the company', 'ضريبة استقطاع تتحملها المنشأة', 'expense', true, false, 'O', false, NULL, 388);--> statement-breakpoint
INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, is_posting)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class, true
  FROM organizations o
  CROSS JOIN system_account_templates t
 WHERE t.code = 'WHT_BORNE_EXPENSE'
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint
-- ── Tenancy and grants (the 0130 pattern) ───────────────────────────────────
ALTER TABLE public.wht_contracts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.wht_contracts
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
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.wht_contracts FROM %I', r);
      IF current_setting('server_version_num')::int >= 170000 THEN
        EXECUTE format('REVOKE MAINTAIN ON TABLE public.wht_contracts FROM %I', r);
      END IF;
      IF r <> 'authenticated' THEN
        EXECUTE format('REVOKE ALL ON TABLE public.wht_contracts FROM %I', r);
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- 🔴 APPEND-ONLY for the request's role: a contract is inserted and read, never changed or deleted.
    GRANT SELECT, INSERT ON TABLE public.wht_contracts TO authenticated;
    GRANT USAGE, SELECT ON SEQUENCE public.wht_contracts_id_seq TO authenticated;
    REVOKE UPDATE, DELETE ON TABLE public.wht_contracts FROM authenticated;
  END IF;
END $$;--> statement-breakpoint
-- ── The admit rule (0123's body; the two G4c-1 changes are marked) ─────────
CREATE OR REPLACE FUNCTION wht_withholdings_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p record; v record; r record; rel record; e record; s record; c record; k record; cls text; on_account numeric; filed boolean;
BEGIN
  IF NEW.source_kind = 'bill_payment' THEN
    SELECT bp.id, bp.organization_id, bp.company_id, bp.amount, bp.paid_at, bp.journal_entry_id, bp.bill_id, b.vendor_id
      INTO p FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id WHERE bp.id = NEW.bill_payment_id;
    IF p.id IS NOT NULL AND NEW.bill_id IS DISTINCT FROM p.bill_id THEN
      RAISE EXCEPTION 'withholding: bill % is not the bill payment %''s bill', NEW.bill_id, NEW.bill_payment_id USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_payment';
    END IF;
  ELSE
    SELECT sp.id, sp.organization_id, sp.company_id, sp.amount, sp.paid_at, sp.journal_entry_id, NULL::integer AS bill_id, sp.vendor_id
      INTO p FROM supplier_payments sp WHERE sp.id = NEW.supplier_payment_id;
    IF NEW.bill_id IS NOT NULL THEN
      RAISE EXCEPTION 'withholding: a supplier payment''s withholding names no single bill' USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_payment';
    END IF;
  END IF;
  IF p.id IS NULL OR p.organization_id IS DISTINCT FROM NEW.organization_id OR p.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'withholding: the payment is not in this organisation and company' USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_tenant';
  END IF;
  -- 🔴 G4c-1 (0141, decision 15): the base is the payment's own amount — or, under a NET-OF-TAX contract, exactly the
  -- gross of it: the net is the payment amount (what the supplier received), the base round(net ÷ (1 − rate), 2).
  IF p.vendor_id IS DISTINCT FROM NEW.vendor_id OR p.paid_at IS DISTINCT FROM NEW.payment_date
     OR p.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id
     OR (NEW.tax_bearing IS DISTINCT FROM 'net_of_tax' AND p.amount IS DISTINCT FROM NEW.base_amount)
     OR (NEW.tax_bearing = 'net_of_tax' AND (p.amount IS DISTINCT FROM NEW.net_amount
                                             OR NEW.base_amount IS DISTINCT FROM round(NEW.net_amount / (1 - NEW.rate), 2))) THEN
    RAISE EXCEPTION 'withholding: its supplier, date, base and entry must be the payment''s own (supplier %, %, %, entry %)', p.vendor_id, p.paid_at, p.amount, p.journal_entry_id
      USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_payment';
  END IF;
  IF NEW.contract_id IS NOT NULL THEN
    SELECT id, company_id, vendor_id, tax_bearing INTO k FROM wht_contracts WHERE id = NEW.contract_id AND organization_id = NEW.organization_id;
    IF k.id IS NULL OR k.company_id IS DISTINCT FROM NEW.company_id OR k.vendor_id IS DISTINCT FROM NEW.vendor_id
       OR k.tax_bearing IS DISTINCT FROM NEW.tax_bearing THEN
      RAISE EXCEPTION 'withholding: contract % is not this company''s contract with supplier %, or its setting is not %', NEW.contract_id, NEW.vendor_id, NEW.tax_bearing
        USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_contract';
    END IF;
  END IF;
  SELECT id, organization_id, residency INTO v FROM vendors WHERE id = NEW.vendor_id;
  IF v.id IS NULL OR v.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'withholding: supplier % is not in this organisation', NEW.vendor_id USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_tenant';
  END IF;
  -- dimension 1 — the recipient: only a payment to a NON-RESIDENT is judged at all (Income Tax Law Art. 68)
  IF v.residency <> 'non_resident' THEN
    RAISE EXCEPTION 'withholding: supplier % is not declared non-resident (Income Tax Law Art. 68)', NEW.vendor_id USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_residency';
  END IF;
  SELECT id, organization_id, company_id INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF e.id IS NULL OR e.organization_id IS DISTINCT FROM NEW.organization_id OR e.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'withholding: entry % is not in this organisation and company', NEW.journal_entry_id USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_tenant';
  END IF;

  -- dimension 2 — 🔴 what the money WAS (Q2, 0116). Never residency alone.
  IF NEW.payment_class IS NULL OR NEW.nature_basis IS NULL THEN
    RAISE EXCEPTION 'withholding: a new record states what the money was and how its nature was established (payment_class, nature_basis)'
      USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_provenance';
  END IF;
  IF NEW.source_kind = 'bill_payment' THEN
    cls := 'bill_payment';
  ELSE
    SELECT sp.amount - coalesce((SELECT sum(a.amount) FROM supplier_payment_allocations a
                                  WHERE a.supplier_payment_id = sp.id AND a.journal_entry_id = sp.journal_entry_id), 0),
           sp.classification
      INTO on_account, cls FROM supplier_payments sp WHERE sp.id = NEW.supplier_payment_id;
    IF on_account <= 0 THEN cls := 'allocated'; END IF;
  END IF;
  IF NEW.payment_class IS DISTINCT FROM cls THEN
    RAISE EXCEPTION 'withholding: the payment is %, not % (its classification and allocations decide its class)', cls, NEW.payment_class
      USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_class';
  END IF;
  IF (cls = 'security_deposit' AND NOT (NEW.status = 'not_subject' AND NEW.not_subject_reason = 'refundable_deposit'))
     OR (cls = 'erroneous' AND NOT (NEW.status = 'not_subject' AND NEW.not_subject_reason = 'erroneous_payment'))
     OR (cls = 'unknown' AND NEW.status <> 'pending')
     OR (cls IN ('bill_payment', 'advance', 'allocated')
         AND NOT (NEW.status = 'withheld' OR (NEW.status = 'not_subject' AND NEW.not_subject_reason IN ('goods', 'not_kingdom_source')))) THEN
    RAISE EXCEPTION 'withholding: a % payment cannot be recorded % (%): a refundable deposit and an erroneous payment are not subject, an unidentified one is pending, and only consideration is withheld',
      cls, NEW.status, coalesce(NEW.not_subject_reason, coalesce(NEW.payment_type, '-'))
      USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_class';
  END IF;
  IF NEW.supersedes_withholding_id IS NOT NULL THEN
    SELECT id, supplier_payment_id, status INTO s FROM wht_withholdings WHERE id = NEW.supersedes_withholding_id;
    IF s.id IS NULL OR NEW.source_kind <> 'supplier_payment' OR s.supplier_payment_id IS DISTINCT FROM NEW.supplier_payment_id THEN
      RAISE EXCEPTION 'withholding: % supersedes only a record of the same supplier payment', NEW.supersedes_withholding_id
        USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_supersede';
    END IF;
    IF s.status NOT IN ('pending', 'not_subject') THEN
      RAISE EXCEPTION 'withholding: record % withheld tax; a withholding is corrected (reversed and re-entered), never superseded', s.id
        USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_supersede';
    END IF;
    IF NEW.status = 'withheld' THEN
      RAISE EXCEPTION 'withholding: the payment was made with nothing withheld; tax on it now is open question W-16, never recorded by a reclassification'
        USING ERRCODE = '23514', CONSTRAINT = 'wht_late_withholding';
    END IF;
    IF EXISTS (SELECT 1 FROM wht_corrections x WHERE x.withholding_id = s.id) THEN
      RAISE EXCEPTION 'withholding: record % was corrected; its payment is reversed and is not reclassified', s.id
        USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_supersede';
    END IF;
  END IF;

  -- dimension 3 — the rate: the statutory row in force on the payment date, or an approved relief covering it
  IF NEW.status = 'withheld' THEN
    SELECT id, rate INTO r FROM wht_rates
     WHERE payment_type = NEW.payment_type AND effective_from <= NEW.payment_date AND (effective_to IS NULL OR effective_to >= NEW.payment_date);
    IF r.id IS NULL OR r.id IS DISTINCT FROM NEW.rate_id OR r.rate IS DISTINCT FROM NEW.statutory_rate THEN
      RAISE EXCEPTION 'withholding: the rate must be the % rate in force on % (wht_rates)', NEW.payment_type, NEW.payment_date
        USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_rate';
    END IF;
    IF NEW.treaty_relief_id IS NULL THEN
      IF NEW.rate IS DISTINCT FROM r.rate THEN
        RAISE EXCEPTION 'withholding: without a treaty relief the rate is the statutory % (not %)', r.rate, NEW.rate USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_rate';
      END IF;
    ELSE
      SELECT id, company_id, vendor_id, payment_type, reduced_rate, valid_from, valid_to, status INTO rel FROM vendor_wht_treaty_reliefs WHERE id = NEW.treaty_relief_id;
      IF rel.id IS NULL OR rel.company_id IS DISTINCT FROM NEW.company_id OR rel.vendor_id IS DISTINCT FROM NEW.vendor_id
         OR rel.payment_type IS DISTINCT FROM NEW.payment_type OR rel.status <> 'approved'
         OR NEW.payment_date < rel.valid_from OR NEW.payment_date > rel.valid_to OR rel.reduced_rate IS DISTINCT FROM NEW.rate THEN
        RAISE EXCEPTION 'withholding: treaty relief % does not cover this supplier, nature and date, or is not approved', NEW.treaty_relief_id
          USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_relief';
      END IF;
    END IF;
  END IF;

  -- Q1 — 🔴 the RETURN month: the payment month, unless that month's Form 06 is recorded filed — then the person's treatment
  filed := EXISTS (SELECT 1 FROM wht_return_filings f WHERE f.company_id = NEW.company_id AND f.period = NEW.period);
  IF NEW.status = 'withheld' AND filed THEN
    IF NEW.filed_month_treatment IS NULL THEN
      RAISE EXCEPTION 'withholding: % is recorded as FILED; a withholding in it states whether it is reported in a later return (subsequent_period) or by amending the filed one (amendment)', NEW.period
        USING ERRCODE = '23514', CONSTRAINT = 'wht_month_filed';
    ELSIF NEW.filed_month_treatment = 'amendment' THEN
      IF NEW.return_period <> NEW.period THEN
        RAISE EXCEPTION 'withholding: an amendment reports it in its own month (%), not %', NEW.period, NEW.return_period USING ERRCODE = '23514', CONSTRAINT = 'wht_return_period';
      END IF;
    ELSE
      IF NEW.return_period <= NEW.period
         OR EXISTS (SELECT 1 FROM wht_return_filings f WHERE f.company_id = NEW.company_id AND f.period = NEW.return_period) THEN
        RAISE EXCEPTION 'withholding: a subsequent-period report goes in a LATER month whose return is not filed (not %)', NEW.return_period
          USING ERRCODE = '23514', CONSTRAINT = 'wht_return_period';
      END IF;
      IF NEW.correction_id IS NOT NULL AND NEW.return_period IS DISTINCT FROM (SELECT x.correction_period FROM wht_corrections x WHERE x.id = NEW.correction_id) THEN
        RAISE EXCEPTION 'withholding: a re-entry reported subsequently goes in its correction''s month' USING ERRCODE = '23514', CONSTRAINT = 'wht_return_period';
      END IF;
    END IF;
  ELSIF NEW.filed_month_treatment IS NOT NULL OR NEW.return_period <> NEW.period THEN
    RAISE EXCEPTION 'withholding: only a withholding in a FILED month is reported anywhere but its own month (%)', NEW.period
      USING ERRCODE = '23514', CONSTRAINT = 'wht_return_period';
  END IF;
  -- the re-entry of a correction names it, once, while the correction has no re-entry yet
  IF NEW.correction_id IS NOT NULL THEN
    SELECT id, company_id, corrected_bill_payment_id, corrected_supplier_payment_id INTO c FROM wht_corrections WHERE id = NEW.correction_id;
    IF c.id IS NULL OR c.company_id IS DISTINCT FROM NEW.company_id OR c.corrected_bill_payment_id IS NOT NULL OR c.corrected_supplier_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'withholding: correction % is not this company''s, or already has its re-entry', NEW.correction_id
        USING ERRCODE = '23514', CONSTRAINT = 'wht_correction_link';
    END IF;
    -- 🔴 DR-45 (II), 0123: a correction's re-entry never withholds on a payment made with nothing withheld
    -- (its original was `pending` or `not_subject`) — tax on it now is open question W-16, never recorded by a
    -- re-entry, exactly as a reclassification (the superseding branch above) never records it.
    IF NEW.status = 'withheld' AND EXISTS (SELECT 1 FROM wht_corrections x JOIN wht_withholdings o ON o.id = x.withholding_id
                                            WHERE x.id = NEW.correction_id AND o.status IN ('pending', 'not_subject')) THEN
      RAISE EXCEPTION 'withholding: correction % re-enters a payment made with nothing withheld; tax on it now is open question W-16, never recorded by a correction''s re-entry', NEW.correction_id
        USING ERRCODE = '23514', CONSTRAINT = 'wht_late_withholding';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_withholdings_admit() FROM PUBLIC;
