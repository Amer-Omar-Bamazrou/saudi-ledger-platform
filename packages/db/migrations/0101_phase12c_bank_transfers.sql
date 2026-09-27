-- PHASE 12C — transfers between the business's own banks (2026-09-23).
-- Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §5.
-- Schema reasoning: packages/db/src/schema/bankTransfers.ts.
CREATE TABLE "bank_transfer_reversals" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"transfer_id" integer NOT NULL,
	"reversal_journal_entry_id" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transfer_reversals_reason_chk" CHECK (length(btrim(reason)) > 0)
);
--> statement-breakpoint
CREATE TABLE "bank_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"from_bank_account_id" integer NOT NULL,
	"to_bank_account_id" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"transfer_date" date NOT NULL,
	"reference" text,
	"memo" text,
	"journal_entry_id" integer NOT NULL,
	"duplicate_confirmation_reason" text,
	"idempotency_key" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transfers_amount_chk" CHECK (amount > 0),
	CONSTRAINT "bank_transfers_distinct_banks_chk" CHECK (from_bank_account_id <> to_bank_account_id)
);
--> statement-breakpoint
ALTER TABLE "bank_transfer_reversals" ADD CONSTRAINT "bank_transfer_reversals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer_reversals" ADD CONSTRAINT "bank_transfer_reversals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer_reversals" ADD CONSTRAINT "bank_transfer_reversals_transfer_id_bank_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."bank_transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer_reversals" ADD CONSTRAINT "bank_transfer_reversals_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_from_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("from_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_to_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("to_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transfer_reversals_transfer_unq" ON "bank_transfer_reversals" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "bank_transfers_from_idx" ON "bank_transfers" USING btree ("from_bank_account_id","transfer_date");--> statement-breakpoint
CREATE INDEX "bank_transfers_to_idx" ON "bank_transfers" USING btree ("to_bank_account_id","transfer_date");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transfers_entry_unq" ON "bank_transfers" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transfers_idempotency_unq" ON "bank_transfers" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint

-- ── Phase 12C: tenant isolation, append-only ─────────────────────────────
ALTER TABLE "bank_transfers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."bank_transfers"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
ALTER TABLE "bank_transfer_reversals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."bank_transfer_reversals"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "bank_transfers" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "bank_transfers_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "bank_transfer_reversals" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "bank_transfer_reversals_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_transfers', 'bank_transfer_reversals'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint

-- ── A transfer's entry is exactly its two cash lines, on its two banks ─────
-- The service writes it that way; the database refuses anything else, so a
-- future writer cannot attach a transfer row to some other entry.
CREATE OR REPLACE FUNCTION check_bank_transfer_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE dr_ok boolean; cr_ok boolean; n int;
BEGIN
  -- FK checks run outside RLS: every referenced row must be THIS company's.
  IF NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = NEW.journal_entry_id AND e.company_id = NEW.company_id AND e.status = 'posted')
     OR NOT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.id = NEW.from_bank_account_id AND b.company_id = NEW.company_id)
     OR NOT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.id = NEW.to_bank_account_id AND b.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'bank transfer references an entry or bank account outside its company, or an entry that is not posted'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO n FROM journal_entry_lines WHERE journal_entry_id = NEW.journal_entry_id;
  SELECT EXISTS (SELECT 1 FROM journal_line_bank_identity v WHERE v.journal_entry_id = NEW.journal_entry_id
                  AND v.bank_account_id = NEW.to_bank_account_id AND v.debit_amount = NEW.amount AND v.credit_amount = 0) INTO dr_ok;
  SELECT EXISTS (SELECT 1 FROM journal_line_bank_identity v WHERE v.journal_entry_id = NEW.journal_entry_id
                  AND v.bank_account_id = NEW.from_bank_account_id AND v.credit_amount = NEW.amount AND v.debit_amount = 0) INTO cr_ok;
  IF n <> 2 OR NOT dr_ok OR NOT cr_ok THEN
    RAISE EXCEPTION 'bank transfer % must name an entry of exactly two cash lines: Dr bank % / Cr bank % for %',
      NEW.id, NEW.to_bank_account_id, NEW.from_bank_account_id, NEW.amount USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER bank_transfers_entry_check BEFORE INSERT ON bank_transfers
  FOR EACH ROW EXECUTE FUNCTION check_bank_transfer_entry();--> statement-breakpoint

-- ── 🔴 An entry a statement line is reconciled to cannot be reversed ───────
-- journal_line_bank_identity carries no status filter, so a reversed entry's
-- cash line would go on "reconciling" a statement line whose movement the
-- books now cancel. Undo the reconciliation first; the line's OWN posting
-- (source 'posted') is excluded — un-accepting a line is its own path.
CREATE OR REPLACE FUNCTION refuse_reversing_reconciled_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'reversed' AND OLD.status IS DISTINCT FROM 'reversed' AND EXISTS (
       SELECT 1 FROM bank_line_reconciliation r
         JOIN journal_entry_lines l ON l.id = r.line_id
        WHERE l.journal_entry_id = NEW.id AND r.source <> 'posted') THEN
    RAISE EXCEPTION 'journal entry % is reconciled to a bank statement line; undo the reconciliation before reversing it', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER journal_entries_reconciled_reversal_check BEFORE UPDATE OF status ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION refuse_reversing_reconciled_entry();--> statement-breakpoint

-- ── A transfer's reversal names ITS OWN entry's mirror ────────────────────
CREATE OR REPLACE FUNCTION check_bank_transfer_reversal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM bank_transfers bt
         JOIN journal_entries m ON m.id = NEW.reversal_journal_entry_id
        WHERE bt.id = NEW.transfer_id AND bt.company_id = NEW.company_id
          AND m.company_id = NEW.company_id AND m.reversal_of = bt.journal_entry_id) THEN
    RAISE EXCEPTION 'bank transfer reversal % must name the mirror of its transfer''s own entry', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER bank_transfer_reversals_check BEFORE INSERT ON bank_transfer_reversals
  FOR EACH ROW EXECUTE FUNCTION check_bank_transfer_reversal();--> statement-breakpoint

-- ── Pre-N3 bill payments: name their entry where it is UNAMBIGUOUS ─────────
-- Before N3 a bill payment's entry was numbered BILL-<bill>-PAY with no
-- payment id, so 0100's back-fill could not link it. Linked here only when
-- the bill has ONE payment, ONE entry carries that number in its company, and
-- that entry credits a cash line for exactly the payment's amount. Anything
-- else stays NULL (it is still in the books; it just cannot be named).
UPDATE bill_payments bp
   SET journal_entry_id = e.id
  FROM bills b, journal_entries e
 WHERE bp.bill_id = b.id
   AND bp.journal_entry_id IS NULL
   AND e.organization_id = b.organization_id AND e.company_id = b.company_id
   AND e.entry_number = 'BILL-' || b.bill_number || '-PAY'
   AND (SELECT count(*) FROM bill_payments x WHERE x.bill_id = b.id) = 1
   AND (SELECT count(*) FROM journal_entries y
         WHERE y.organization_id = b.organization_id AND y.company_id = b.company_id
           AND y.entry_number = e.entry_number) = 1
   AND EXISTS (SELECT 1 FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
                WHERE l.journal_entry_id = e.id AND c.liquidity_class = 'cash' AND l.credit_amount = bp.amount);--> statement-breakpoint
