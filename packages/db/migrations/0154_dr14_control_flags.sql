-- ═══════════════════════════════════════════════════════════════════════════
-- 🔴 Phase 18 R-11a — DR-14 (owner, 2026-11-01): "flags only (self-approval;
--    pairs first). A flag never blocks an act. No new approval framework."
--    Register §11.82, §11.111.
--  · control_flags: one row each time one person did both halves of something
--    a second person usually does — approved a document they made, or did both
--    acts of one of the five pairs. Written by the act it describes, in its
--    transaction; it never blocks the act.
--  · The flag names the connection's DECLARED ACTOR (T1b's
--    app.current_user_id): the column defaults to it, and a row naming anyone
--    else is refused (control_flags_actor_from_session).
--  · APPEND-ONLY for every role, the owner included, while its company
--    exists (control_flags_append_only, register §11.113): UPDATE and
--    TRUNCATE are refused always; a DELETE only goes through when the flag's
--    company or organisation is already gone — the cascade of that company's
--    own removal (no product route removes a company). The only other bypass
--    is replica mode (owner-only), as T1b.
--  · Tenant-scoped (RLS, the company arm), read by the approvers: the matrix
--    grants control_flags read to admin and accountant.
-- New table, triggers and grants; no existing row is read or changed. The
-- pre-check refuses and repairs nothing.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'control_flags') THEN
    RAISE EXCEPTION 'pre-check REFUSED: control_flags already exists; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN ('control_flags_actor_from_session', 'control_flags_append_only')) THEN
    RAISE EXCEPTION 'pre-check REFUSED: a function of 0154 already exists; nothing was changed';
  END IF;
  IF EXISTS (SELECT 1 FROM permissions WHERE resource = 'control_flags') THEN
    RAISE EXCEPTION 'pre-check REFUSED: a control_flags grant already exists; nothing was changed';
  END IF;
  RAISE NOTICE 'pre-check: none of 0154''s objects exist yet';
END $$;--> statement-breakpoint
CREATE TABLE "control_flags" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" integer DEFAULT (nullif(current_setting('app.current_user_id', true), ''))::integer NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"reference" text,
	"first_act" text NOT NULL,
	"second_act" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_flags_kind_chk" CHECK ("control_flags"."kind" in ('self_approval', 'pair_approve_pay', 'pair_post_reverse', 'pair_complete_reopen', 'pair_commit_reverse', 'pair_remit_file'))
);
--> statement-breakpoint
ALTER TABLE "control_flags" ADD CONSTRAINT "control_flags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_flags" ADD CONSTRAINT "control_flags_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "control_flags_company_idx" ON "control_flags" USING btree ("company_id","created_at");--> statement-breakpoint
-- ── Tenancy and grants (the 0143/0151 pattern) ──────────────────────────────
ALTER TABLE public.control_flags ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public.control_flags
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
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.control_flags FROM %I', r);
      IF current_setting('server_version_num')::int >= 170000 THEN
        EXECUTE format('REVOKE MAINTAIN ON TABLE public.control_flags FROM %I', r);
      END IF;
      IF r <> 'authenticated' THEN
        EXECUTE format('REVOKE ALL ON TABLE public.control_flags FROM %I', r);
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- 🔴 APPEND-ONLY: a flag is recorded and read, never changed or removed by the request's role (and, below, by none).
    GRANT SELECT, INSERT ON TABLE public.control_flags TO authenticated;
    GRANT USAGE, SELECT ON SEQUENCE public.control_flags_id_seq TO authenticated;
    REVOKE UPDATE, DELETE ON TABLE public.control_flags FROM authenticated;
  END IF;
END $$;--> statement-breakpoint
-- ── The flag names the DECLARED ACTOR (T1b), never a person its writer chose ──
CREATE FUNCTION control_flags_actor_from_session() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE acting integer := nullif(current_setting('app.current_user_id', true), '')::integer;
BEGIN
  IF acting IS NULL OR NEW.actor_user_id IS DISTINCT FROM acting THEN
    RAISE EXCEPTION 'this control flag names user %, but the connection''s declared actor is %: a flag records who acted, never a person its writer chose', coalesce(NEW.actor_user_id::text, 'none'), coalesce(acting::text, 'none')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'control_flag_actor_from_session';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER control_flags_actor_from_session BEFORE INSERT ON "control_flags" FOR EACH ROW EXECUTE FUNCTION control_flags_actor_from_session();--> statement-breakpoint
-- ── Append-only for EVERY role, the owner included, while its company exists (register §11.113) ──
CREATE FUNCTION control_flags_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- the company (or the organisation) itself is being removed: its flags go with it, by the cascade — never alone
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)
       OR NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% on control_flags: a control flag is append-only for every role; nothing in it is changed or removed while its company exists', TG_OP
    USING ERRCODE = 'check_violation', CONSTRAINT = 'control_flag_append_only';
END $$;--> statement-breakpoint
CREATE TRIGGER zz_control_flags_append_only BEFORE UPDATE OR DELETE ON "control_flags" FOR EACH ROW EXECUTE FUNCTION control_flags_append_only();--> statement-breakpoint
CREATE TRIGGER zz_control_flags_no_truncate BEFORE TRUNCATE ON "control_flags" FOR EACH STATEMENT EXECUTE FUNCTION control_flags_append_only();--> statement-breakpoint
-- ── The reader's grant (DR-14): the approvers read the flags ──────────────────
INSERT INTO "permissions" (role, resource, action) VALUES
  ('admin', 'control_flags', 'read'), ('accountant', 'control_flags', 'read')
ON CONFLICT DO NOTHING;
