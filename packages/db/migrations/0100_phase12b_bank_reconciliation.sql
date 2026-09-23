CREATE TABLE "bank_statement_link_reversals" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"link_id" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_link_reversals_reason_chk" CHECK (length(trim(reason)) > 0)
);
--> statement-breakpoint
CREATE TABLE "bank_statement_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"transaction_id" integer NOT NULL,
	"journal_line_id" integer NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"method" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"idempotency_key" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_links_amount_chk" CHECK (amount > 0),
	CONSTRAINT "bank_statement_links_method_chk" CHECK (method IN ('manual', 'deterministic', 'settlement', 'transfer'))
);
--> statement-breakpoint
ALTER TABLE "bill_payments" ADD COLUMN "journal_entry_id" integer;--> statement-breakpoint
ALTER TABLE "bank_statement_link_reversals" ADD CONSTRAINT "bank_statement_link_reversals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_link_reversals" ADD CONSTRAINT "bank_statement_link_reversals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_link_reversals" ADD CONSTRAINT "bank_statement_link_reversals_link_id_bank_statement_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."bank_statement_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_links" ADD CONSTRAINT "bank_statement_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_links" ADD CONSTRAINT "bank_statement_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_links" ADD CONSTRAINT "bank_statement_links_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_links" ADD CONSTRAINT "bank_statement_links_journal_line_id_journal_entry_lines_id_fk" FOREIGN KEY ("journal_line_id") REFERENCES "public"."journal_entry_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_link_reversals_link_unq" ON "bank_statement_link_reversals" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "bank_statement_links_transaction_idx" ON "bank_statement_links" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "bank_statement_links_line_idx" ON "bank_statement_links" USING btree ("journal_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_links_idempotency_unq" ON "bank_statement_links" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 12B — reconciling statement lines to the ledger (decision pack §4).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. A bill payment names its entry ──────────────────────────────────────
-- The pay path has always numbered its entry BILL-<bill number>-PAY-<payment
-- id> (N3); that convention is the only link older rows have, so it is used
-- ONCE, here, to write the real one. From now on billsService.pay writes it.
UPDATE bill_payments bp
   SET journal_entry_id = e.id
  FROM bills b, journal_entries e
 WHERE b.id = bp.bill_id
   AND e.company_id = bp.company_id
   AND e.entry_number = 'BILL-' || b.bill_number || '-PAY-' || bp.id
   AND bp.journal_entry_id IS NULL;--> statement-breakpoint

-- ── 2. Tenancy: RLS with the N1 company arm; append-only grants ────────────
ALTER TABLE "bank_statement_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."bank_statement_links"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
ALTER TABLE "bank_statement_link_reversals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."bank_statement_link_reversals"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "bank_statement_links" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "bank_statement_links_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "bank_statement_link_reversals" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "bank_statement_link_reversals_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_statement_links', 'bank_statement_link_reversals'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint

-- ── 3. 🔴 THE ONE DEFINITION: what reconciles a statement line ─────────────
-- Every way a statement line can be answered by a GL cash line on ITS OWN
-- bank, with the amount it accounts for. Readers — the workbench, the
-- reconciliation (12D), the reports, the caps below — read this and nothing
-- else. Each source keeps its own single writer:
--   posted         an accepted line that posted its own entry (transactionPosting)
--   ar_match       a Phase D match to a receipt / customer refund (statementMatching)
--   ar_settlement  a receipt CREATED from the line in Review (payments.source_transaction_id)
--   link           everything else (bank_statement_links: supplier payments and
--                  refunds, bill payments, journals, transfers; partial, multi)
-- A superseded match or link is not here. 🔴 An entry's STATUS is not
-- filtered (journal_line_bank_identity carries none): a link is made only
-- to a `posted` entry (the trigger below), and an entry a line is reconciled
-- to cannot then be reversed (migration 0101's journal-entry trigger).
-- A Phase D match or a Review settlement counts for the SMALLER of the two
-- amounts: an override may match a receipt of a different amount (recorded
-- as evidence), and neither side may read as more reconciled than it is.
CREATE OR REPLACE VIEW "bank_line_reconciliation" WITH (security_invoker = true) AS
  SELECT t.id AS transaction_id, v.line_id, abs(v.debit_amount - v.credit_amount) AS amount,
         'posted'::text AS source, t.id AS source_id, t.organization_id, t.company_id
    FROM transactions t
    JOIN journal_line_bank_identity v ON v.journal_entry_id = t.journal_entry_id AND v.bank_account_id = t.bank_account_id
   WHERE t.journal_entry_id IS NOT NULL
  UNION ALL
  SELECT m.transaction_id, v.line_id, least(abs(t.amount), abs(v.debit_amount - v.credit_amount)),
         'ar_match', m.id, m.organization_id, m.company_id
    FROM statement_matches m
    JOIN transactions t ON t.id = m.transaction_id
    JOIN payments p ON p.id = m.payment_id
    JOIN journal_line_bank_identity v ON v.journal_entry_id = p.journal_entry_id AND v.bank_account_id = t.bank_account_id
   WHERE NOT EXISTS (SELECT 1 FROM statement_match_reversals r WHERE r.match_id = m.id)
  UNION ALL
  SELECT m.transaction_id, v.line_id, least(abs(t.amount), abs(v.debit_amount - v.credit_amount)),
         'ar_match', m.id, m.organization_id, m.company_id
    FROM statement_matches m
    JOIN transactions t ON t.id = m.transaction_id
    JOIN customer_refunds f ON f.id = m.refund_id
    JOIN journal_line_bank_identity v ON v.journal_entry_id = f.journal_entry_id AND v.bank_account_id = t.bank_account_id
   WHERE NOT EXISTS (SELECT 1 FROM statement_match_reversals r WHERE r.match_id = m.id)
  UNION ALL
  SELECT p.source_transaction_id, v.line_id, least(abs(t.amount), abs(v.debit_amount - v.credit_amount)),
         'ar_settlement', p.id, p.organization_id, p.company_id
    FROM payments p
    JOIN transactions t ON t.id = p.source_transaction_id
    JOIN journal_line_bank_identity v ON v.journal_entry_id = p.journal_entry_id AND v.bank_account_id = t.bank_account_id
   WHERE NOT EXISTS (SELECT 1 FROM statement_matches m
                      WHERE m.payment_id = p.id
                        AND NOT EXISTS (SELECT 1 FROM statement_match_reversals r WHERE r.match_id = m.id))
  UNION ALL
  SELECT l.transaction_id, l.journal_line_id, l.amount,
         'link', l.id, l.organization_id, l.company_id
    FROM bank_statement_links l
   WHERE NOT EXISTS (SELECT 1 FROM bank_statement_link_reversals r WHERE r.link_id = l.id);--> statement-breakpoint

GRANT SELECT ON "bank_line_reconciliation" TO authenticated;--> statement-breakpoint

-- ── 4. 🔴 The caps, enforced by the database ───────────────────────────────
-- A link may not reconcile a statement line beyond its amount, nor a cash
-- line beyond ITS amount — counting EVERY source in the view. The line must
-- be a cash line of a POSTED entry on the statement line's own bank, moving
-- money the same way (money in on the statement = a debit to the bank). A
-- company-wide advisory lock serialises every reconciliation write, so two
-- concurrent links cannot both read the same headroom.
CREATE OR REPLACE FUNCTION check_bank_statement_link() RETURNS trigger AS $$
DECLARE
  t transactions%ROWTYPE;
  line_bank integer; line_dr numeric; line_cr numeric; entry_status text;
  row_used numeric; line_used numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('bank-rec:' || NEW.company_id::text));
  SELECT * INTO t FROM transactions WHERE id = NEW.transaction_id;
  SELECT v.bank_account_id, v.debit_amount, v.credit_amount, e.status
    INTO line_bank, line_dr, line_cr, entry_status
    FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id
   WHERE v.line_id = NEW.journal_line_id;
  IF line_bank IS NULL THEN
    RAISE EXCEPTION 'Journal line % is not a cash line of any bank.', NEW.journal_line_id USING ERRCODE = 'check_violation';
  END IF;
  IF line_bank IS DISTINCT FROM t.bank_account_id THEN
    RAISE EXCEPTION 'Journal line % is on bank %, the statement line % is on bank %.', NEW.journal_line_id, line_bank, t.id, t.bank_account_id USING ERRCODE = 'check_violation';
  END IF;
  IF entry_status <> 'posted' THEN
    RAISE EXCEPTION 'Journal line % belongs to an entry that is %, not posted.', NEW.journal_line_id, entry_status USING ERRCODE = 'check_violation';
  END IF;
  IF (t.type = 'credit' AND NOT line_dr > 0) OR (t.type = 'debit' AND NOT line_cr > 0) THEN
    RAISE EXCEPTION 'Statement line % moves money % the bank; journal line % moves it the other way.', t.id,
      CASE WHEN t.type = 'credit' THEN 'into' ELSE 'out of' END, NEW.journal_line_id USING ERRCODE = 'check_violation';
  END IF;
  IF t.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Statement line % already posted its own entry; linking it to another cash line would count the money twice.', t.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO row_used FROM bank_line_reconciliation WHERE transaction_id = NEW.transaction_id;
  IF row_used + NEW.amount > abs(t.amount) + 0.005 THEN
    RAISE EXCEPTION 'Statement line % is % and % of it is already reconciled; % more would exceed it.', t.id, abs(t.amount), row_used, NEW.amount USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO line_used FROM bank_line_reconciliation WHERE line_id = NEW.journal_line_id;
  IF line_used + NEW.amount > abs(line_dr - line_cr) + 0.005 THEN
    RAISE EXCEPTION 'Journal line % is % and % of it is already reconciled; % more would exceed it.', NEW.journal_line_id, abs(line_dr - line_cr), line_used, NEW.amount USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER bank_statement_links_caps
  BEFORE INSERT ON public."bank_statement_links"
  FOR EACH ROW EXECUTE FUNCTION check_bank_statement_link();--> statement-breakpoint

-- Phase D may not reconcile what is already reconciled either: a statement
-- line that posted its own entry (or carries a link), or a receipt/refund
-- whose cash line is already answered, is refused here — the defect this
-- batch found was a matched line that could also be accepted and post again.
CREATE OR REPLACE FUNCTION check_statement_match_reconciliation() RETURNS trigger AS $$
DECLARE target_entry integer; bank integer; used numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('bank-rec:' || NEW.company_id::text));
  IF EXISTS (SELECT 1 FROM bank_line_reconciliation WHERE transaction_id = NEW.transaction_id) THEN
    RAISE EXCEPTION 'Statement line % is already reconciled (its own posting, a link, or another match); matching it again would count the money twice.', NEW.transaction_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT bank_account_id INTO bank FROM transactions WHERE id = NEW.transaction_id;
  IF NEW.payment_id IS NOT NULL THEN
    SELECT journal_entry_id INTO target_entry FROM payments WHERE id = NEW.payment_id;
  ELSE
    SELECT journal_entry_id INTO target_entry FROM customer_refunds WHERE id = NEW.refund_id;
  END IF;
  SELECT coalesce(sum(r.amount), 0) INTO used
    FROM bank_line_reconciliation r
    JOIN journal_line_bank_identity v ON v.line_id = r.line_id
   WHERE v.journal_entry_id = target_entry AND v.bank_account_id = bank;
  IF used > 0.005 THEN
    RAISE EXCEPTION 'The receipt/refund cash line is already reconciled to another statement line.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER statement_matches_reconciliation
  BEFORE INSERT ON public."statement_matches"
  FOR EACH ROW EXECUTE FUNCTION check_statement_match_reconciliation();--> statement-breakpoint

-- ── 5. A `matched` line has no posting of its own ──────────────────────────
-- `kind = 'matched'`: the line's cash was posted by the record it is
-- reconciled to, so it may never carry an entry of its own (that would be the
-- same money twice) and never a category or VAT (it is not a supply).
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_matched_posts_nothing"
  CHECK (kind <> 'matched' OR (journal_entry_id IS NULL AND category_id IS NULL AND vat_amount IS NULL));--> statement-breakpoint

-- ── 6. Back-fill: lines Phase D matched leave the review queue ─────────────
-- Before 12B a matched line stayed `pending_review` and could be accepted —
-- posting the same money a second time. Every line still pending with an
-- ACTIVE match becomes `matched` now. (A line that was ALREADY accepted and
-- posted while matched cannot be repaired by a migration — its entry is
-- posted; `ledgerInvariants.ts` names it: `bank_line_reconciled_twice`.)
UPDATE transactions t
   SET review_status = 'accepted', kind = 'matched', category_id = NULL,
       vat_amount = NULL, vat_rate = NULL, tax_treatment = NULL, vat_basis = NULL
 WHERE t.review_status = 'pending_review'
   AND t.journal_entry_id IS NULL
   AND EXISTS (SELECT 1 FROM statement_matches m
                WHERE m.transaction_id = t.id
                  AND NOT EXISTS (SELECT 1 FROM statement_match_reversals r WHERE r.match_id = m.id));
--> statement-breakpoint

-- ── 7. A bill payment records its entry — once ─────────────────────────────
-- bill_payments is append-only for the app role (no UPDATE). The pay path
-- inserts the payment BEFORE posting (its id numbers the entry, N3), so the
-- entry id can only be written after: a COLUMN-level grant on
-- journal_entry_id alone, and a trigger that allows it to be set once — from
-- NULL to a value — and never changed or cleared.
GRANT UPDATE ("journal_entry_id") ON TABLE "bill_payments" TO authenticated;--> statement-breakpoint
CREATE OR REPLACE FUNCTION refuse_bill_payment_entry_change() RETURNS trigger AS $$
BEGIN
  IF OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION 'Bill payment % already names its entry (%); it cannot change.', OLD.id, OLD.journal_entry_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER bill_payments_entry_once
  BEFORE UPDATE OF journal_entry_id ON public."bill_payments"
  FOR EACH ROW EXECUTE FUNCTION refuse_bill_payment_entry_change();
