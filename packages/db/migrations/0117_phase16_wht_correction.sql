CREATE TABLE "wht_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"withholding_id" integer NOT NULL,
	"source_kind" text NOT NULL,
	"bill_payment_id" integer,
	"supplier_payment_id" integer,
	"reason" text NOT NULL,
	"corrected_on" date NOT NULL,
	"correction_period" text NOT NULL,
	"reversal_journal_entry_id" integer NOT NULL,
	"reversal_return_period" text NOT NULL,
	"filed_month_treatment" text,
	"original_filing_id" integer,
	"remitted_at_correction" numeric(15, 2) NOT NULL,
	"corrected_bill_payment_id" integer,
	"corrected_supplier_payment_id" integer,
	"idempotency_key" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wht_corrections_source_chk" CHECK (("wht_corrections"."source_kind" = 'bill_payment' and "wht_corrections"."bill_payment_id" is not null and "wht_corrections"."supplier_payment_id" is null)
      or ("wht_corrections"."source_kind" = 'supplier_payment' and "wht_corrections"."supplier_payment_id" is not null and "wht_corrections"."bill_payment_id" is null)),
	CONSTRAINT "wht_corrections_reason_chk" CHECK (length(btrim("wht_corrections"."reason")) >= 10),
	CONSTRAINT "wht_corrections_period_chk" CHECK ("wht_corrections"."correction_period" = to_char("wht_corrections"."corrected_on", 'YYYY-MM') and "wht_corrections"."reversal_return_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "wht_corrections_treatment_chk" CHECK ("wht_corrections"."filed_month_treatment" is null or "wht_corrections"."filed_month_treatment" in ('subsequent_period', 'amendment')),
	CONSTRAINT "wht_corrections_reentry_chk" CHECK ("wht_corrections"."corrected_bill_payment_id" is null or "wht_corrections"."corrected_supplier_payment_id" is null)
);
--> statement-breakpoint
CREATE TABLE "wht_return_filings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"period" text NOT NULL,
	"kind" text NOT NULL,
	"amends_filing_id" integer,
	"filed_on" date NOT NULL,
	"zatca_reference" text NOT NULL,
	"tax_withheld" numeric(15, 2) NOT NULL,
	"payment_total" numeric(15, 2) NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wht_return_filings_period_chk" CHECK ("wht_return_filings"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "wht_return_filings_kind_chk" CHECK ("wht_return_filings"."kind" in ('original', 'amendment') and (("wht_return_filings"."kind" = 'original') = ("wht_return_filings"."amends_filing_id" is null))),
	CONSTRAINT "wht_return_filings_reference_chk" CHECK (length(btrim("wht_return_filings"."zatca_reference")) >= 3),
	CONSTRAINT "wht_return_filings_after_month_chk" CHECK ("wht_return_filings"."filed_on" >= (to_date("wht_return_filings"."period" || '-01', 'YYYY-MM-DD') + interval '1 month')::date)
);
--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD COLUMN "return_period" text;--> statement-breakpoint
-- every withholding written before Q1 is reported in its own payment month (no month was recorded filed before 0117);
-- the table is append-only for every role, so the back-fill pauses that one trigger, in this migration only
ALTER TABLE "wht_withholdings" DISABLE TRIGGER wht_withholdings_append_only;--> statement-breakpoint
UPDATE "wht_withholdings" SET "return_period" = "period" WHERE "return_period" IS NULL;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ENABLE TRIGGER wht_withholdings_append_only;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ALTER COLUMN "return_period" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD COLUMN "filed_month_treatment" text;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD COLUMN "correction_id" integer;--> statement-breakpoint
ALTER TABLE "wht_corrections" ADD CONSTRAINT "wht_corrections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_corrections" ADD CONSTRAINT "wht_corrections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_corrections" ADD CONSTRAINT "wht_corrections_withholding_id_wht_withholdings_id_fk" FOREIGN KEY ("withholding_id") REFERENCES "public"."wht_withholdings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_corrections" ADD CONSTRAINT "wht_corrections_bill_payment_id_bill_payments_id_fk" FOREIGN KEY ("bill_payment_id") REFERENCES "public"."bill_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_corrections" ADD CONSTRAINT "wht_corrections_supplier_payment_id_supplier_payments_id_fk" FOREIGN KEY ("supplier_payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_corrections" ADD CONSTRAINT "wht_corrections_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_corrections" ADD CONSTRAINT "wht_corrections_original_filing_id_wht_return_filings_id_fk" FOREIGN KEY ("original_filing_id") REFERENCES "public"."wht_return_filings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_corrections" ADD CONSTRAINT "wht_corrections_corrected_bill_payment_id_bill_payments_id_fk" FOREIGN KEY ("corrected_bill_payment_id") REFERENCES "public"."bill_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_corrections" ADD CONSTRAINT "wht_corrections_corrected_supplier_payment_id_supplier_payments_id_fk" FOREIGN KEY ("corrected_supplier_payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_return_filings" ADD CONSTRAINT "wht_return_filings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_return_filings" ADD CONSTRAINT "wht_return_filings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_return_filings" ADD CONSTRAINT "wht_return_filings_amends_filing_id_wht_return_filings_id_fk" FOREIGN KEY ("amends_filing_id") REFERENCES "public"."wht_return_filings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wht_corrections_withholding_unq" ON "wht_corrections" USING btree ("withholding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wht_corrections_entry_unq" ON "wht_corrections" USING btree ("reversal_journal_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wht_corrections_idempotency_unq" ON "wht_corrections" USING btree ("company_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE INDEX "wht_corrections_return_period_idx" ON "wht_corrections" USING btree ("company_id","reversal_return_period");--> statement-breakpoint
CREATE INDEX "wht_corrections_bill_payment_idx" ON "wht_corrections" USING btree ("bill_payment_id");--> statement-breakpoint
CREATE INDEX "wht_corrections_supplier_payment_idx" ON "wht_corrections" USING btree ("supplier_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wht_return_filings_one_original_unq" ON "wht_return_filings" USING btree ("company_id","period") WHERE kind = 'original';--> statement-breakpoint
CREATE INDEX "wht_return_filings_period_idx" ON "wht_return_filings" USING btree ("company_id","period");--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_correction_id_wht_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."wht_corrections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wht_withholdings_correction_unq" ON "wht_withholdings" USING btree ("correction_id") WHERE correction_id is not null;--> statement-breakpoint
CREATE INDEX "wht_withholdings_return_period_idx" ON "wht_withholdings" USING btree ("company_id","return_period");--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_return_period_chk" CHECK ("wht_withholdings"."return_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and "wht_withholdings"."return_period" >= "wht_withholdings"."period");--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_filed_treatment_chk" CHECK ("wht_withholdings"."filed_month_treatment" is null or "wht_withholdings"."filed_month_treatment" in ('subsequent_period', 'amendment'));
--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Accountant Q1 (2026-10-05) — correcting a WHT-bearing payment.
-- Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §14.1.
--
-- Reversal + re-entry: the original withholding and its payment are never
-- changed; a CORRECTION records the mirror of the payment's entry (why, who,
-- when) and the corrected re-entry is a new payment through the existing pay
-- path, linked both ways (original → reversal → corrected).
--
-- The return month is a fact the database keeps:
--   1. `wht_return_tax` / `wht_return_base` — the ONE definition of what a
--      month's return carries: Σ withholdings whose RETURN month it is − Σ the
--      corrections whose reversal it carries. The remittance cap, the filing
--      snapshot and every report read it.
--   2. a FILING record: the month's Form 06 as filed (the snapshot is the
--      ledger's own figure, written here, never typed) and each amendment.
--   3. 🔴 a withholding or a reversal never lands in a FILED month silently:
--      the person states the treatment — a later, unfiled return
--      (subsequent_period, the accountant's recommendation) or an amendment of
--      the filed one (ZATCA supports amendment; which applies when is the
--      adviser's — §14.1). Neither stated → refused.
--   4. WHT_PAYABLE's writers become three: a withholding, a remittance (and its
--      reversal), and a correction's reversal — W1 stays exact by construction.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. What a month's return carries — the ONE definition ───────────────────
CREATE OR REPLACE FUNCTION wht_return_tax(p_company_id uuid, p_period text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT sum(w.wht_amount) FROM wht_withholdings w
                    WHERE w.company_id = p_company_id AND w.return_period = p_period AND w.status = 'withheld'), 0)
       - coalesce((SELECT sum(w.wht_amount) FROM wht_corrections c JOIN wht_withholdings w ON w.id = c.withholding_id
                    WHERE c.company_id = p_company_id AND c.reversal_return_period = p_period AND w.status = 'withheld'), 0)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_return_tax(uuid, text) FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE FUNCTION wht_return_base(p_company_id uuid, p_period text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT sum(w.base_amount) FROM wht_withholdings w
                    WHERE w.company_id = p_company_id AND w.return_period = p_period AND w.status = 'withheld'), 0)
       - coalesce((SELECT sum(w.base_amount) FROM wht_corrections c JOIN wht_withholdings w ON w.id = c.withholding_id
                    WHERE c.company_id = p_company_id AND c.reversal_return_period = p_period AND w.status = 'withheld'), 0)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_return_base(uuid, text) FROM PUBLIC;--> statement-breakpoint
-- a month still owes its return's tax less what was remitted for it (a correction can make that negative: over-remitted)
CREATE OR REPLACE FUNCTION wht_unremitted(p_company_id uuid, p_period text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_period IS NULL THEN
           coalesce((SELECT sum(l.credit_amount - l.debit_amount) FROM journal_entry_lines l
                       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
                      WHERE e.company_id = p_company_id AND c.system_code = 'WHT_PAYABLE' AND e.status IN ('posted', 'reversed')
                        AND e.source IN ('opening', 'opening_reversal', 'opening_correction')), 0)
         ELSE wht_return_tax(p_company_id, p_period)
         END
       - coalesce((SELECT sum(r.amount) FROM wht_remittances r
                    WHERE r.company_id = p_company_id AND r.period IS NOT DISTINCT FROM p_period
                      AND NOT EXISTS (SELECT 1 FROM wht_remittance_reversals x WHERE x.remittance_id = r.id)), 0)
$$;--> statement-breakpoint

-- ── 2. The withholding admit (0116) + the return month (Q1) ─────────────────
CREATE OR REPLACE FUNCTION wht_withholdings_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p record; v record; r record; rel record; e record; s record; c record; cls text; on_account numeric; filed boolean;
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
  IF p.vendor_id IS DISTINCT FROM NEW.vendor_id OR p.paid_at IS DISTINCT FROM NEW.payment_date
     OR p.amount IS DISTINCT FROM NEW.base_amount OR p.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id THEN
    RAISE EXCEPTION 'withholding: its supplier, date, base and entry must be the payment''s own (supplier %, %, %, entry %)', p.vendor_id, p.paid_at, p.amount, p.journal_entry_id
      USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_payment';
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
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_withholdings_admit() FROM PUBLIC;--> statement-breakpoint

-- ── 3. The filing record — the return AS FILED, written by the ledger ───────
CREATE OR REPLACE FUNCTION wht_return_filings_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE co record; a record;
BEGIN
  SELECT id, organization_id INTO co FROM companies WHERE id = NEW.company_id;
  IF co.id IS NULL OR co.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'WHT filing: company % is not in this organisation', NEW.company_id USING ERRCODE = '23514', CONSTRAINT = 'wht_filing_tenant';
  END IF;
  IF NEW.kind = 'amendment' THEN
    SELECT id, company_id, period INTO a FROM wht_return_filings WHERE id = NEW.amends_filing_id;
    IF a.id IS NULL OR a.company_id IS DISTINCT FROM NEW.company_id OR a.period IS DISTINCT FROM NEW.period THEN
      RAISE EXCEPTION 'WHT filing: an amendment amends a filing of the same month and company' USING ERRCODE = '23514', CONSTRAINT = 'wht_filing_amends';
    END IF;
    IF EXISTS (SELECT 1 FROM wht_return_filings f WHERE f.company_id = NEW.company_id AND f.period = NEW.period AND f.id > a.id) THEN
      RAISE EXCEPTION 'WHT filing: % has a later filing than %; an amendment amends the latest', NEW.period, a.id USING ERRCODE = '23514', CONSTRAINT = 'wht_filing_amends';
    END IF;
  END IF;
  -- serialised with the month's remittances and corrections; the snapshot IS the ledger's return at this moment
  PERFORM pg_advisory_xact_lock(hashtext('wht-remit:' || NEW.company_id::text || ':' || NEW.period));
  NEW.tax_withheld := wht_return_tax(NEW.company_id, NEW.period);
  NEW.payment_total := wht_return_base(NEW.company_id, NEW.period);
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_return_filings_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER wht_return_filings_admit BEFORE INSERT ON "wht_return_filings" FOR EACH ROW EXECUTE FUNCTION wht_return_filings_admit();--> statement-breakpoint
CREATE TRIGGER wht_return_filings_append_only BEFORE UPDATE OR DELETE ON "wht_return_filings" FOR EACH ROW EXECUTE FUNCTION wht_append_only();--> statement-breakpoint

-- ── 4. The correction — admitted only as a true mirror, its return month the rule's ──
CREATE OR REPLACE FUNCTION wht_corrections_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE w record; e record; f_id integer;
BEGIN
  SELECT id, organization_id, company_id, source_kind, bill_payment_id, supplier_payment_id, status, return_period, journal_entry_id, payment_date
    INTO w FROM wht_withholdings WHERE id = NEW.withholding_id;
  IF w.id IS NULL OR w.organization_id IS DISTINCT FROM NEW.organization_id OR w.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'WHT correction: withholding % is not in this organisation and company', NEW.withholding_id USING ERRCODE = '23514', CONSTRAINT = 'wht_correction_tenant';
  END IF;
  IF NEW.source_kind IS DISTINCT FROM w.source_kind OR NEW.bill_payment_id IS DISTINCT FROM w.bill_payment_id OR NEW.supplier_payment_id IS DISTINCT FROM w.supplier_payment_id THEN
    RAISE EXCEPTION 'WHT correction: it names the withholding''s own payment' USING ERRCODE = '23514', CONSTRAINT = 'wht_correction_source';
  END IF;
  IF EXISTS (SELECT 1 FROM wht_withholdings s WHERE s.supersedes_withholding_id = w.id) THEN
    RAISE EXCEPTION 'WHT correction: withholding % was superseded by a reclassification; correct the payment''s current record', w.id
      USING ERRCODE = '23514', CONSTRAINT = 'wht_correction_superseded';
  END IF;
  -- the reversal mirrors the payment's own entry, in this company, on the correction date, never before the payment
  SELECT id, company_id, reversal_of, date::date AS d INTO e FROM journal_entries WHERE id = NEW.reversal_journal_entry_id;
  IF e.id IS NULL OR e.company_id IS DISTINCT FROM NEW.company_id OR e.reversal_of IS DISTINCT FROM w.journal_entry_id
     OR e.d IS DISTINCT FROM NEW.corrected_on OR NEW.corrected_on < w.payment_date THEN
    RAISE EXCEPTION 'WHT correction: entry % is not the mirror of the payment''s entry % dated %', NEW.reversal_journal_entry_id, w.journal_entry_id, NEW.corrected_on
      USING ERRCODE = '23514', CONSTRAINT = 'wht_correction_entry';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wht-remit:' || NEW.company_id::text || ':' || w.return_period));
  -- the state the original was in, written by the database: its month's latest filing, and what of its month was remitted
  SELECT f.id INTO f_id FROM wht_return_filings f WHERE f.company_id = NEW.company_id AND f.period = w.return_period ORDER BY f.id DESC LIMIT 1;
  NEW.original_filing_id := f_id;
  NEW.remitted_at_correction := coalesce((SELECT sum(r.amount) FROM wht_remittances r
                                           WHERE r.company_id = NEW.company_id AND r.period = w.return_period
                                             AND NOT EXISTS (SELECT 1 FROM wht_remittance_reversals x WHERE x.remittance_id = r.id)), 0);
  NEW.corrected_bill_payment_id := NULL;
  NEW.corrected_supplier_payment_id := NULL;
  -- 🔴 the RETURN month of the reversal: the original's own while it is unfiled ("reflected in the applicable filing");
  -- after filing, the person's treatment — never silently the filed month
  IF w.status = 'withheld' AND f_id IS NOT NULL THEN
    IF NEW.filed_month_treatment IS NULL THEN
      RAISE EXCEPTION 'WHT correction: % is recorded as FILED; state whether the correction is reported in a later return (subsequent_period) or by amending the filed one (amendment)', w.return_period
        USING ERRCODE = '23514', CONSTRAINT = 'wht_month_filed';
    ELSIF NEW.filed_month_treatment = 'amendment' THEN
      IF NEW.reversal_return_period IS DISTINCT FROM w.return_period THEN
        RAISE EXCEPTION 'WHT correction: an amendment reports the reversal in the filed month %', w.return_period USING ERRCODE = '23514', CONSTRAINT = 'wht_return_period';
      END IF;
    ELSIF NEW.reversal_return_period IS DISTINCT FROM NEW.correction_period OR NEW.correction_period <= w.return_period
       OR EXISTS (SELECT 1 FROM wht_return_filings f WHERE f.company_id = NEW.company_id AND f.period = NEW.correction_period) THEN
      RAISE EXCEPTION 'WHT correction: a subsequent-period correction is reported in its own month (%), which must be later than % and not filed', NEW.correction_period, w.return_period
        USING ERRCODE = '23514', CONSTRAINT = 'wht_return_period';
    END IF;
  ELSIF NEW.filed_month_treatment IS NOT NULL OR NEW.reversal_return_period IS DISTINCT FROM w.return_period THEN
    RAISE EXCEPTION 'WHT correction: % is not filed (or carried no tax): the reversal is reported in that month''s own return', w.return_period
      USING ERRCODE = '23514', CONSTRAINT = 'wht_return_period';
  END IF;
  IF NEW.reversal_return_period <> w.return_period THEN
    PERFORM pg_advisory_xact_lock(hashtext('wht-remit:' || NEW.company_id::text || ':' || NEW.reversal_return_period));
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_corrections_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER wht_corrections_admit BEFORE INSERT ON "wht_corrections" FOR EACH ROW EXECUTE FUNCTION wht_corrections_admit();--> statement-breakpoint
-- append-only, but for the ONE link written after the re-entry exists — once, to a payment of this company
CREATE OR REPLACE FUNCTION wht_corrections_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wht_corrections: a correction is a record for ZATCA; it is never deleted' USING ERRCODE = '23514', CONSTRAINT = 'wht_append_only';
  END IF;
  IF OLD.corrected_bill_payment_id IS NOT NULL OR OLD.corrected_supplier_payment_id IS NOT NULL
     OR (to_jsonb(NEW) - 'corrected_bill_payment_id' - 'corrected_supplier_payment_id') <> (to_jsonb(OLD) - 'corrected_bill_payment_id' - 'corrected_supplier_payment_id')
     OR (NEW.corrected_bill_payment_id IS NULL AND NEW.corrected_supplier_payment_id IS NULL) THEN
    RAISE EXCEPTION 'wht_corrections: correction % is append-only; only its re-entry is linked, once', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'wht_correction_immutable';
  END IF;
  ok := CASE WHEN NEW.corrected_bill_payment_id IS NOT NULL
             THEN EXISTS (SELECT 1 FROM bill_payments bp WHERE bp.id = NEW.corrected_bill_payment_id AND bp.company_id = NEW.company_id)
             ELSE EXISTS (SELECT 1 FROM supplier_payments sp WHERE sp.id = NEW.corrected_supplier_payment_id AND sp.company_id = NEW.company_id) END;
  -- a re-entry that withholds names this correction (its withholding row's correction_id) — the two links agree
  ok := ok AND NOT EXISTS (SELECT 1 FROM wht_withholdings w WHERE w.correction_id = NEW.id
                             AND (w.bill_payment_id IS DISTINCT FROM NEW.corrected_bill_payment_id OR w.supplier_payment_id IS DISTINCT FROM NEW.corrected_supplier_payment_id));
  IF NOT ok THEN
    RAISE EXCEPTION 'wht_corrections: correction %''s re-entry must be a payment of this company, the one its withholding names', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'wht_correction_link';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_corrections_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER wht_corrections_guard BEFORE UPDATE OR DELETE ON "wht_corrections" FOR EACH ROW EXECUTE FUNCTION wht_corrections_guard();--> statement-breakpoint

-- ── 5. 🔴 WHT_PAYABLE: a correction's reversal is its THIRD writer ─────────
CREATE OR REPLACE FUNCTION wht_payable_line_owned() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e record; net numeric; expected numeric; owned boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = NEW.account_id AND c.system_code = 'WHT_PAYABLE') THEN RETURN NULL; END IF;
  SELECT id, entry_number, source INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF e.id IS NULL OR e.source IN ('opening', 'opening_reversal', 'opening_correction') THEN RETURN NULL; END IF;
  owned := EXISTS (SELECT 1 FROM wht_withholdings WHERE journal_entry_id = e.id)
        OR EXISTS (SELECT 1 FROM wht_remittances WHERE journal_entry_id = e.id)
        OR EXISTS (SELECT 1 FROM wht_remittance_reversals WHERE journal_entry_id = e.id)
        OR EXISTS (SELECT 1 FROM wht_corrections WHERE reversal_journal_entry_id = e.id);
  IF NOT owned THEN
    RAISE EXCEPTION 'journal entry % (%) moves Withholding tax payable, but no WHT record owns it: WHT is withheld only by a supplier payment, settled only by a WHT remittance and reversed only by a WHT correction',
      e.id, e.entry_number USING ERRCODE = '23514', CONSTRAINT = 'wht_payable_unowned';
  END IF;
  SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0) INTO net
    FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
   WHERE l.journal_entry_id = e.id AND c.system_code = 'WHT_PAYABLE';
  -- a supplier payment's superseded records share its entry: only the LIVE ones count (they carry no tax anyway)
  expected := coalesce((SELECT sum(w.wht_amount) FROM wht_withholdings w WHERE w.journal_entry_id = e.id AND w.status = 'withheld'), 0)
            - coalesce((SELECT sum(r.amount) FROM wht_remittances r WHERE r.journal_entry_id = e.id), 0)
            + coalesce((SELECT sum(r.amount) FROM wht_remittance_reversals x JOIN wht_remittances r ON r.id = x.remittance_id WHERE x.journal_entry_id = e.id), 0)
            - coalesce((SELECT sum(w.wht_amount) FROM wht_corrections x JOIN wht_withholdings w ON w.id = x.withholding_id
                         WHERE x.reversal_journal_entry_id = e.id AND w.status = 'withheld'), 0);
  IF net <> expected THEN
    RAISE EXCEPTION 'journal entry % (%) moves Withholding tax payable by % but its WHT records say %', e.id, e.entry_number, net, expected
      USING ERRCODE = '23514', CONSTRAINT = 'wht_payable_amount';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_payable_line_owned() FROM PUBLIC;--> statement-breakpoint

-- ── 6. The owner predicate and the reversal guard ──────────────────────────
CREATE OR REPLACE FUNCTION tax_journal_owner(p_entry_id integer) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM wht_withholdings WHERE journal_entry_id = p_entry_id) THEN 'wht_withholding'
    WHEN EXISTS (SELECT 1 FROM wht_remittances WHERE journal_entry_id = p_entry_id) THEN 'wht_remittance'
    WHEN EXISTS (SELECT 1 FROM wht_remittance_reversals WHERE journal_entry_id = p_entry_id) THEN 'wht_remittance_reversal'
    WHEN EXISTS (SELECT 1 FROM wht_corrections WHERE reversal_journal_entry_id = p_entry_id) THEN 'wht_correction'
    WHEN EXISTS (SELECT 1 FROM tax_computation_versions WHERE accrual_journal_entry_id = p_entry_id) THEN 'tax_accrual'
  END
$$;--> statement-breakpoint
-- 🔴 a withholding's payment entry is marked reversed ONLY by its correction (the mirror exists and the record says why)
CREATE OR REPLACE FUNCTION journal_entries_tax_reversal_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'posted' AND NEW.status = 'reversed' AND tax_journal_protected(NEW.id)
     AND NOT EXISTS (SELECT 1 FROM wht_corrections c JOIN wht_withholdings w ON w.id = c.withholding_id
                      JOIN journal_entries m ON m.id = c.reversal_journal_entry_id
                     WHERE w.journal_entry_id = NEW.id AND m.reversal_of = NEW.id) THEN
    RAISE EXCEPTION 'journal entry % (%) belongs to a WHT record or a tax computation; it is corrected through that record, never reversed generically',
      NEW.id, NEW.entry_number USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_tax_reversal_guard';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ── 7. Tenancy, grants ──────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wht_return_filings', 'wht_corrections'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY "tenant_isolation" ON public.%I
      USING ( (organization_id)::text = current_setting('app.current_org_id', true)
              AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                    OR (company_id)::text = current_setting('app.current_company_id', true) ) )
      WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
              AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                    OR (company_id)::text = current_setting('app.current_company_id', true) ) )$p$, t);
  END LOOP;
END $$;--> statement-breakpoint
-- append-only: a filing is INSERT + SELECT; a correction also UPDATEs its one link (the guard admits nothing else)
GRANT SELECT, INSERT ON TABLE "wht_return_filings" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "wht_return_filings_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "wht_corrections" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "wht_corrections_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['wht_return_filings', 'wht_corrections'] LOOP
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
        IF current_setting('server_version_num')::int >= 170000 THEN
          EXECUTE format('REVOKE MAINTAIN ON TABLE public.%I FROM %I', t, r);
        END IF;
        IF r <> 'authenticated' THEN
          EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE DELETE ON TABLE public.wht_return_filings, public.wht_corrections FROM authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.wht_return_tax(uuid, text) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.wht_return_base(uuid, text) TO authenticated';
  END IF;
END $$;
