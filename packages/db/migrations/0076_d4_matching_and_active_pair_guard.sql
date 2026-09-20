-- Batch 1B Part 2, Phase D (2026-09-17): statement matching tables; the active-pair guard returns to the database.
CREATE TABLE "statement_match_reversals" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"match_id" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statement_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"transaction_id" integer NOT NULL,
	"payment_id" integer,
	"refund_id" integer,
	"method" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"reason" text,
	"idempotency_key" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_matches_one_target_chk" CHECK ((payment_id IS NOT NULL) <> (refund_id IS NOT NULL)),
	CONSTRAINT "statement_matches_method_chk" CHECK (method IN ('deterministic', 'manual', 'settlement')),
	CONSTRAINT "statement_matches_manual_reason_chk" CHECK (method <> 'manual' OR (reason IS NOT NULL AND length(trim(reason)) > 0))
);
--> statement-breakpoint
ALTER TABLE "statement_match_reversals" ADD CONSTRAINT "statement_match_reversals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_match_reversals" ADD CONSTRAINT "statement_match_reversals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_match_reversals" ADD CONSTRAINT "statement_match_reversals_match_id_statement_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."statement_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_matches" ADD CONSTRAINT "statement_matches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_matches" ADD CONSTRAINT "statement_matches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_matches" ADD CONSTRAINT "statement_matches_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_matches" ADD CONSTRAINT "statement_matches_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_matches" ADD CONSTRAINT "statement_matches_refund_id_customer_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."customer_refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "statement_match_reversals_match_unq" ON "statement_match_reversals" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_matches_idempotency_unq" ON "statement_matches" USING btree ("company_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "statement_matches_transaction_idx" ON "statement_matches" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "statement_matches_payment_idx" ON "statement_matches" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "statement_matches_refund_idx" ON "statement_matches" USING btree ("refund_id");
-- ═══════════════════════════════════════════════════════════════════════════
-- Batch 1B Part 2, Phase D (2026-09-17) — hand-written tail.
--
-- 1. THE ACTIVE-PAIR GUARD RETURNS TO THE DATABASE (carried item from the
--    Phase C review). A partial unique index cannot say "unique among
--    allocations that no reversal row names" — an index predicate may only
--    reference its own table's columns, and the reversal is a separate,
--    append-only table (the allocation row itself is never marked). So the
--    guarantee is a BEFORE INSERT trigger that takes a transaction-scoped
--    advisory lock on the (source, invoice) pair and refuses the insert if
--    an active allocation for the pair exists. The lock lives in the
--    database: two concurrent inserts serialise here whether or not the
--    caller took the service lock, and the loser sees the winner's row once
--    it commits. The error is raised as a unique_violation with a named
--    constraint so callers map it exactly like an index violation.
-- 2. The same guard for statement matches: one ACTIVE match per statement
--    row, and one ACTIVE match per payment / per refund.
-- 3. Tenant isolation and append-only grants for the two matching tables.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION refuse_duplicate_active_allocation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE pair text;
BEGIN
  pair := coalesce('p:' || NEW.payment_id::text, 'n:' || NEW.credit_note_id::text) || ':' || NEW.invoice_id::text;
  PERFORM pg_advisory_xact_lock(hashtextextended('active-allocation:' || pair, 0));
  IF EXISTS (
    SELECT 1 FROM payment_allocations a
      LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id
     WHERE a.invoice_id = NEW.invoice_id AND r.id IS NULL
       AND ((NEW.payment_id IS NOT NULL AND a.payment_id = NEW.payment_id)
         OR (NEW.credit_note_id IS NOT NULL AND a.credit_note_id = NEW.credit_note_id))
  ) THEN
    RAISE unique_violation USING
      MESSAGE = 'an active allocation already links this source to invoice ' || NEW.invoice_id || ' (' || pair || ')',
      CONSTRAINT = 'payment_allocations_active_pair_unq';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS refuse_duplicate_active_allocation ON payment_allocations;--> statement-breakpoint
CREATE TRIGGER refuse_duplicate_active_allocation
  BEFORE INSERT ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION refuse_duplicate_active_allocation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION refuse_duplicate_active_match() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target text;
BEGIN
  target := coalesce('p:' || NEW.payment_id::text, 'r:' || NEW.refund_id::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('active-match:row:' || NEW.transaction_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('active-match:target:' || target, 0));
  IF EXISTS (
    SELECT 1 FROM statement_matches m
      LEFT JOIN statement_match_reversals r ON r.match_id = m.id
     WHERE r.id IS NULL AND m.transaction_id = NEW.transaction_id
  ) THEN
    RAISE unique_violation USING
      MESSAGE = 'statement row ' || NEW.transaction_id || ' already has an active match',
      CONSTRAINT = 'statement_matches_active_row_unq';
  END IF;
  IF EXISTS (
    SELECT 1 FROM statement_matches m
      LEFT JOIN statement_match_reversals r ON r.match_id = m.id
     WHERE r.id IS NULL
       AND ((NEW.payment_id IS NOT NULL AND m.payment_id = NEW.payment_id)
         OR (NEW.refund_id IS NOT NULL AND m.refund_id = NEW.refund_id))
  ) THEN
    RAISE unique_violation USING
      MESSAGE = 'target ' || target || ' already has an active statement match',
      CONSTRAINT = 'statement_matches_active_target_unq';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS refuse_duplicate_active_match ON statement_matches;--> statement-breakpoint
CREATE TRIGGER refuse_duplicate_active_match
  BEFORE INSERT ON statement_matches
  FOR EACH ROW EXECUTE FUNCTION refuse_duplicate_active_match();--> statement-breakpoint

ALTER TABLE "statement_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "statement_match_reversals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "statement_matches"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "statement_match_reversals"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE "statement_matches" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "statement_match_reversals" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "statement_matches_id_seq" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "statement_match_reversals_id_seq" TO authenticated;--> statement-breakpoint

DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['statement_matches', 'statement_match_reversals'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.statement_matches FROM authenticated';
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.statement_match_reversals FROM authenticated';
  END IF;
END $$;
