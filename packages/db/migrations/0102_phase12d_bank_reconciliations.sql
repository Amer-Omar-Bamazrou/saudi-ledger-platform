-- PHASE 12D — bank reconciliation as of a date, and its lock (2026-09-23).
-- Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §6.
-- Schema and the identity: packages/db/src/schema/bankReconciliations.ts.
CREATE TABLE "bank_reconciliation_reopenings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"reconciliation_id" integer NOT NULL,
	"reason" text NOT NULL,
	"reopened_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_reconciliation_reopenings_reason_chk" CHECK (length(btrim(reason)) > 0)
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"bank_account_id" integer NOT NULL,
	"as_of" date NOT NULL,
	"bank_statement_id" integer,
	"statement_balance" numeric(15, 2) NOT NULL,
	"ledger_balance" numeric(15, 2) NOT NULL,
	"ledger_only_total" numeric(15, 2) NOT NULL,
	"statement_only_total" numeric(15, 2) NOT NULL,
	"difference" numeric(15, 2) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"notes" text,
	"completed_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_reconciliations_zero_chk" CHECK (difference = 0)
);
--> statement-breakpoint
ALTER TABLE "bank_reconciliation_reopenings" ADD CONSTRAINT "bank_reconciliation_reopenings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_reopenings" ADD CONSTRAINT "bank_reconciliation_reopenings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_reopenings" ADD CONSTRAINT "bank_reconciliation_reopenings_reconciliation_id_bank_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."bank_reconciliations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_bank_statement_id_bank_statements_id_fk" FOREIGN KEY ("bank_statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliation_reopenings_unq" ON "bank_reconciliation_reopenings" USING btree ("reconciliation_id");--> statement-breakpoint
CREATE INDEX "bank_reconciliations_bank_idx" ON "bank_reconciliations" USING btree ("bank_account_id","as_of");--> statement-breakpoint

-- ── Phase 12D: tenant isolation, append-only ─────────────────────────────
ALTER TABLE "bank_reconciliations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."bank_reconciliations"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
ALTER TABLE "bank_reconciliation_reopenings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."bank_reconciliation_reopenings"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "bank_reconciliations" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "bank_reconciliations_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "bank_reconciliation_reopenings" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "bank_reconciliation_reopenings_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_reconciliations', 'bank_reconciliation_reopenings'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint

-- ── A reconciliation names only its own company's bank and statement ─────
-- (FK checks run outside RLS.)
CREATE OR REPLACE FUNCTION check_bank_reconciliation_refs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.id = NEW.bank_account_id AND b.company_id = NEW.company_id)
     OR (NEW.bank_statement_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM bank_statements s WHERE s.id = NEW.bank_statement_id AND s.company_id = NEW.company_id
              AND s.bank_account_id = NEW.bank_account_id AND s.period_to = NEW.as_of)) THEN
    RAISE EXCEPTION 'bank reconciliation must name its own company''s bank, and a statement of that bank closing on its date'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER bank_reconciliations_refs_check BEFORE INSERT ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION check_bank_reconciliation_refs();--> statement-breakpoint

-- ── 🔴 THE LOCK: what a completed reconciliation relied on does not move ──
-- A bank is reconciled THROUGH the latest completed reconciliation that has
-- not been reopened. Through that date: no statement line is added, changed,
-- deleted or un-reconciled, and no cash line is posted to that bank. Reopen
-- it (a superseding row, with a reason) to change any of it. New links are
-- allowed — clearing an item that was outstanding is what the next period
-- does — and so is posting AFTER the date.
CREATE OR REPLACE FUNCTION bank_reconciled_through(p_bank integer) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT max(r.as_of) FROM bank_reconciliations r
   WHERE r.bank_account_id = p_bank
     AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_reopenings o WHERE o.reconciliation_id = r.id)
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION refuse_change_under_bank_reconciliation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_bank integer; v_date date; v_through date; v_status text;
BEGIN
  IF TG_TABLE_NAME = 'transactions' THEN
    IF TG_OP = 'INSERT' THEN
      v_bank := NEW.bank_account_id; v_date := NEW.date::date;
    ELSIF TG_OP = 'DELETE' THEN
      v_bank := OLD.bank_account_id; v_date := OLD.date::date;
    ELSE
      -- Only a change that moves what the reconciliation read: the line's
      -- money, its date, its bank, or how it is answered (its own posting).
      IF NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id AND NEW.amount IS NOT DISTINCT FROM OLD.amount
         AND NEW.date IS NOT DISTINCT FROM OLD.date AND NEW.type IS NOT DISTINCT FROM OLD.type
         AND NEW.bank_account_id IS NOT DISTINCT FROM OLD.bank_account_id THEN
        RETURN NEW;
      END IF;
      v_bank := OLD.bank_account_id; v_date := OLD.date::date;
    END IF;
  ELSIF TG_TABLE_NAME = 'bank_statement_link_reversals' THEN
    SELECT t.bank_account_id, t.date::date INTO v_bank, v_date
      FROM bank_statement_links l JOIN transactions t ON t.id = l.transaction_id WHERE l.id = NEW.link_id;
  ELSIF TG_TABLE_NAME = 'statement_match_reversals' THEN
    SELECT t.bank_account_id, t.date::date INTO v_bank, v_date
      FROM statement_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.id = NEW.match_id;
  ELSIF TG_TABLE_NAME = 'journal_entry_lines' THEN
    SELECT c.bank_account_id INTO v_bank FROM categories c WHERE c.id = NEW.account_id;
    IF v_bank IS NULL THEN RETURN NEW; END IF;
    SELECT e.date::date, e.status INTO v_date, v_status FROM journal_entries e WHERE e.id = NEW.journal_entry_id;
    IF v_status IS NULL OR v_status NOT IN ('posted', 'reversed') THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'cash_line_bank_attributions' THEN
    v_bank := NEW.bank_account_id;
    SELECT e.date::date INTO v_date FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id WHERE l.id = NEW.line_id;
  END IF;

  IF v_bank IS NOT NULL THEN
    v_through := bank_reconciled_through(v_bank);
    IF v_through IS NOT NULL AND v_date <= v_through THEN
      RAISE EXCEPTION 'bank account % is reconciled through %; a movement dated % cannot change. Reopen that reconciliation first, or post in a later period.',
        v_bank, v_through, v_date USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER transactions_bank_rec_lock BEFORE INSERT OR UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION refuse_change_under_bank_reconciliation();--> statement-breakpoint
CREATE TRIGGER bank_statement_link_reversals_bank_rec_lock BEFORE INSERT ON bank_statement_link_reversals
  FOR EACH ROW EXECUTE FUNCTION refuse_change_under_bank_reconciliation();--> statement-breakpoint
CREATE TRIGGER statement_match_reversals_bank_rec_lock BEFORE INSERT ON statement_match_reversals
  FOR EACH ROW EXECUTE FUNCTION refuse_change_under_bank_reconciliation();--> statement-breakpoint
CREATE TRIGGER journal_entry_lines_bank_rec_lock BEFORE INSERT ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION refuse_change_under_bank_reconciliation();--> statement-breakpoint
CREATE TRIGGER cash_line_bank_attributions_bank_rec_lock BEFORE INSERT ON cash_line_bank_attributions
  FOR EACH ROW EXECUTE FUNCTION refuse_change_under_bank_reconciliation();--> statement-breakpoint

-- A DRAFT entry becomes part of the books when it is posted: that transition
-- is checked too, against every bank its cash lines name.
CREATE OR REPLACE FUNCTION refuse_posting_under_bank_reconciliation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v record; v_through date;
BEGIN
  IF NEW.status IN ('posted', 'reversed') AND OLD.status NOT IN ('posted', 'reversed') THEN
    FOR v IN SELECT DISTINCT c.bank_account_id FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
              WHERE l.journal_entry_id = NEW.id AND c.bank_account_id IS NOT NULL LOOP
      v_through := bank_reconciled_through(v.bank_account_id);
      IF v_through IS NOT NULL AND NEW.date::date <= v_through THEN
        RAISE EXCEPTION 'bank account % is reconciled through %; an entry dated % cannot be posted to it. Reopen that reconciliation first, or date the entry later.',
          v.bank_account_id, v_through, NEW.date::date USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER journal_entries_bank_rec_lock BEFORE UPDATE OF status ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION refuse_posting_under_bank_reconciliation();
