-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 G4b — WHT owner decisions 17 and 18 (2026-10-27). Register §11.43.
--  · wht_refund_claims (+ _events): an over-withheld amount pursued by a refund
--    claim — its evidence checklist, the five-year clock (Law Art. 65(c)), and
--    its life as events (evidence updated, submitted, refunded, refused).
--  · wht_instalment_requests (+ _events): an instalment request under
--    Resolution 1117 for WHT months up to 2026-05; it counts only once ZATCA's
--    WRITTEN acceptance is recorded.
-- RECORDS ONLY: append-only for the request's role (SELECT, INSERT). New tables;
-- no existing row is touched. The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('wht_refund_claims', 'wht_refund_claim_events', 'wht_instalment_requests', 'wht_instalment_request_events')) THEN
    RAISE EXCEPTION 'pre-check REFUSED: a 0140 table already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: none of the four 0140 tables exists yet';
END $$;--> statement-breakpoint
CREATE TABLE "wht_instalment_request_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"request_id" integer NOT NULL,
	"kind" text NOT NULL,
	"on_date" date NOT NULL,
	"reference" text,
	"note" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wht_instalment_request_events_kind_chk" CHECK ("wht_instalment_request_events"."kind" in ('accepted', 'refused')),
	CONSTRAINT "wht_instalment_request_events_acceptance_chk" CHECK ("wht_instalment_request_events"."kind" <> 'accepted' or length(btrim(coalesce("wht_instalment_request_events"."reference", ''))) > 0)
);
--> statement-breakpoint
CREATE TABLE "wht_instalment_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"period_from" text NOT NULL,
	"period_to" text NOT NULL,
	"principal" numeric(15, 2) NOT NULL,
	"requested_on" date NOT NULL,
	"reference" text NOT NULL,
	"note" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wht_instalment_requests_org_id_unq" UNIQUE("organization_id","id"),
	CONSTRAINT "wht_instalment_requests_period_chk" CHECK ("wht_instalment_requests"."period_from" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and "wht_instalment_requests"."period_to" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and "wht_instalment_requests"."period_from" <= "wht_instalment_requests"."period_to"),
	CONSTRAINT "wht_instalment_requests_1117_chk" CHECK ("wht_instalment_requests"."period_to" <= '2026-05'),
	CONSTRAINT "wht_instalment_requests_principal_chk" CHECK ("wht_instalment_requests"."principal" > 0),
	CONSTRAINT "wht_instalment_requests_reference_chk" CHECK (length(btrim("wht_instalment_requests"."reference")) > 0)
);
--> statement-breakpoint
CREATE TABLE "wht_refund_claim_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"claim_id" integer NOT NULL,
	"kind" text NOT NULL,
	"on_date" date NOT NULL,
	"reference" text,
	"amount" numeric(15, 2),
	"note" text,
	"checklist" jsonb,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wht_refund_claim_events_kind_chk" CHECK ("wht_refund_claim_events"."kind" in ('evidence_updated', 'submitted', 'refunded', 'refused')),
	CONSTRAINT "wht_refund_claim_events_amount_chk" CHECK (("wht_refund_claim_events"."kind" = 'refunded') = ("wht_refund_claim_events"."amount" is not null) and ("wht_refund_claim_events"."amount" is null or "wht_refund_claim_events"."amount" > 0)),
	CONSTRAINT "wht_refund_claim_events_checklist_chk" CHECK (("wht_refund_claim_events"."kind" = 'evidence_updated') = ("wht_refund_claim_events"."checklist" is not null))
);
--> statement-breakpoint
CREATE TABLE "wht_refund_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"period" text NOT NULL,
	"vendor_id" integer NOT NULL,
	"overpaid_tax_year" integer NOT NULL,
	"excess_amount" numeric(15, 2) NOT NULL,
	"borne_by" text NOT NULL,
	"reason" text NOT NULL,
	"checklist" jsonb NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wht_refund_claims_org_id_unq" UNIQUE("organization_id","id"),
	CONSTRAINT "wht_refund_claims_period_chk" CHECK ("wht_refund_claims"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "wht_refund_claims_year_chk" CHECK ("wht_refund_claims"."overpaid_tax_year" between 2000 and 2100),
	CONSTRAINT "wht_refund_claims_excess_chk" CHECK ("wht_refund_claims"."excess_amount" > 0),
	CONSTRAINT "wht_refund_claims_borne_chk" CHECK ("wht_refund_claims"."borne_by" in ('payer', 'beneficiary')),
	CONSTRAINT "wht_refund_claims_reason_chk" CHECK (length(btrim("wht_refund_claims"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "wht_instalment_request_events" ADD CONSTRAINT "wht_instalment_request_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_instalment_request_events" ADD CONSTRAINT "wht_instalment_request_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_instalment_request_events" ADD CONSTRAINT "wht_instalment_request_events_request_tenant_fk" FOREIGN KEY ("organization_id","request_id") REFERENCES "public"."wht_instalment_requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_instalment_requests" ADD CONSTRAINT "wht_instalment_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_instalment_requests" ADD CONSTRAINT "wht_instalment_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_refund_claim_events" ADD CONSTRAINT "wht_refund_claim_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_refund_claim_events" ADD CONSTRAINT "wht_refund_claim_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_refund_claim_events" ADD CONSTRAINT "wht_refund_claim_events_claim_tenant_fk" FOREIGN KEY ("organization_id","claim_id") REFERENCES "public"."wht_refund_claims"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_refund_claims" ADD CONSTRAINT "wht_refund_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_refund_claims" ADD CONSTRAINT "wht_refund_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wht_instalment_request_events_request_idx" ON "wht_instalment_request_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "wht_refund_claim_events_claim_idx" ON "wht_refund_claim_events" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "wht_refund_claims_company_idx" ON "wht_refund_claims" USING btree ("company_id","period");--> statement-breakpoint
-- ── Tenancy and grants (the 0130 pattern) ───────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wht_refund_claims', 'wht_refund_claim_events', 'wht_instalment_requests', 'wht_instalment_request_events'] LOOP
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
      FOREACH t IN ARRAY ARRAY['wht_refund_claims', 'wht_refund_claim_events', 'wht_instalment_requests', 'wht_instalment_request_events'] LOOP
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
    -- 🔴 APPEND-ONLY for the request's role: a record and its events are inserted and read, never changed or deleted.
    FOREACH t IN ARRAY ARRAY['wht_refund_claims', 'wht_refund_claim_events', 'wht_instalment_requests', 'wht_instalment_request_events'] LOOP
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO authenticated', t);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO authenticated', t || '_id_seq');
      EXECUTE format('REVOKE UPDATE, DELETE ON TABLE public.%I FROM authenticated', t);
    END LOOP;
  END IF;
END $$;
