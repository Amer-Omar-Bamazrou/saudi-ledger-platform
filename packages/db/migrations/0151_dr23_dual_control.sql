-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 R-6 — DR-23 (D-6): dual control on bank details, only where two
--    admins exist (register §11.98, §11.99).
--  · bank_detail_change_requests: a change of a supplier's IBAN, of a company
--    bank account's IBAN, or of which account is the DEFAULT (the IBAN printed
--    on future invoices, G30), held for a second admin.
--  · org_usable_admin_ids / org_usable_admin_count: G03's definition of a
--    usable admin (an active admin membership AND an active account) — ONE
--    definition, read by the triggers below and by the service through the
--    identity layer. Not executable by the request's roles.
--  · The request's flow, at the database: inserted only as pending, naming the
--    connection's declared actor (T1b's app.current_user_id); decided ONCE, by
--    the declared actor, at now(); approved only by a usable admin who is not
--    the requester; rejected by a usable admin or by the requester.
--  · THE WRITE BOUNDARY: where the organisation has two or more usable admins,
--    a change of vendors.iban or bank_accounts.iban, and a bank account
--    becoming the default (INSERT or UPDATE), is refused
--    (bank_detail_dual_control) unless a matching request was APPROVED IN THIS
--    TRANSACTION (decided_at = now(), by the same actor).
--  · The only bypass is session_replication_role = replica (owner-only), as T1b.
-- New table, key, functions and triggers; no existing row is read or changed.
-- The pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'bank_detail_change_requests') THEN
    RAISE EXCEPTION 'pre-check REFUSED: bank_detail_change_requests already exists; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN ('org_usable_admin_ids', 'org_usable_admin_count', 'bank_detail_change_request_guard', 'bank_detail_dual_control')) THEN
    RAISE EXCEPTION 'pre-check REFUSED: a function of 0151 already exists; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_accounts_org_id_unq') THEN
    RAISE EXCEPTION 'pre-check REFUSED: bank_accounts_org_id_unq already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: none of 0151''s objects exist yet';
END $$;--> statement-breakpoint
-- G04: the target of the request's tenant-carrying reference (id is the primary key, so this cannot fail on data).
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_org_id_unq" UNIQUE("organization_id","id");--> statement-breakpoint
CREATE TABLE "bank_detail_change_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"kind" text NOT NULL,
	"vendor_id" integer,
	"bank_account_id" integer,
	"iban_before" text,
	"iban_after" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" integer DEFAULT (nullif(current_setting('app.current_user_id', true), ''))::integer NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" integer,
	"decided_at" timestamp with time zone,
	CONSTRAINT "bank_detail_change_kind_chk" CHECK ("bank_detail_change_requests"."kind" in ('vendor_iban', 'bank_account_iban', 'default_bank_account')),
	CONSTRAINT "bank_detail_change_status_chk" CHECK ("bank_detail_change_requests"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "bank_detail_change_subject_chk" CHECK (("bank_detail_change_requests"."kind" = 'vendor_iban' and "bank_detail_change_requests"."vendor_id" is not null and "bank_detail_change_requests"."bank_account_id" is null) or ("bank_detail_change_requests"."kind" <> 'vendor_iban' and "bank_detail_change_requests"."bank_account_id" is not null and "bank_detail_change_requests"."vendor_id" is null)),
	CONSTRAINT "bank_detail_change_decision_chk" CHECK (("bank_detail_change_requests"."status" = 'pending') = ("bank_detail_change_requests"."decided_by" is null and "bank_detail_change_requests"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD CONSTRAINT "bank_detail_change_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD CONSTRAINT "bank_detail_change_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD CONSTRAINT "bank_detail_change_vendor_tenant_fk" FOREIGN KEY ("organization_id","vendor_id") REFERENCES "public"."vendors"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_detail_change_requests" ADD CONSTRAINT "bank_detail_change_bank_account_tenant_fk" FOREIGN KEY ("organization_id","bank_account_id") REFERENCES "public"."bank_accounts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_detail_change_pending_vendor_unq" ON "bank_detail_change_requests" USING btree ("vendor_id") WHERE "bank_detail_change_requests"."status" = 'pending' and "bank_detail_change_requests"."kind" = 'vendor_iban';--> statement-breakpoint
CREATE UNIQUE INDEX "bank_detail_change_pending_account_unq" ON "bank_detail_change_requests" USING btree ("bank_account_id") WHERE "bank_detail_change_requests"."status" = 'pending' and "bank_detail_change_requests"."kind" = 'bank_account_iban';--> statement-breakpoint
CREATE UNIQUE INDEX "bank_detail_change_pending_default_unq" ON "bank_detail_change_requests" USING btree ("company_id") WHERE "bank_detail_change_requests"."status" = 'pending' and "bank_detail_change_requests"."kind" = 'default_bank_account';--> statement-breakpoint
CREATE INDEX "bank_detail_change_company_idx" ON "bank_detail_change_requests" USING btree ("company_id","requested_at");--> statement-breakpoint
-- ── Tenancy and grants (the 0143 pattern) ───────────────────────────────────
ALTER TABLE public.bank_detail_change_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.bank_detail_change_requests
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
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.bank_detail_change_requests FROM %I', r);
      IF current_setting('server_version_num')::int >= 170000 THEN
        EXECUTE format('REVOKE MAINTAIN ON TABLE public.bank_detail_change_requests FROM %I', r);
      END IF;
      IF r <> 'authenticated' THEN
        EXECUTE format('REVOKE ALL ON TABLE public.bank_detail_change_requests FROM %I', r);
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- A request is recorded, then decided once — never deleted by the request's role.
    GRANT SELECT, INSERT, UPDATE ON TABLE public.bank_detail_change_requests TO authenticated;
    GRANT USAGE, SELECT ON SEQUENCE public.bank_detail_change_requests_id_seq TO authenticated;
    REVOKE DELETE ON TABLE public.bank_detail_change_requests FROM authenticated;
  END IF;
END $$;--> statement-breakpoint
-- ── G03's usable admin: ONE definition ──────────────────────────────────────
CREATE FUNCTION org_usable_admin_ids(org uuid) RETURNS SETOF integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.user_id FROM organization_memberships m JOIN users u ON u.id = m.user_id
   WHERE m.organization_id = org AND m.role = 'admin' AND m.status = 'active' AND u.is_active
$$;--> statement-breakpoint
CREATE FUNCTION org_usable_admin_count(org uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM org_usable_admin_ids(org)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.org_usable_admin_ids(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.org_usable_admin_count(uuid) FROM PUBLIC;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.org_usable_admin_ids(uuid) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.org_usable_admin_count(uuid) FROM %I', r);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
-- ── The request's flow ──────────────────────────────────────────────────────
CREATE FUNCTION bank_detail_change_request_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  acting integer := (nullif(current_setting('app.current_user_id', true), ''))::integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a bank-detail change is recorded as pending; only a decision moves it'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
    END IF;
    IF acting IS NULL OR NEW.requested_by IS DISTINCT FROM acting THEN
      RAISE EXCEPTION 'this request names user %, but the connection''s declared actor is %: a request records who asked, never a user its writer chose', coalesce(NEW.requested_by::text, 'none'), coalesce(acting::text, 'none')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'bank-detail change request % was already %: a decision is final', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.company_id, NEW.kind, NEW.vendor_id, NEW.bank_account_id, NEW.iban_before, NEW.iban_after, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.company_id, OLD.kind, OLD.vendor_id, OLD.bank_account_id, OLD.iban_before, OLD.iban_after, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'only the decision on bank-detail change request % may change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected') OR acting IS NULL OR NEW.decided_by IS DISTINCT FROM acting OR NEW.decided_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'a decision on a bank-detail change is approved or rejected, by the declared actor (%), at the present moment', coalesce(acting::text, 'none')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  IF NEW.status = 'approved' THEN
    IF NEW.decided_by = OLD.requested_by THEN
      RAISE EXCEPTION 'a bank-detail change is approved by a second admin, never by the person who asked for it'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_second_admin';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM org_usable_admin_ids(NEW.organization_id) a WHERE a = NEW.decided_by) THEN
      RAISE EXCEPTION 'user % is not a usable admin of this organisation: only an admin approves a bank-detail change', NEW.decided_by
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_second_admin';
    END IF;
  ELSIF NEW.decided_by <> OLD.requested_by
        AND NOT EXISTS (SELECT 1 FROM org_usable_admin_ids(NEW.organization_id) a WHERE a = NEW.decided_by) THEN
    RAISE EXCEPTION 'only an admin, or the person who asked, rejects a bank-detail change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_change_request_flow';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER bank_detail_change_requests_guard_trg BEFORE INSERT OR UPDATE ON "bank_detail_change_requests" FOR EACH ROW EXECUTE FUNCTION bank_detail_change_request_guard();--> statement-breakpoint
-- ── The write boundary ──────────────────────────────────────────────────────
CREATE FUNCTION bank_detail_dual_control() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  acting integer := (nullif(current_setting('app.current_user_id', true), ''))::integer;
  approved boolean;
  becomes_default boolean;
BEGIN
  IF org_usable_admin_count(NEW.organization_id) < 2 THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'vendors' THEN
    IF NEW.iban IS DISTINCT FROM OLD.iban THEN
      SELECT EXISTS (SELECT 1 FROM bank_detail_change_requests r
        WHERE r.organization_id = NEW.organization_id AND r.kind = 'vendor_iban' AND r.vendor_id = NEW.id
          AND r.status = 'approved' AND r.decided_at = now() AND r.decided_by IS NOT DISTINCT FROM acting
          AND r.iban_before IS NOT DISTINCT FROM OLD.iban AND r.iban_after IS NOT DISTINCT FROM NEW.iban) INTO approved;
      IF NOT approved THEN
        RAISE EXCEPTION 'supplier %: in an organisation with two or more admins, an IBAN change needs a second admin''s approval — record it as a request', NEW.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_dual_control';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- bank_accounts
  IF TG_OP = 'UPDATE' THEN
    IF NEW.iban IS DISTINCT FROM OLD.iban THEN
      SELECT EXISTS (SELECT 1 FROM bank_detail_change_requests r
        WHERE r.organization_id = NEW.organization_id AND r.kind = 'bank_account_iban' AND r.bank_account_id = NEW.id
          AND r.status = 'approved' AND r.decided_at = now() AND r.decided_by IS NOT DISTINCT FROM acting
          AND r.iban_before IS NOT DISTINCT FROM OLD.iban AND r.iban_after IS NOT DISTINCT FROM NEW.iban) INTO approved;
      IF NOT approved THEN
        RAISE EXCEPTION 'bank account %: in an organisation with two or more admins, an IBAN change needs a second admin''s approval — record it as a request', NEW.id
          USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_dual_control';
      END IF;
    END IF;
    becomes_default := NEW.is_default AND NOT OLD.is_default;
  ELSE
    becomes_default := NEW.is_default;
  END IF;
  IF becomes_default THEN
    SELECT EXISTS (SELECT 1 FROM bank_detail_change_requests r
      WHERE r.organization_id = NEW.organization_id AND r.kind = 'default_bank_account' AND r.bank_account_id = NEW.id
        AND r.status = 'approved' AND r.decided_at = now() AND r.decided_by IS NOT DISTINCT FROM acting
        AND r.iban_after IS NOT DISTINCT FROM NEW.iban) INTO approved;
    IF NOT approved THEN
      RAISE EXCEPTION 'bank account %: in an organisation with two or more admins, making it the default (the IBAN printed on invoices) needs a second admin''s approval — record it as a request', coalesce(NEW.id::text, 'new')
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_detail_dual_control';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER vendors_bank_detail_dual_control_trg BEFORE UPDATE OF iban ON "vendors" FOR EACH ROW WHEN (OLD.iban IS DISTINCT FROM NEW.iban) EXECUTE FUNCTION bank_detail_dual_control();--> statement-breakpoint
CREATE TRIGGER bank_accounts_bank_detail_dual_control_trg BEFORE INSERT OR UPDATE OF iban, is_default ON "bank_accounts" FOR EACH ROW EXECUTE FUNCTION bank_detail_dual_control();
