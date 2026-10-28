-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 G4c-2 — WHT owner decision 14 (2026-10-27): deposits. Register §11.46.
--  · supplier_deposit_forfeitures: a security deposit forfeited to the supplier,
--    as the user classified it (consideration / not_consideration), on its own
--    date; for a non-resident's consideration, the WHT due in the forfeiture
--    month frozen at recording — shown, never withheld or posted (W-16). A
--    RECORD: nothing posts (the posting is open W-20). Append-only for the
--    request's role (SELECT, INSERT).
--  · supplier_payments gains UNIQUE (organization_id, id): the target of the
--    forfeiture's key, which carries the organization (G04). The id is the
--    primary key, so the pair is already unique on every existing row.
-- No existing row is changed. The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'supplier_deposit_forfeitures') THEN
    RAISE EXCEPTION 'pre-check REFUSED: supplier_deposit_forfeitures already exists; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'supplier_payments_org_id_unq') THEN
    RAISE EXCEPTION 'pre-check REFUSED: supplier_payments_org_id_unq already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: no 0142 table or constraint exists yet';
END $$;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_org_id_unq" UNIQUE("organization_id","id");--> statement-breakpoint
CREATE TABLE "supplier_deposit_forfeitures" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"supplier_payment_id" integer NOT NULL,
	"forfeited_on" date NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"classification" text NOT NULL,
	"reason" text NOT NULL,
	"payment_type" text,
	"wht_due_rate" numeric(7, 4),
	"wht_due_amount" numeric(15, 2),
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_deposit_forfeitures_amount_chk" CHECK ("supplier_deposit_forfeitures"."amount" > 0),
	CONSTRAINT "supplier_deposit_forfeitures_class_chk" CHECK ("supplier_deposit_forfeitures"."classification" in ('consideration', 'not_consideration')),
	CONSTRAINT "supplier_deposit_forfeitures_reason_chk" CHECK (length(btrim("supplier_deposit_forfeitures"."reason")) > 0),
	CONSTRAINT "supplier_deposit_forfeitures_type_chk" CHECK ("supplier_deposit_forfeitures"."payment_type" is null or ("supplier_deposit_forfeitures"."classification" = 'consideration' and "supplier_deposit_forfeitures"."payment_type" in ('rent', 'royalty', 'management_fee', 'air_tickets_or_air_freight', 'sea_freight', 'intl_telecom', 'dividends', 'technical_consulting', 'loan_returns', 'insurance_premiums', 'other_payments'))),
	CONSTRAINT "supplier_deposit_forfeitures_due_chk" CHECK (("supplier_deposit_forfeitures"."wht_due_rate" is null) = ("supplier_deposit_forfeitures"."wht_due_amount" is null) and ("supplier_deposit_forfeitures"."wht_due_rate" is null or "supplier_deposit_forfeitures"."payment_type" is not null))
);
--> statement-breakpoint
ALTER TABLE "supplier_deposit_forfeitures" ADD CONSTRAINT "supplier_deposit_forfeitures_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_deposit_forfeitures" ADD CONSTRAINT "supplier_deposit_forfeitures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_deposit_forfeitures" ADD CONSTRAINT "supplier_deposit_forfeitures_payment_tenant_fk" FOREIGN KEY ("organization_id","supplier_payment_id") REFERENCES "public"."supplier_payments"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_deposit_forfeitures_payment_idx" ON "supplier_deposit_forfeitures" USING btree ("supplier_payment_id");
--> statement-breakpoint
-- ── Tenancy and grants (the 0130 pattern) ───────────────────────────────────
ALTER TABLE public.supplier_deposit_forfeitures ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.supplier_deposit_forfeitures
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
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.supplier_deposit_forfeitures FROM %I', r);
      IF current_setting('server_version_num')::int >= 170000 THEN
        EXECUTE format('REVOKE MAINTAIN ON TABLE public.supplier_deposit_forfeitures FROM %I', r);
      END IF;
      IF r <> 'authenticated' THEN
        EXECUTE format('REVOKE ALL ON TABLE public.supplier_deposit_forfeitures FROM %I', r);
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- 🔴 APPEND-ONLY for the request's role: a forfeiture record is inserted and read, never changed or deleted.
    GRANT SELECT, INSERT ON TABLE public.supplier_deposit_forfeitures TO authenticated;
    GRANT USAGE, SELECT ON SEQUENCE public.supplier_deposit_forfeitures_id_seq TO authenticated;
    REVOKE UPDATE, DELETE ON TABLE public.supplier_deposit_forfeitures FROM authenticated;
  END IF;
END $$;
