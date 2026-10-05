CREATE TABLE "scheduled_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"bill_id" integer NOT NULL,
	"planned_date" date NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"bank_account_id" integer,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"wht_payment_type" text,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" integer,
	"approved_at" timestamp with time zone,
	"paid_bill_payment_id" integer,
	"paid_by" integer,
	"paid_at" timestamp with time zone,
	"cancelled_by" integer,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "scheduled_payments_amount_chk" CHECK ("scheduled_payments"."amount" > 0),
	CONSTRAINT "scheduled_payments_priority_chk" CHECK ("scheduled_payments"."priority" in ('high', 'normal', 'low')),
	CONSTRAINT "scheduled_payments_status_chk" CHECK ("scheduled_payments"."status" in ('planned', 'approved', 'paid', 'cancelled')),
	CONSTRAINT "scheduled_payments_wht_type_chk" CHECK ("scheduled_payments"."wht_payment_type" is null or "scheduled_payments"."wht_payment_type" in ('rent', 'royalty', 'management_fee', 'air_tickets_or_air_freight', 'sea_freight', 'intl_telecom', 'dividends', 'technical_consulting', 'loan_returns', 'insurance_premiums', 'other_payments')),
	CONSTRAINT "scheduled_payments_paid_chk" CHECK (("scheduled_payments"."status" = 'paid') = ("scheduled_payments"."paid_bill_payment_id" is not null)),
	CONSTRAINT "scheduled_payments_cancel_chk" CHECK (("scheduled_payments"."status" = 'cancelled') = ("scheduled_payments"."cancel_reason" is not null)),
	CONSTRAINT "scheduled_payments_approved_chk" CHECK ("scheduled_payments"."status" not in ('approved', 'paid') or "scheduled_payments"."approved_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "treasury_forecast_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"entry_date" date NOT NULL,
	"direction" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"description" text NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone,
	CONSTRAINT "treasury_forecast_entries_direction_chk" CHECK ("treasury_forecast_entries"."direction" in ('inflow', 'outflow')),
	CONSTRAINT "treasury_forecast_entries_amount_chk" CHECK ("treasury_forecast_entries"."amount" > 0),
	CONSTRAINT "treasury_forecast_entries_category_chk" CHECK ("treasury_forecast_entries"."category" in ('financing', 'capex', 'tax', 'payroll', 'receipt', 'payment', 'other')),
	CONSTRAINT "treasury_forecast_entries_description_chk" CHECK (length(btrim("treasury_forecast_entries"."description")) >= 3)
);
--> statement-breakpoint
CREATE TABLE "treasury_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"minimum_cash_balance" numeric(15, 2),
	"forecast_horizon_weeks" smallint DEFAULT 13 NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_settings_buffer_chk" CHECK ("treasury_settings"."minimum_cash_balance" is null or "treasury_settings"."minimum_cash_balance" >= 0),
	CONSTRAINT "treasury_settings_horizon_chk" CHECK ("treasury_settings"."forecast_horizon_weeks" between 1 and 52)
);
--> statement-breakpoint
ALTER TABLE "scheduled_payments" ADD CONSTRAINT "scheduled_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_payments" ADD CONSTRAINT "scheduled_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_payments" ADD CONSTRAINT "scheduled_payments_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_payments" ADD CONSTRAINT "scheduled_payments_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_payments" ADD CONSTRAINT "scheduled_payments_paid_bill_payment_id_bill_payments_id_fk" FOREIGN KEY ("paid_bill_payment_id") REFERENCES "public"."bill_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_forecast_entries" ADD CONSTRAINT "treasury_forecast_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_forecast_entries" ADD CONSTRAINT "treasury_forecast_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_settings" ADD CONSTRAINT "treasury_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_settings" ADD CONSTRAINT "treasury_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_payments_company_idx" ON "scheduled_payments" USING btree ("company_id","status","planned_date");--> statement-breakpoint
CREATE INDEX "scheduled_payments_bill_idx" ON "scheduled_payments" USING btree ("bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_payments_payment_unq" ON "scheduled_payments" USING btree ("paid_bill_payment_id") WHERE paid_bill_payment_id is not null;--> statement-breakpoint
CREATE INDEX "treasury_forecast_entries_company_idx" ON "treasury_forecast_entries" USING btree ("company_id","entry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_settings_company_unq" ON "treasury_settings" USING btree ("company_id");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 17 — Treasury: the hand-written half.
-- Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §8–§10.
-- 🔴 Nothing here holds cash or posts: the position is the ledger; these
-- tables hold what a person decided about the future.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Settings: one row per company of this organisation ─────────────────
CREATE OR REPLACE FUNCTION treasury_settings_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE co record;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
    RAISE EXCEPTION 'treasury settings %: the company is fixed', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'treasury_settings_identity';
  END IF;
  SELECT id, organization_id INTO co FROM companies WHERE id = NEW.company_id;
  IF co.id IS NULL OR co.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'treasury settings: company % is not in this organisation', NEW.company_id USING ERRCODE = '23514', CONSTRAINT = 'treasury_settings_tenant';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION treasury_settings_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER treasury_settings_admit BEFORE INSERT OR UPDATE ON "treasury_settings" FOR EACH ROW EXECUTE FUNCTION treasury_settings_admit();--> statement-breakpoint

-- ── 2. A payment plan names a POSTED, PAYABLE bill of this tenant ──────────
CREATE OR REPLACE FUNCTION scheduled_payments_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b record; ba record;
BEGIN
  SELECT id, organization_id, company_id, status, document_type INTO b FROM bills WHERE id = NEW.bill_id;
  -- a foreign bill is answered exactly like a missing one
  IF b.id IS NULL OR b.organization_id IS DISTINCT FROM NEW.organization_id OR b.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'payment plan: bill % is not a bill of this organisation and company', NEW.bill_id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_tenant';
  END IF;
  IF b.status IN ('draft', 'submitted') OR b.document_type NOT IN ('bill', 'debit_note') THEN
    RAISE EXCEPTION 'payment plan: bill % is not a posted bill or debit note — only what is owed is planned', NEW.bill_id
      USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_bill';
  END IF;
  IF NEW.bank_account_id IS NOT NULL THEN
    SELECT id, organization_id, company_id INTO ba FROM bank_accounts WHERE id = NEW.bank_account_id;
    IF ba.id IS NULL OR ba.organization_id IS DISTINCT FROM NEW.organization_id OR ba.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'payment plan: bank account % is not in this organisation and company', NEW.bank_account_id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_tenant';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.status <> 'planned' OR NEW.approved_at IS NOT NULL OR NEW.paid_bill_payment_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'payment plan: a plan is created PLANNED and moves on only through its lifecycle' USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_born_planned';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION scheduled_payments_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER scheduled_payments_admit BEFORE INSERT ON "scheduled_payments" FOR EACH ROW EXECUTE FUNCTION scheduled_payments_admit();--> statement-breakpoint

-- ── 3. The lifecycle: planned → approved → paid | cancelled ───────────────
CREATE OR REPLACE FUNCTION scheduled_payments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE bp record; ba record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'planned' THEN
      RAISE EXCEPTION 'payment plan % is %: only a plan not yet approved is deleted — cancel an approved one, with its reason', OLD.id, OLD.status
        USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.bill_id IS DISTINCT FROM OLD.bill_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment plan %: its bill and author are fixed', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_identity';
  END IF;
  IF NEW.status = OLD.status THEN
    -- only a PLANNED plan's terms are edited in place
    IF OLD.status <> 'planned' OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.paid_bill_payment_id IS DISTINCT FROM OLD.paid_bill_payment_id
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
      RAISE EXCEPTION 'payment plan % is %: it cannot be changed', OLD.id, OLD.status USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_immutable';
    END IF;
    IF NEW.bank_account_id IS NOT NULL AND NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id THEN
      SELECT id, organization_id, company_id INTO ba FROM bank_accounts WHERE id = NEW.bank_account_id;
      IF ba.id IS NULL OR ba.organization_id IS DISTINCT FROM NEW.organization_id OR ba.company_id IS DISTINCT FROM NEW.company_id THEN
        RAISE EXCEPTION 'payment plan: bank account % is not in this organisation and company', NEW.bank_account_id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_tenant';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- a transition changes its own columns and nothing about the plan's terms
  IF NEW.planned_date IS DISTINCT FROM OLD.planned_date OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
     OR NEW.priority IS DISTINCT FROM OLD.priority OR NEW.wht_payment_type IS DISTINCT FROM OLD.wht_payment_type OR NEW.notes IS DISTINCT FROM OLD.notes THEN
    RAISE EXCEPTION 'payment plan %: a transition does not change the plan''s terms', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_transition';
  END IF;
  IF (OLD.status, NEW.status) = ('planned', 'approved') THEN
    IF NEW.approved_at IS NULL OR NEW.paid_bill_payment_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'payment plan %: an approval records who approved it and when', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_transition';
    END IF;
  ELSIF (OLD.status, NEW.status) IN (('planned', 'cancelled'), ('approved', 'cancelled')) THEN
    IF NEW.cancelled_at IS NULL OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.paid_bill_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'payment plan %: a cancellation records who cancelled it, when and why', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_transition';
    END IF;
  ELSIF (OLD.status, NEW.status) = ('approved', 'paid') THEN
    -- 🔴 paid ONLY by a real payment of THIS bill, of THIS amount, in this company
    SELECT id, bill_id, amount, company_id INTO bp FROM bill_payments WHERE id = NEW.paid_bill_payment_id;
    IF bp.id IS NULL OR bp.bill_id IS DISTINCT FROM OLD.bill_id OR bp.amount IS DISTINCT FROM OLD.amount OR bp.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.paid_at IS NULL OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'payment plan %: it is paid only by a payment of its own bill for its own amount', OLD.id
        USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_paid_by';
    END IF;
  ELSE
    RAISE EXCEPTION 'payment plan %: % → % is not a step of its lifecycle', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'scheduled_payment_transition';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION scheduled_payments_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER scheduled_payments_guard BEFORE UPDATE OR DELETE ON "scheduled_payments" FOR EACH ROW EXECUTE FUNCTION scheduled_payments_guard();--> statement-breakpoint

-- ── 4. Manual assumptions: this tenant's ──────────────────────────────────
CREATE OR REPLACE FUNCTION treasury_forecast_entries_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE co record;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'forecast assumption %: its company and author are fixed', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'treasury_forecast_entry_identity';
  END IF;
  SELECT id, organization_id INTO co FROM companies WHERE id = NEW.company_id;
  IF co.id IS NULL OR co.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'forecast assumption: company % is not in this organisation', NEW.company_id USING ERRCODE = '23514', CONSTRAINT = 'treasury_forecast_entry_tenant';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION treasury_forecast_entries_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER treasury_forecast_entries_admit BEFORE INSERT OR UPDATE ON "treasury_forecast_entries" FOR EACH ROW EXECUTE FUNCTION treasury_forecast_entries_admit();--> statement-breakpoint

CREATE OR REPLACE FUNCTION treasury_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: treasury records; TRUNCATE is refused', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'treasury_no_truncate';
END $$;--> statement-breakpoint
CREATE TRIGGER treasury_settings_no_truncate BEFORE TRUNCATE ON "treasury_settings" FOR EACH STATEMENT EXECUTE FUNCTION treasury_no_truncate();--> statement-breakpoint
CREATE TRIGGER scheduled_payments_no_truncate BEFORE TRUNCATE ON "scheduled_payments" FOR EACH STATEMENT EXECUTE FUNCTION treasury_no_truncate();--> statement-breakpoint
CREATE TRIGGER treasury_forecast_entries_no_truncate BEFORE TRUNCATE ON "treasury_forecast_entries" FOR EACH STATEMENT EXECUTE FUNCTION treasury_no_truncate();--> statement-breakpoint

-- ── 5. Tenant isolation, grants, permissions ───────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['treasury_settings', 'scheduled_payments', 'treasury_forecast_entries'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY "tenant_isolation" ON public.%I
      USING ( (organization_id)::text = current_setting('app.current_org_id', true)
              AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                    OR (company_id)::text = current_setting('app.current_company_id', true) ) )
      WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
              AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                    OR (company_id)::text = current_setting('app.current_company_id', true) ) )$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO authenticated', t || '_id_seq');
  END LOOP;
END $$;--> statement-breakpoint
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['treasury_settings', 'scheduled_payments', 'treasury_forecast_entries'] LOOP
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
        IF current_setting('server_version_num')::int >= 170000 THEN
          EXECUTE format('REVOKE MAINTAIN ON TABLE public.%I FROM %I', t, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
-- `treasury`: everyone reads; a bookkeeper plans payments and records assumptions;
-- an approver approves a plan, pays it through the bill pay path, and cancels an
-- approved one. `treasury_settings` (the buffer) is an approver's policy.
INSERT INTO "permissions" (role, resource, action) VALUES
  ('admin', 'treasury', 'read'), ('admin', 'treasury', 'create'), ('admin', 'treasury', 'update'), ('admin', 'treasury', 'approve'), ('admin', 'treasury', 'delete'),
  ('accountant', 'treasury', 'read'), ('accountant', 'treasury', 'create'), ('accountant', 'treasury', 'update'), ('accountant', 'treasury', 'approve'), ('accountant', 'treasury', 'delete'),
  ('bookkeeper', 'treasury', 'read'), ('bookkeeper', 'treasury', 'create'), ('bookkeeper', 'treasury', 'update'), ('bookkeeper', 'treasury', 'delete'),
  ('viewer', 'treasury', 'read'),
  ('admin', 'treasury_settings', 'read'), ('admin', 'treasury_settings', 'update'),
  ('accountant', 'treasury_settings', 'read'), ('accountant', 'treasury_settings', 'update'),
  ('bookkeeper', 'treasury_settings', 'read'), ('viewer', 'treasury_settings', 'read')
ON CONFLICT DO NOTHING;
