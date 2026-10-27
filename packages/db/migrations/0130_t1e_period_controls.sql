-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 T1e (Phase 18; G19, G20, G57, DR-10, DR-30 — owner decisions 2026-10-24):
--  - PER-1: a journal entry is never POSTED into a closed month, by any writer,
--    and a close is serialised with postings into that month (advisory lock on
--    (company, month): the posting takes it SHARED, the close and the reopen
--    EXCLUSIVE). "The month an entry affects" is ONE function,
--    journal_entry_lock_month(date) — the door for DI-A2 (a reporting period
--    apart from the posting date, owner 2026-10-27): only that function changes.
--  - PER-2: a reopen keeps the lock row (who, when, why) and appends to
--    period_lock_events; the request's role cannot DELETE a lock.
--  - A period is a real month.
--  - DR-10's records, append-only for the request's role: period_lock_events,
--    vat_return_filings, zakat_income_tax_filings, statement_authorisations,
--    and a correction's discovery date, apparent date and evidence.
-- G16 (0126) is not changed: posted → reversed is not refused here (a
-- correction posts in an open month; the original's marker changes no month's
-- figures), and the new journal columns are written on a draft.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The refusing pre-check (forward-only): every existing lock names a real month. ──
DO $$
DECLARE bad int; sample text;
BEGIN
  SELECT count(*), string_agg(id || ':' || period, ', ' ORDER BY id) INTO bad, sample
    FROM period_locks WHERE period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$';
  IF bad > 0 THEN
    RAISE EXCEPTION 'T1e pre-check REFUSED: % period lock(s) name no real month (%); nothing was changed', bad, sample;
  END IF;
  RAISE NOTICE 'T1e pre-check: every period lock names a real month';
END $$;--> statement-breakpoint
CREATE TABLE "period_lock_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"period" text NOT NULL,
	"event" text NOT NULL,
	"reason" text,
	"actor" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "period_lock_events_period_chk" CHECK ("period_lock_events"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "period_lock_events_event_chk" CHECK ("period_lock_events"."event" in ('close', 'reopen') and ("period_lock_events"."event" = 'close' or length(btrim("period_lock_events"."reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "statement_authorisations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"fiscal_year_start" date NOT NULL,
	"fiscal_year_end" date NOT NULL,
	"authorised_on" date NOT NULL,
	"authorised_by" text NOT NULL,
	"notes" text,
	"recorded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_authorisations_year_chk" CHECK ("statement_authorisations"."fiscal_year_start" < "statement_authorisations"."fiscal_year_end"),
	CONSTRAINT "statement_authorisations_after_year_chk" CHECK ("statement_authorisations"."authorised_on" > "statement_authorisations"."fiscal_year_end"),
	CONSTRAINT "statement_authorisations_by_chk" CHECK (length(btrim("statement_authorisations"."authorised_by")) >= 2)
);
--> statement-breakpoint
CREATE TABLE "vat_return_filings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"period_from" text NOT NULL,
	"period_to" text NOT NULL,
	"kind" text DEFAULT 'original' NOT NULL,
	"amends_zatca_reference" text,
	"filed_on" date NOT NULL,
	"zatca_reference" text NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vat_return_filings_period_chk" CHECK ("vat_return_filings"."period_from" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and "vat_return_filings"."period_to" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and "vat_return_filings"."period_from" <= "vat_return_filings"."period_to"),
	CONSTRAINT "vat_return_filings_kind_chk" CHECK ("vat_return_filings"."kind" in ('original', 'amendment') and (("vat_return_filings"."kind" = 'original') = ("vat_return_filings"."amends_zatca_reference" is null))),
	CONSTRAINT "vat_return_filings_reference_chk" CHECK (length(btrim("vat_return_filings"."zatca_reference")) >= 3),
	CONSTRAINT "vat_return_filings_after_period_chk" CHECK ("vat_return_filings"."filed_on" >= (to_date("vat_return_filings"."period_to" || '-01', 'YYYY-MM-DD') + interval '1 month')::date)
);
--> statement-breakpoint
CREATE TABLE "zakat_income_tax_filings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"tax" text NOT NULL,
	"fiscal_year_end" date NOT NULL,
	"kind" text DEFAULT 'original' NOT NULL,
	"amends_zatca_reference" text,
	"filed_on" date NOT NULL,
	"zatca_reference" text NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zakat_income_tax_filings_tax_chk" CHECK ("zakat_income_tax_filings"."tax" in ('zakat', 'income_tax')),
	CONSTRAINT "zakat_income_tax_filings_kind_chk" CHECK ("zakat_income_tax_filings"."kind" in ('original', 'amendment') and (("zakat_income_tax_filings"."kind" = 'original') = ("zakat_income_tax_filings"."amends_zatca_reference" is null))),
	CONSTRAINT "zakat_income_tax_filings_reference_chk" CHECK (length(btrim("zakat_income_tax_filings"."zatca_reference")) >= 3),
	CONSTRAINT "zakat_income_tax_filings_after_year_chk" CHECK ("zakat_income_tax_filings"."filed_on" > "zakat_income_tax_filings"."fiscal_year_end")
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "discovered_on" date;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "apparent_on" date;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "discovery_evidence" text;--> statement-breakpoint
ALTER TABLE "period_locks" ADD COLUMN "reopened_at" timestamp;--> statement-breakpoint
ALTER TABLE "period_locks" ADD COLUMN "reopened_by" integer;--> statement-breakpoint
ALTER TABLE "period_locks" ADD COLUMN "reopen_reason" text;--> statement-breakpoint
ALTER TABLE "period_lock_events" ADD CONSTRAINT "period_lock_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_lock_events" ADD CONSTRAINT "period_lock_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_authorisations" ADD CONSTRAINT "statement_authorisations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_authorisations" ADD CONSTRAINT "statement_authorisations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_return_filings" ADD CONSTRAINT "vat_return_filings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_return_filings" ADD CONSTRAINT "vat_return_filings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zakat_income_tax_filings" ADD CONSTRAINT "zakat_income_tax_filings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zakat_income_tax_filings" ADD CONSTRAINT "zakat_income_tax_filings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "period_lock_events_company_period_idx" ON "period_lock_events" USING btree ("company_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_authorisations_year_unq" ON "statement_authorisations" USING btree ("company_id","fiscal_year_end");--> statement-breakpoint
CREATE UNIQUE INDEX "vat_return_filings_one_original_unq" ON "vat_return_filings" USING btree ("company_id","period_from","period_to") WHERE kind = 'original';--> statement-breakpoint
CREATE UNIQUE INDEX "vat_return_filings_reference_unq" ON "vat_return_filings" USING btree ("company_id","zatca_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "zakat_income_tax_filings_one_original_unq" ON "zakat_income_tax_filings" USING btree ("company_id","tax","fiscal_year_end") WHERE kind = 'original';--> statement-breakpoint
CREATE UNIQUE INDEX "zakat_income_tax_filings_reference_unq" ON "zakat_income_tax_filings" USING btree ("company_id","zatca_reference");--> statement-breakpoint
ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_period_chk" CHECK ("period_locks"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');--> statement-breakpoint
ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_reopen_chk" CHECK (("period_locks"."reopened_at" is null and "period_locks"."reopened_by" is null and "period_locks"."reopen_reason" is null) or ("period_locks"."reopened_at" is not null and length(btrim("period_locks"."reopen_reason")) > 0));--> statement-breakpoint

-- ── PER-1: the month an entry affects; the (company, month) guard key; the close's guard. ──
CREATE OR REPLACE FUNCTION journal_entry_lock_month(entry_date text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT left(entry_date, 7) $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION period_lock_key(company uuid, month text) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$ SELECT hashtextextended('period-lock:' || company::text || ':' || month, 0) $$;--> statement-breakpoint
-- Taken by the close and the reopen, inside their transaction, before they write.
CREATE OR REPLACE FUNCTION period_close_guard(company uuid, month text) RETURNS void
LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(period_lock_key(company, month)) $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal_entries_period_closed_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE month text;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    month := journal_entry_lock_month(NEW.date);
    -- SHARED: postings into a month run side by side; a close of it waits for them, and they wait for it.
    PERFORM pg_advisory_xact_lock_shared(period_lock_key(NEW.company_id, month));
    IF EXISTS (SELECT 1 FROM period_locks l
                WHERE l.organization_id = NEW.organization_id AND l.company_id = NEW.company_id
                  AND l.period = month AND l.reopened_at IS NULL) THEN
      RAISE EXCEPTION 'The books for % are closed, so journal entry % (%) cannot be posted into it. Date it in an open month, or reopen % with a reason.', month, NEW.id, NEW.entry_number, month
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entry_period_closed';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_entries_period_closed_guard ON "journal_entries";--> statement-breakpoint
CREATE TRIGGER journal_entries_period_closed_guard
  BEFORE UPDATE OF status ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION journal_entries_period_closed_guard();--> statement-breakpoint

-- ── Tenancy and grants for the four new tables ───────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['period_lock_events', 'vat_return_filings', 'zakat_income_tax_filings', 'statement_authorisations'] LOOP
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
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['period_lock_events', 'vat_return_filings', 'zakat_income_tax_filings', 'statement_authorisations'] LOOP
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
    -- 🔴 APPEND-ONLY for the request's role: a record is inserted and read, never changed or deleted.
    FOREACH t IN ARRAY ARRAY['period_lock_events', 'vat_return_filings', 'zakat_income_tax_filings', 'statement_authorisations'] LOOP
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO authenticated', t);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO authenticated', t || '_id_seq');
      EXECUTE format('REVOKE UPDATE, DELETE ON TABLE public.%I FROM authenticated', t);
    END LOOP;
    -- 🔴 PER-2: a lock row is never deleted by the request's role; a reopen updates it.
    EXECUTE 'REVOKE DELETE ON TABLE public.period_locks FROM authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.period_locks TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.period_close_guard(uuid, text) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.journal_entry_lock_month(text) TO authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.period_lock_key(uuid, text) TO authenticated';
  END IF;
END $$;
