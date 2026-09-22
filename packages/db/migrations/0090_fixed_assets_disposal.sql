CREATE TABLE "asset_disposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"asset_id" integer NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"proceeds" numeric(15, 2) DEFAULT '0' NOT NULL,
	"invoice_id" integer,
	"accumulated_at_disposal" numeric(15, 2) NOT NULL,
	"carrying_amount_at_disposal" numeric(15, 2) NOT NULL,
	"gain_loss" numeric(15, 2) NOT NULL,
	"vat_treatment" text NOT NULL,
	"nominal_supply_value" numeric(15, 2),
	"reason" text,
	"journal_entry_id" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_disposals_asset_unq" UNIQUE("asset_id")
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "disposes_asset_id" integer;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_asset_id_fixed_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════════
-- FIXED ASSETS — FA-C: DISPOSAL (2026-09-22). Record:
-- docs/product/fixed-assets-decision-pack.md §9, §22.
--
-- A disposal is TERMINAL and is corrected by reversal and a new act, never
-- edited: one row per asset (the unique above), frozen once written, and the
-- asset it names becomes `disposed` (FA-A's state CHECK already requires the
-- disposal date and the capitalisation entry).
--
-- The Saudi consequences live in `kind` and `vat_treatment`:
--   sold      → a taxable supply on its own tax invoice (Art. 3(5)), unless
--               the asset was a restricted motor vehicle bought without
--               deduction, whose sale is outside the economic activity
--               (Art. 50(3)) — `out_of_scope_restricted_vehicle`;
--   scrapped / destroyed / stolen → NO Art. 52(7) adjustment (52(7) says so);
--   withdrawn while still usable → a NOMINAL SUPPLY valued by the Art. 52(8)
--               formula, stored here whether or not v1 declares it (FA-2).
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_kind_chk" CHECK (kind IN ('sold', 'scrapped', 'destroyed', 'stolen', 'withdrawn'));--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_vat_treatment_chk" CHECK (vat_treatment IN ('taxable_supply', 'out_of_scope_restricted_vehicle', 'no_adjustment', 'nominal_supply'));--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_money_chk" CHECK (proceeds >= 0 AND accumulated_at_disposal >= 0 AND carrying_amount_at_disposal >= 0 AND (nominal_supply_value IS NULL OR nominal_supply_value >= 0));--> statement-breakpoint
-- proceeds − carrying = gain/loss, to the halala (IAS 16.71)
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_gain_loss_chk" CHECK (abs(gain_loss - (proceeds - carrying_amount_at_disposal)) <= 0.005);--> statement-breakpoint
-- a SALE has its invoice and may have proceeds; the rest never carry an invoice
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_shape_chk" CHECK (
  (kind = 'sold' AND invoice_id IS NOT NULL)
  OR (kind <> 'sold' AND invoice_id IS NULL AND proceeds = 0)
);--> statement-breakpoint
-- a nominal-supply value belongs to a WITHDRAWAL and to nothing else (Art. 52(8))
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_nominal_chk" CHECK ((vat_treatment = 'nominal_supply') = (kind = 'withdrawn'));--> statement-breakpoint
ALTER TABLE "asset_disposals" ADD CONSTRAINT "asset_disposals_posted_chk" CHECK (journal_entry_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "asset_disposals_org_idx" ON "asset_disposals" USING btree ("organization_id", "company_id");--> statement-breakpoint
CREATE INDEX "asset_disposals_invoice_idx" ON "asset_disposals" USING btree ("invoice_id") WHERE invoice_id IS NOT NULL;--> statement-breakpoint

-- Tenant isolation, grants, the owner-only REVOKE pattern (M14).
ALTER TABLE "asset_disposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."asset_disposals"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true)
          AND ( COALESCE(current_setting('app.current_company_id', true), '') = ''
                OR (company_id)::text = current_setting('app.current_company_id', true) ) );--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "asset_disposals" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "asset_disposals_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.asset_disposals FROM %I', r);
    END IF;
  END LOOP;
  -- a disposal is never updated or deleted by the app: it is reversed and re-done
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON TABLE public.asset_disposals FROM authenticated';
  END IF;
END $$;--> statement-breakpoint

-- Frozen once written (the owner too, against an UPDATE).
CREATE OR REPLACE FUNCTION refuse_asset_disposal_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'disposal % of asset % is a terminal record: correct it by reversing its entry and disposing again, never by editing', OLD.id, OLD.asset_id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_disposal_frozen';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER asset_disposals_frozen_trg BEFORE UPDATE ON "asset_disposals" FOR EACH ROW EXECUTE FUNCTION refuse_asset_disposal_change();--> statement-breakpoint

-- An invoice that SELLS an asset names it; nothing else may.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_disposes_asset_chk" CHECK (disposes_asset_id IS NULL OR document_type = 'invoice');--> statement-breakpoint
-- 🔴 One asset is sold ONCE — among ISSUED invoices. A DRAFT that names the
-- asset has disposed of nothing (a refused approval leaves one behind, and the
-- corrected invoice must be enterable); `asset_disposals.asset_id` is the
-- invariant proper, and this index is its guard on the document side.
CREATE UNIQUE INDEX "invoices_disposes_asset_unq" ON "invoices" USING btree ("disposes_asset_id") WHERE disposes_asset_id IS NOT NULL AND invoice_hash IS NOT NULL;
