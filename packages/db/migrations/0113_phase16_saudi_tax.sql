CREATE TABLE "tax_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"version_id" integer NOT NULL,
	"target" text NOT NULL,
	"effect" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"reason" text NOT NULL,
	"legal_reference" text NOT NULL,
	"source_reference" text,
	"account_id" integer,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_adjustments_target_chk" CHECK ("tax_adjustments"."target" in ('adjusted_net_profit', 'zakat_base', 'taxable_income')),
	CONSTRAINT "tax_adjustments_effect_chk" CHECK ("tax_adjustments"."effect" in ('increase', 'decrease')),
	CONSTRAINT "tax_adjustments_amount_chk" CHECK ("tax_adjustments"."amount" > 0),
	CONSTRAINT "tax_adjustments_reason_chk" CHECK (length(btrim("tax_adjustments"."reason")) >= 3),
	CONSTRAINT "tax_adjustments_reference_chk" CHECK (length(btrim("tax_adjustments"."legal_reference")) >= 2)
);
--> statement-breakpoint
CREATE TABLE "tax_computation_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"computation_id" integer NOT NULL,
	"version_no" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"based_on_version_id" integer,
	"notes" text,
	"send_back_note" text,
	"loss_carryforward_available" numeric(15, 2),
	"loss_carryforward_reference" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by" integer,
	"submitted_at" timestamp with time zone,
	"approved_by" integer,
	"approved_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"snapshot" jsonb,
	"inputs_fingerprint" text,
	"result_amount" numeric(15, 2),
	"accrual_journal_entry_id" integer,
	"accrued_amount" numeric(15, 2),
	"accrual_date" date,
	CONSTRAINT "tax_computation_versions_status_chk" CHECK ("tax_computation_versions"."status" in ('draft', 'submitted', 'approved', 'superseded')),
	CONSTRAINT "tax_computation_versions_no_chk" CHECK ("tax_computation_versions"."version_no" >= 1),
	CONSTRAINT "tax_computation_versions_loss_chk" CHECK ("tax_computation_versions"."loss_carryforward_available" is null or "tax_computation_versions"."loss_carryforward_available" >= 0),
	CONSTRAINT "tax_computation_versions_loss_ref_chk" CHECK (coalesce("tax_computation_versions"."loss_carryforward_available", 0) = 0 or length(btrim(coalesce("tax_computation_versions"."loss_carryforward_reference", ''))) > 0),
	CONSTRAINT "tax_computation_versions_approved_chk" CHECK ("tax_computation_versions"."status" not in ('approved', 'superseded') or ("tax_computation_versions"."snapshot" is not null and "tax_computation_versions"."result_amount" is not null and "tax_computation_versions"."approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "tax_computations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"kind" text NOT NULL,
	"fiscal_calendar" text NOT NULL,
	"fiscal_start_month" smallint NOT NULL,
	"fiscal_label" integer NOT NULL,
	"fiscal_year_start" text NOT NULL,
	"fiscal_year_end" text NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_computations_kind_chk" CHECK ("tax_computations"."kind" in ('zakat', 'income_tax')),
	CONSTRAINT "tax_computations_calendar_chk" CHECK ("tax_computations"."fiscal_calendar" in ('gregorian', 'hijri')),
	CONSTRAINT "tax_computations_start_month_chk" CHECK ("tax_computations"."fiscal_start_month" between 1 and 12),
	CONSTRAINT "tax_computations_year_order_chk" CHECK ("tax_computations"."fiscal_year_start" < "tax_computations"."fiscal_year_end"),
	CONSTRAINT "tax_computations_year_format_chk" CHECK ("tax_computations"."fiscal_year_start" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and "tax_computations"."fiscal_year_end" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "vendor_wht_treaty_reliefs" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"vendor_id" integer NOT NULL,
	"payment_type" text NOT NULL,
	"reduced_rate" numeric(7, 4) NOT NULL,
	"treaty_country" text NOT NULL,
	"zatca_approval_reference" text NOT NULL,
	"residency_certificate_reference" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"notes" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" integer,
	"approved_at" timestamp with time zone,
	"revoked_by" integer,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	CONSTRAINT "vendor_wht_treaty_reliefs_type_chk" CHECK ("vendor_wht_treaty_reliefs"."payment_type" in ('rent', 'royalty', 'management_fee', 'air_tickets_or_air_freight', 'sea_freight', 'intl_telecom', 'dividends', 'technical_consulting', 'loan_returns', 'insurance_premiums', 'other_payments')),
	CONSTRAINT "vendor_wht_treaty_reliefs_status_chk" CHECK ("vendor_wht_treaty_reliefs"."status" in ('pending', 'approved', 'revoked')),
	CONSTRAINT "vendor_wht_treaty_reliefs_rate_chk" CHECK ("vendor_wht_treaty_reliefs"."reduced_rate" >= 0 and "vendor_wht_treaty_reliefs"."reduced_rate" < 1),
	CONSTRAINT "vendor_wht_treaty_reliefs_window_chk" CHECK ("vendor_wht_treaty_reliefs"."valid_from" <= "vendor_wht_treaty_reliefs"."valid_to"),
	CONSTRAINT "vendor_wht_treaty_reliefs_country_chk" CHECK ("vendor_wht_treaty_reliefs"."treaty_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "vendor_wht_treaty_reliefs_refs_chk" CHECK (length(btrim("vendor_wht_treaty_reliefs"."zatca_approval_reference")) > 0 and length(btrim("vendor_wht_treaty_reliefs"."residency_certificate_reference")) > 0),
	CONSTRAINT "vendor_wht_treaty_reliefs_revoke_chk" CHECK (("vendor_wht_treaty_reliefs"."status" = 'revoked') = ("vendor_wht_treaty_reliefs"."revoke_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "wht_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"payment_type" text NOT NULL,
	"rate" numeric(7, 4) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"form_row" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"legal_reference" text NOT NULL,
	CONSTRAINT "wht_rates_type_chk" CHECK ("wht_rates"."payment_type" in ('rent', 'royalty', 'management_fee', 'air_tickets_or_air_freight', 'sea_freight', 'intl_telecom', 'dividends', 'technical_consulting', 'loan_returns', 'insurance_premiums', 'other_payments')),
	CONSTRAINT "wht_rates_rate_chk" CHECK ("wht_rates"."rate" >= 0 and "wht_rates"."rate" < 1),
	CONSTRAINT "wht_rates_window_chk" CHECK ("wht_rates"."effective_to" is null or "wht_rates"."effective_to" >= "wht_rates"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "wht_remittance_reversals" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"remittance_id" integer NOT NULL,
	"reason" text NOT NULL,
	"reversed_on" date NOT NULL,
	"journal_entry_id" integer NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wht_remittance_reversals_reason_chk" CHECK (length(btrim("wht_remittance_reversals"."reason")) >= 3)
);
--> statement-breakpoint
CREATE TABLE "wht_remittances" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"period" text,
	"amount" numeric(15, 2) NOT NULL,
	"fine_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"paid_at" date NOT NULL,
	"bank_account_id" integer NOT NULL,
	"reference" text,
	"notes" text,
	"journal_entry_id" integer NOT NULL,
	"idempotency_key" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wht_remittances_period_chk" CHECK ("wht_remittances"."period" is null or "wht_remittances"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "wht_remittances_amount_chk" CHECK ("wht_remittances"."amount" > 0),
	CONSTRAINT "wht_remittances_fine_chk" CHECK ("wht_remittances"."fine_amount" >= 0),
	CONSTRAINT "wht_remittances_paid_after_period_chk" CHECK ("wht_remittances"."period" is null or to_char("wht_remittances"."paid_at", 'YYYY-MM') >= "wht_remittances"."period")
);
--> statement-breakpoint
CREATE TABLE "wht_withholdings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"company_id" uuid DEFAULT (nullif(current_setting('app.current_company_id', true), ''))::uuid NOT NULL,
	"source_kind" text NOT NULL,
	"bill_payment_id" integer,
	"supplier_payment_id" integer,
	"vendor_id" integer NOT NULL,
	"bill_id" integer,
	"payment_date" date NOT NULL,
	"period" text NOT NULL,
	"status" text NOT NULL,
	"payment_type" text,
	"not_subject_reason" text,
	"not_subject_note" text,
	"base_amount" numeric(15, 2) NOT NULL,
	"rate" numeric(7, 4) NOT NULL,
	"statutory_rate" numeric(7, 4),
	"rate_id" integer,
	"treaty_relief_id" integer,
	"wht_amount" numeric(15, 2) NOT NULL,
	"journal_entry_id" integer NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wht_withholdings_source_chk" CHECK (("wht_withholdings"."source_kind" = 'bill_payment' and "wht_withholdings"."bill_payment_id" is not null and "wht_withholdings"."supplier_payment_id" is null)
      or ("wht_withholdings"."source_kind" = 'supplier_payment' and "wht_withholdings"."supplier_payment_id" is not null and "wht_withholdings"."bill_payment_id" is null)),
	CONSTRAINT "wht_withholdings_period_chk" CHECK ("wht_withholdings"."period" = to_char("wht_withholdings"."payment_date", 'YYYY-MM')),
	CONSTRAINT "wht_withholdings_status_chk" CHECK ("wht_withholdings"."status" in ('withheld', 'not_subject')),
	CONSTRAINT "wht_withholdings_type_chk" CHECK ("wht_withholdings"."payment_type" is null or "wht_withholdings"."payment_type" in ('rent', 'royalty', 'management_fee', 'air_tickets_or_air_freight', 'sea_freight', 'intl_telecom', 'dividends', 'technical_consulting', 'loan_returns', 'insurance_premiums', 'other_payments')),
	CONSTRAINT "wht_withholdings_base_chk" CHECK ("wht_withholdings"."base_amount" > 0),
	CONSTRAINT "wht_withholdings_rate_chk" CHECK ("wht_withholdings"."rate" >= 0 and "wht_withholdings"."rate" < 1),
	CONSTRAINT "wht_withholdings_amount_chk" CHECK ("wht_withholdings"."wht_amount" = round("wht_withholdings"."base_amount" * "wht_withholdings"."rate", 2)),
	CONSTRAINT "wht_withholdings_withheld_chk" CHECK ("wht_withholdings"."status" <> 'withheld' or ("wht_withholdings"."payment_type" is not null and "wht_withholdings"."rate_id" is not null and "wht_withholdings"."statutory_rate" is not null and "wht_withholdings"."not_subject_reason" is null)),
	CONSTRAINT "wht_withholdings_not_subject_chk" CHECK ("wht_withholdings"."status" <> 'not_subject' or ("wht_withholdings"."rate" = 0 and "wht_withholdings"."not_subject_reason" in ('goods', 'not_kingdom_source') and "wht_withholdings"."rate_id" is null and "wht_withholdings"."treaty_relief_id" is null)),
	CONSTRAINT "wht_withholdings_note_chk" CHECK ("wht_withholdings"."not_subject_reason" is distinct from 'not_kingdom_source' or length(btrim(coalesce("wht_withholdings"."not_subject_note", ''))) >= 10),
	CONSTRAINT "wht_withholdings_treaty_chk" CHECK ("wht_withholdings"."treaty_relief_id" is null or "wht_withholdings"."rate" <= "wht_withholdings"."statutory_rate")
);
--> statement-breakpoint
CREATE TABLE "zakat_account_classifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid DEFAULT (nullif(current_setting('app.current_org_id', true), ''))::uuid NOT NULL,
	"account_id" integer NOT NULL,
	"classification" text NOT NULL,
	"basis_note" text,
	"confirmed_by" integer,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zakat_account_classifications_class_chk" CHECK ("zakat_account_classifications"."classification" in ('equity', 'provision_as_equity', 'noncurrent_liability', 'current_liability', 'noncurrent_asset_deducted', 'noncurrent_asset_not_deducted', 'current_asset_deducted', 'current_asset_not_deducted'))
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "wht_default_payment_type" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "foreign_tax_id" text;--> statement-breakpoint
ALTER TABLE "tax_adjustments" ADD CONSTRAINT "tax_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_adjustments" ADD CONSTRAINT "tax_adjustments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_adjustments" ADD CONSTRAINT "tax_adjustments_version_id_tax_computation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."tax_computation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_adjustments" ADD CONSTRAINT "tax_adjustments_account_id_categories_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_computation_versions" ADD CONSTRAINT "tax_computation_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_computation_versions" ADD CONSTRAINT "tax_computation_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_computation_versions" ADD CONSTRAINT "tax_computation_versions_computation_id_tax_computations_id_fk" FOREIGN KEY ("computation_id") REFERENCES "public"."tax_computations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_computation_versions" ADD CONSTRAINT "tax_computation_versions_accrual_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("accrual_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_computations" ADD CONSTRAINT "tax_computations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_computations" ADD CONSTRAINT "tax_computations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_wht_treaty_reliefs" ADD CONSTRAINT "vendor_wht_treaty_reliefs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_wht_treaty_reliefs" ADD CONSTRAINT "vendor_wht_treaty_reliefs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_wht_treaty_reliefs" ADD CONSTRAINT "vendor_wht_treaty_reliefs_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_remittance_reversals" ADD CONSTRAINT "wht_remittance_reversals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_remittance_reversals" ADD CONSTRAINT "wht_remittance_reversals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_remittance_reversals" ADD CONSTRAINT "wht_remittance_reversals_remittance_id_wht_remittances_id_fk" FOREIGN KEY ("remittance_id") REFERENCES "public"."wht_remittances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_remittance_reversals" ADD CONSTRAINT "wht_remittance_reversals_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_remittances" ADD CONSTRAINT "wht_remittances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_remittances" ADD CONSTRAINT "wht_remittances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_remittances" ADD CONSTRAINT "wht_remittances_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_remittances" ADD CONSTRAINT "wht_remittances_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_bill_payment_id_bill_payments_id_fk" FOREIGN KEY ("bill_payment_id") REFERENCES "public"."bill_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_supplier_payment_id_supplier_payments_id_fk" FOREIGN KEY ("supplier_payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_rate_id_wht_rates_id_fk" FOREIGN KEY ("rate_id") REFERENCES "public"."wht_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_treaty_relief_id_vendor_wht_treaty_reliefs_id_fk" FOREIGN KEY ("treaty_relief_id") REFERENCES "public"."vendor_wht_treaty_reliefs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wht_withholdings" ADD CONSTRAINT "wht_withholdings_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zakat_account_classifications" ADD CONSTRAINT "zakat_account_classifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zakat_account_classifications" ADD CONSTRAINT "zakat_account_classifications_account_id_categories_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_adjustments_version_idx" ON "tax_adjustments" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_computation_versions_no_unq" ON "tax_computation_versions" USING btree ("computation_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_computation_versions_one_approved_unq" ON "tax_computation_versions" USING btree ("computation_id") WHERE status = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "tax_computation_versions_one_open_unq" ON "tax_computation_versions" USING btree ("computation_id") WHERE status in ('draft', 'submitted');--> statement-breakpoint
CREATE INDEX "tax_computation_versions_company_idx" ON "tax_computation_versions" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_computations_company_kind_year_unq" ON "tax_computations" USING btree ("company_id","kind","fiscal_year_start");--> statement-breakpoint
CREATE INDEX "vendor_wht_treaty_reliefs_vendor_idx" ON "vendor_wht_treaty_reliefs" USING btree ("company_id","vendor_id","payment_type");--> statement-breakpoint
CREATE UNIQUE INDEX "wht_rates_type_from_unq" ON "wht_rates" USING btree ("payment_type","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "wht_remittance_reversals_one_unq" ON "wht_remittance_reversals" USING btree ("remittance_id");--> statement-breakpoint
CREATE INDEX "wht_remittance_reversals_entry_idx" ON "wht_remittance_reversals" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "wht_remittances_period_idx" ON "wht_remittances" USING btree ("company_id","period");--> statement-breakpoint
CREATE INDEX "wht_remittances_entry_idx" ON "wht_remittances" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wht_remittances_idempotency_unq" ON "wht_remittances" USING btree ("company_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wht_withholdings_bill_payment_unq" ON "wht_withholdings" USING btree ("bill_payment_id") WHERE bill_payment_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wht_withholdings_supplier_payment_unq" ON "wht_withholdings" USING btree ("supplier_payment_id") WHERE supplier_payment_id is not null;--> statement-breakpoint
CREATE INDEX "wht_withholdings_period_idx" ON "wht_withholdings" USING btree ("company_id","period");--> statement-breakpoint
CREATE INDEX "wht_withholdings_vendor_idx" ON "wht_withholdings" USING btree ("company_id","vendor_id","payment_date");--> statement-breakpoint
CREATE INDEX "wht_withholdings_entry_idx" ON "wht_withholdings" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "zakat_account_classifications_account_unq" ON "zakat_account_classifications" USING btree ("organization_id","account_id");--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_wht_default_type_chk" CHECK (wht_default_payment_type IS NULL OR wht_default_payment_type IN ('rent', 'royalty', 'management_fee', 'air_tickets_or_air_freight', 'sea_freight', 'intl_telecom', 'dividends', 'technical_consulting', 'loan_returns', 'insurance_premiums', 'other_payments'));--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 16 — Saudi tax expansion: the hand-written half.
-- Record: docs/product/phase-16-17-tax-treasury-decision-pack.md (§2–§5, §9–§10).
--
--   1. the WHT rates (IR Art. 63(1) as amended by MoF Resolution 25, in force 12-09-2023)
--   2. the system accounts (Zakat expense, income tax, tax fines; Zakat payable promoted)
--   3. WHT: treaty reliefs, withholdings, remittances — admitted only when their
--      arithmetic, their dates and their tenancy are right; append-only
--   4. 🔴 WHT_PAYABLE has exactly two writers (a deferred guard at COMMIT)
--   5. the entries a tax record owns are never reversed generically
--   6. the Zakat classification, the computations and their adjustments — the
--      0112 lifecycle lock
--   7. tenancy, grants, permissions; 8. the gate
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The WHT rates — the regulation's, effective-dated (pack §2.2) ───────
INSERT INTO "wht_rates" (payment_type, rate, effective_from, effective_to, form_row, name_en, name_ar, legal_reference) VALUES
  ('rent',                       0.0500, '2023-09-12', NULL, '01', 'Rent',                                         'إيجار',                                  'Income Tax IR Art. 63(1) (MoF Res. 25/1445H)'),
  ('royalty',                    0.1500, '2023-09-12', NULL, '02', 'Royalty or proceeds',                          'إتاوة أو ريع',                           'Income Tax IR Art. 63(1) (MoF Res. 25/1445H)'),
  ('management_fee',             0.2000, '2023-09-12', NULL, '03', 'Management fees',                              'أتعاب إدارة',                            'Income Tax IR Art. 63(1)–(2) (MoF Res. 25/1445H)'),
  ('air_tickets_or_air_freight', 0.0500, '2023-09-12', NULL, '04', 'Air tickets (departing KSA) or air freight',  'تذاكر طيران دولية أو شحن جوي',           'Income Tax IR Art. 63(1), (4) (MoF Res. 25/1445H)'),
  ('sea_freight',                0.0500, '2023-09-12', NULL, '05', 'Sea freight',                                  'شحن بحري',                               'Income Tax IR Art. 63(1), (4) (MoF Res. 25/1445H)'),
  ('intl_telecom',               0.0500, '2023-09-12', NULL, '06', 'International telephone services',             'خدمات اتصالات هاتفية دولية',             'Income Tax IR Art. 63(1), (5) (MoF Res. 25/1445H; Res. 484/1444H)'),
  ('dividends',                  0.0500, '2023-09-12', NULL, '09', 'Dividends',                                    'أرباح موزعة',                            'Income Tax IR Art. 63(1), (6) (MoF Res. 25/1445H)'),
  ('technical_consulting',       0.0500, '2023-09-12', NULL, '10', 'Technical or consulting services',             'خدمات فنية أو استشارية',                 'Income Tax IR Art. 63(1), (3) (MoF Res. 25/1445H)'),
  ('loan_returns',               0.0500, '2023-09-12', NULL, '11', 'Loan returns',                                 'عوائد قروض',                             'Income Tax IR Art. 63(1) (MoF Res. 25/1445H)'),
  ('insurance_premiums',         0.0500, '2023-09-12', NULL, '12', 'Insurance or reinsurance premium',             'أقساط تأمين أو إعادة تأمين',             'Income Tax IR Art. 63(1) (MoF Res. 25/1445H)'),
  ('other_payments',             0.1500, '2023-09-12', NULL, '13', 'Other payments (services not listed)',          'دفعات أخرى (خدمات غير مدرجة)',          'Income Tax IR Art. 63(1), (7) (MoF Res. 25/1445H)')
ON CONFLICT (payment_type, effective_from) DO NOTHING;--> statement-breakpoint
-- a rate is the Kingdom's: nobody but the owner role rewrites one
CREATE OR REPLACE FUNCTION wht_rates_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE owner_name text;
BEGIN
  SELECT tableowner INTO owner_name FROM pg_tables WHERE schemaname = 'public' AND tablename = 'wht_rates';
  IF current_user = owner_name THEN RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION 'wht_rates is the regulation''s table: % is refused', TG_OP USING ERRCODE = '23514', CONSTRAINT = 'wht_rates_owner_only';
END $$;--> statement-breakpoint
CREATE TRIGGER wht_rates_immutable BEFORE INSERT OR UPDATE OR DELETE ON "wht_rates" FOR EACH ROW EXECUTE FUNCTION wht_rates_immutable();--> statement-breakpoint
-- two rows of one nature in force on the same day would make "the rate on the payment date" two answers
CREATE OR REPLACE FUNCTION wht_rates_no_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM wht_rates r WHERE r.payment_type = NEW.payment_type AND r.id <> NEW.id
               AND r.effective_from <= coalesce(NEW.effective_to, 'infinity'::date)
               AND coalesce(r.effective_to, 'infinity'::date) >= NEW.effective_from) THEN
    RAISE EXCEPTION 'wht_rates: % already has a rate in force inside % – %', NEW.payment_type, NEW.effective_from, coalesce(NEW.effective_to::text, 'open')
      USING ERRCODE = '23514', CONSTRAINT = 'wht_rates_overlap';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER wht_rates_no_overlap BEFORE INSERT OR UPDATE ON "wht_rates" FOR EACH ROW EXECUTE FUNCTION wht_rates_no_overlap();--> statement-breakpoint

-- ── 2. The system accounts (pack §3.5, §4, §2.5) ───────────────────────────
-- A template ROW (not a column), so seed_org_chart_of_accounts() is unchanged
-- (the 0107 AD-13 refinement); every existing organisation is back-filled here.
INSERT INTO "system_account_templates" (code, name, name_ar, type, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, sort_order)
VALUES
  ('INCOME_TAX_PAYABLE', 'Income tax payable',      'ضريبة الدخل المستحقة', 'liability', true, false, 'O', false, 'current', 270),
  ('ZAKAT_EXPENSE',      'Zakat expense',           'مصروف الزكاة',          'expense',   true, false, 'O', false, NULL,      385),
  ('INCOME_TAX_EXPENSE', 'Income tax expense',      'مصروف ضريبة الدخل',     'expense',   true, false, 'O', false, NULL,      386),
  ('TAX_PENALTIES',      'Tax fines and penalties', 'غرامات ضريبية',         'expense',   true, false, 'O', false, NULL,      387)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint
-- 🔴 Zakat payable: the EXISTING liability bank lines categorised "zakat" already
-- settle (0029, retyped by 0036). Promoted, not duplicated: a second payable would
-- leave the accrual on one account and the payment on the other.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM categories WHERE system_code = 'ZAKAT_PAYMENT' AND type <> 'liability') THEN
    RAISE EXCEPTION 'migration 0113: a ZAKAT_PAYMENT account is not a liability; resolve it before promoting it to Zakat payable';
  END IF;
END $$;--> statement-breakpoint
UPDATE "system_account_templates" SET is_system = true, name = 'Zakat payable', name_ar = 'الزكاة المستحقة', type = 'liability', liquidity_class = 'current'
 WHERE code = 'ZAKAT_PAYMENT';--> statement-breakpoint
UPDATE "categories" SET name = 'Zakat payable', name_ar = 'الزكاة المستحقة'
 WHERE system_code = 'ZAKAT_PAYMENT' AND name = 'Zakat Payment';--> statement-breakpoint
UPDATE "categories" SET is_system = true, liquidity_class = coalesce(liquidity_class, 'current')
 WHERE system_code = 'ZAKAT_PAYMENT';--> statement-breakpoint
INSERT INTO "categories" (organization_id, name, name_ar, type, system_code, is_system, vat_applicable, default_tax_treatment, treatment_verified, liquidity_class, is_posting)
SELECT o.id, t.name, t.name_ar, t.type, t.code, t.is_system, t.vat_applicable, t.default_tax_treatment, t.treatment_verified, t.liquidity_class, true
  FROM organizations o
  CROSS JOIN system_account_templates t
 WHERE t.code IN ('ZAKAT_PAYMENT', 'INCOME_TAX_PAYABLE', 'ZAKAT_EXPENSE', 'INCOME_TAX_EXPENSE', 'TAX_PENALTIES')
ON CONFLICT (organization_id, system_code) DO NOTHING;--> statement-breakpoint

-- ── 3a. Treaty reliefs: recorded, then APPROVED, then perhaps revoked ───────
CREATE OR REPLACE FUNCTION vendor_wht_treaty_reliefs_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE co record; v record; statutory numeric;
BEGIN
  SELECT id, organization_id INTO co FROM companies WHERE id = NEW.company_id;
  IF co.id IS NULL OR co.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'treaty relief: company % is not in this organisation', NEW.company_id USING ERRCODE = '23514', CONSTRAINT = 'wht_relief_tenant';
  END IF;
  SELECT id, organization_id, residency INTO v FROM vendors WHERE id = NEW.vendor_id;
  -- a foreign supplier id is answered exactly like a missing one
  IF v.id IS NULL OR v.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'treaty relief: supplier % is not a supplier of this organisation', NEW.vendor_id USING ERRCODE = '23514', CONSTRAINT = 'wht_relief_tenant';
  END IF;
  IF v.residency <> 'non_resident' THEN
    RAISE EXCEPTION 'treaty relief: supplier % is not declared non-resident — a treaty relieves only a payment to a non-resident', NEW.vendor_id
      USING ERRCODE = '23514', CONSTRAINT = 'wht_relief_not_non_resident';
  END IF;
  IF NEW.status <> 'pending' OR NEW.approved_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'treaty relief: a relief is recorded PENDING and takes effect only once approved' USING ERRCODE = '23514', CONSTRAINT = 'wht_relief_born_pending';
  END IF;
  SELECT r.rate INTO statutory FROM wht_rates r
   WHERE r.payment_type = NEW.payment_type AND r.effective_from <= NEW.valid_from AND (r.effective_to IS NULL OR r.effective_to >= NEW.valid_from);
  IF statutory IS NULL THEN
    RAISE EXCEPTION 'treaty relief: no statutory % rate is loaded for %', NEW.payment_type, NEW.valid_from USING ERRCODE = '23514', CONSTRAINT = 'wht_relief_no_rate';
  END IF;
  IF NEW.reduced_rate > statutory THEN
    RAISE EXCEPTION 'treaty relief: a reduced rate (%) cannot exceed the statutory rate (%)', NEW.reduced_rate, statutory USING ERRCODE = '23514', CONSTRAINT = 'wht_relief_rate';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION vendor_wht_treaty_reliefs_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER vendor_wht_treaty_reliefs_admit BEFORE INSERT ON "vendor_wht_treaty_reliefs" FOR EACH ROW EXECUTE FUNCTION vendor_wht_treaty_reliefs_admit();--> statement-breakpoint
CREATE OR REPLACE FUNCTION vendor_wht_treaty_reliefs_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- a relief a withholding applied, or one ever approved, is a record
    IF OLD.status <> 'pending' OR EXISTS (SELECT 1 FROM wht_withholdings w WHERE w.treaty_relief_id = OLD.id) THEN
      RAISE EXCEPTION 'treaty relief % is %: a relief that was approved is a record — revoke it instead', OLD.id, OLD.status
        USING ERRCODE = '23514', CONSTRAINT = 'wht_relief_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id OR NEW.payment_type IS DISTINCT FROM OLD.payment_type OR NEW.reduced_rate IS DISTINCT FROM OLD.reduced_rate
     OR NEW.treaty_country IS DISTINCT FROM OLD.treaty_country OR NEW.zatca_approval_reference IS DISTINCT FROM OLD.zatca_approval_reference
     OR NEW.residency_certificate_reference IS DISTINCT FROM OLD.residency_certificate_reference
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.valid_to IS DISTINCT FROM OLD.valid_to
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'treaty relief %: its terms are fixed when it is recorded — revoke it and record another', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'wht_relief_terms_frozen';
  END IF;
  IF (OLD.status, NEW.status) = ('pending', 'approved') THEN
    IF NEW.approved_at IS NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'treaty relief %: an approval records who approved it and when', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'wht_relief_transition';
    END IF;
  ELSIF (OLD.status, NEW.status) IN (('pending', 'revoked'), ('approved', 'revoked')) THEN
    IF NEW.revoked_at IS NULL OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'treaty relief %: a revocation records only who revoked it, when and why', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'wht_relief_transition';
    END IF;
  ELSIF NEW.status = OLD.status THEN
    IF NEW.notes IS DISTINCT FROM OLD.notes AND OLD.status = 'pending'
       AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at AND NEW.revoked_at IS NOT DISTINCT FROM OLD.revoked_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'treaty relief % is %: it cannot be changed', OLD.id, OLD.status USING ERRCODE = '23514', CONSTRAINT = 'wht_relief_immutable';
  ELSE
    RAISE EXCEPTION 'treaty relief %: % → % is not a step of its lifecycle', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'wht_relief_transition';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION vendor_wht_treaty_reliefs_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER vendor_wht_treaty_reliefs_guard BEFORE UPDATE OR DELETE ON "vendor_wht_treaty_reliefs" FOR EACH ROW EXECUTE FUNCTION vendor_wht_treaty_reliefs_guard();--> statement-breakpoint

-- ── 3b. 🔴 A withholding is admitted only when it IS its payment ────────────
-- The base is the payment's own amount, the date its date, the supplier its
-- supplier, the entry its entry; the rate is the row in force on that date (or
-- an approved relief covering it); the tax is base × rate (the table CHECK).
CREATE OR REPLACE FUNCTION wht_withholdings_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p record; v record; r record; rel record; e record;
BEGIN
  IF NEW.source_kind = 'bill_payment' THEN
    SELECT bp.id, bp.organization_id, bp.company_id, bp.amount, bp.paid_at, bp.journal_entry_id, bp.bill_id, b.vendor_id
      INTO p FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id WHERE bp.id = NEW.bill_payment_id;
    IF p.id IS NOT NULL AND NEW.bill_id IS DISTINCT FROM p.bill_id THEN
      RAISE EXCEPTION 'withholding: bill % is not the bill payment %''s bill', NEW.bill_id, NEW.bill_payment_id USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_payment';
    END IF;
  ELSE
    SELECT sp.id, sp.organization_id, sp.company_id, sp.amount, sp.paid_at, sp.journal_entry_id, NULL::integer AS bill_id, sp.vendor_id
      INTO p FROM supplier_payments sp WHERE sp.id = NEW.supplier_payment_id;
    IF NEW.bill_id IS NOT NULL THEN
      RAISE EXCEPTION 'withholding: a supplier payment''s withholding names no single bill' USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_payment';
    END IF;
  END IF;
  IF p.id IS NULL OR p.organization_id IS DISTINCT FROM NEW.organization_id OR p.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'withholding: the payment is not in this organisation and company' USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_tenant';
  END IF;
  IF p.vendor_id IS DISTINCT FROM NEW.vendor_id OR p.paid_at IS DISTINCT FROM NEW.payment_date
     OR p.amount IS DISTINCT FROM NEW.base_amount OR p.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id THEN
    RAISE EXCEPTION 'withholding: its supplier, date, base and entry must be the payment''s own (supplier %, %, %, entry %)', p.vendor_id, p.paid_at, p.amount, p.journal_entry_id
      USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_payment';
  END IF;
  SELECT id, organization_id, residency INTO v FROM vendors WHERE id = NEW.vendor_id;
  IF v.id IS NULL OR v.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'withholding: supplier % is not in this organisation', NEW.vendor_id USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_tenant';
  END IF;
  IF v.residency <> 'non_resident' THEN
    RAISE EXCEPTION 'withholding: supplier % is not declared non-resident (Income Tax Law Art. 68)', NEW.vendor_id USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_residency';
  END IF;
  SELECT id, organization_id, company_id INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF e.id IS NULL OR e.organization_id IS DISTINCT FROM NEW.organization_id OR e.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'withholding: entry % is not in this organisation and company', NEW.journal_entry_id USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_tenant';
  END IF;
  IF NEW.status = 'withheld' THEN
    SELECT id, rate INTO r FROM wht_rates
     WHERE payment_type = NEW.payment_type AND effective_from <= NEW.payment_date AND (effective_to IS NULL OR effective_to >= NEW.payment_date);
    IF r.id IS NULL OR r.id IS DISTINCT FROM NEW.rate_id OR r.rate IS DISTINCT FROM NEW.statutory_rate THEN
      RAISE EXCEPTION 'withholding: the rate must be the % rate in force on % (wht_rates)', NEW.payment_type, NEW.payment_date
        USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_rate';
    END IF;
    IF NEW.treaty_relief_id IS NULL THEN
      IF NEW.rate IS DISTINCT FROM r.rate THEN
        RAISE EXCEPTION 'withholding: without a treaty relief the rate is the statutory % (not %)', r.rate, NEW.rate USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_rate';
      END IF;
    ELSE
      SELECT id, company_id, vendor_id, payment_type, reduced_rate, valid_from, valid_to, status INTO rel FROM vendor_wht_treaty_reliefs WHERE id = NEW.treaty_relief_id;
      IF rel.id IS NULL OR rel.company_id IS DISTINCT FROM NEW.company_id OR rel.vendor_id IS DISTINCT FROM NEW.vendor_id
         OR rel.payment_type IS DISTINCT FROM NEW.payment_type OR rel.status <> 'approved'
         OR NEW.payment_date < rel.valid_from OR NEW.payment_date > rel.valid_to OR rel.reduced_rate IS DISTINCT FROM NEW.rate THEN
        RAISE EXCEPTION 'withholding: treaty relief % does not cover this supplier, nature and date, or is not approved', NEW.treaty_relief_id
          USING ERRCODE = '23514', CONSTRAINT = 'wht_withholding_relief';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_withholdings_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER wht_withholdings_admit BEFORE INSERT ON "wht_withholdings" FOR EACH ROW EXECUTE FUNCTION wht_withholdings_admit();--> statement-breakpoint

-- append-only, for every role (the input_vat_events pattern)
CREATE OR REPLACE FUNCTION wht_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: WHT records are append-only; % is refused (a remittance is undone by its reversal)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514', CONSTRAINT = 'wht_append_only';
END $$;--> statement-breakpoint
CREATE TRIGGER wht_withholdings_append_only BEFORE UPDATE OR DELETE ON "wht_withholdings" FOR EACH ROW EXECUTE FUNCTION wht_append_only();--> statement-breakpoint
CREATE TRIGGER wht_remittances_append_only BEFORE UPDATE OR DELETE ON "wht_remittances" FOR EACH ROW EXECUTE FUNCTION wht_append_only();--> statement-breakpoint
CREATE TRIGGER wht_remittance_reversals_append_only BEFORE UPDATE OR DELETE ON "wht_remittance_reversals" FOR EACH ROW EXECUTE FUNCTION wht_append_only();--> statement-breakpoint

-- ── 3c. A remittance pays no more than the month still owes ───────────────
-- unremitted(month) = Σ withheld − Σ live remittances; the OPENING balance
-- (period NULL) = the migrated WHT_PAYABLE − Σ live opening remittances.
CREATE OR REPLACE FUNCTION wht_unremitted(p_company_id uuid, p_period text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_period IS NULL THEN
           coalesce((SELECT sum(l.credit_amount - l.debit_amount) FROM journal_entry_lines l
                       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
                      WHERE e.company_id = p_company_id AND c.system_code = 'WHT_PAYABLE' AND e.status IN ('posted', 'reversed')
                        AND e.source IN ('opening', 'opening_reversal', 'opening_correction')), 0)
         ELSE
           coalesce((SELECT sum(w.wht_amount) FROM wht_withholdings w WHERE w.company_id = p_company_id AND w.period = p_period AND w.status = 'withheld'), 0)
         END
       - coalesce((SELECT sum(r.amount) FROM wht_remittances r
                    WHERE r.company_id = p_company_id AND r.period IS NOT DISTINCT FROM p_period
                      AND NOT EXISTS (SELECT 1 FROM wht_remittance_reversals x WHERE x.remittance_id = r.id)), 0)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_unremitted(uuid, text) FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE FUNCTION wht_remittances_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE co record; b record; e record; open_amount numeric;
BEGIN
  SELECT id, organization_id INTO co FROM companies WHERE id = NEW.company_id;
  IF co.id IS NULL OR co.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'WHT remittance: company % is not in this organisation', NEW.company_id USING ERRCODE = '23514', CONSTRAINT = 'wht_remittance_tenant';
  END IF;
  SELECT id, organization_id, company_id INTO b FROM bank_accounts WHERE id = NEW.bank_account_id;
  IF b.id IS NULL OR b.organization_id IS DISTINCT FROM NEW.organization_id OR b.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'WHT remittance: bank account % is not in this organisation and company', NEW.bank_account_id USING ERRCODE = '23514', CONSTRAINT = 'wht_remittance_tenant';
  END IF;
  SELECT id, organization_id, company_id INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF e.id IS NULL OR e.organization_id IS DISTINCT FROM NEW.organization_id OR e.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'WHT remittance: entry % is not in this organisation and company', NEW.journal_entry_id USING ERRCODE = '23514', CONSTRAINT = 'wht_remittance_tenant';
  END IF;
  -- one remitter per company and month at a time: the check and the insert cannot race
  PERFORM pg_advisory_xact_lock(hashtext('wht-remit:' || NEW.company_id::text || ':' || coalesce(NEW.period, 'opening')));
  open_amount := wht_unremitted(NEW.company_id, NEW.period);
  IF NEW.amount > open_amount THEN
    RAISE EXCEPTION 'WHT remittance: % exceeds what % still owes (%)', NEW.amount, coalesce(NEW.period, 'the opening balance'), open_amount
      USING ERRCODE = '23514', CONSTRAINT = 'wht_remittance_exceeds';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_remittances_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER wht_remittances_admit BEFORE INSERT ON "wht_remittances" FOR EACH ROW EXECUTE FUNCTION wht_remittances_admit();--> statement-breakpoint
CREATE OR REPLACE FUNCTION wht_remittance_reversals_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; e record;
BEGIN
  SELECT id, organization_id, company_id INTO r FROM wht_remittances WHERE id = NEW.remittance_id;
  IF r.id IS NULL OR r.organization_id IS DISTINCT FROM NEW.organization_id OR r.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'WHT remittance reversal: remittance % is not in this organisation and company', NEW.remittance_id USING ERRCODE = '23514', CONSTRAINT = 'wht_remittance_reversal_tenant';
  END IF;
  SELECT id, organization_id, company_id INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF e.id IS NULL OR e.organization_id IS DISTINCT FROM NEW.organization_id OR e.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'WHT remittance reversal: entry % is not in this organisation and company', NEW.journal_entry_id USING ERRCODE = '23514', CONSTRAINT = 'wht_remittance_reversal_tenant';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_remittance_reversals_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER wht_remittance_reversals_admit BEFORE INSERT ON "wht_remittance_reversals" FOR EACH ROW EXECUTE FUNCTION wht_remittance_reversals_admit();--> statement-breakpoint

-- ── 4. 🔴 WHT_PAYABLE HAS EXACTLY TWO WRITERS ───────────────────────────────
-- At COMMIT, every line on a WHT_PAYABLE account belongs to an entry a WHT
-- record owns (a withholding, a remittance, its reversal) — or to a migration
-- opening entry — and the entry's net movement on the account equals what those
-- records say. A manual journal or a categorised bank line can no longer move
-- it, so GL WHT_PAYABLE = opening + Σ withheld − Σ remitted + Σ reversed, exactly.
CREATE OR REPLACE FUNCTION wht_payable_line_owned() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e record; net numeric; expected numeric; owned boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = NEW.account_id AND c.system_code = 'WHT_PAYABLE') THEN RETURN NULL; END IF;
  SELECT id, entry_number, source INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF e.id IS NULL OR e.source IN ('opening', 'opening_reversal', 'opening_correction') THEN RETURN NULL; END IF;
  owned := EXISTS (SELECT 1 FROM wht_withholdings WHERE journal_entry_id = e.id)
        OR EXISTS (SELECT 1 FROM wht_remittances WHERE journal_entry_id = e.id)
        OR EXISTS (SELECT 1 FROM wht_remittance_reversals WHERE journal_entry_id = e.id);
  IF NOT owned THEN
    RAISE EXCEPTION 'journal entry % (%) moves Withholding tax payable, but no WHT record owns it: WHT is withheld only by a supplier payment and settled only by a WHT remittance',
      e.id, e.entry_number USING ERRCODE = '23514', CONSTRAINT = 'wht_payable_unowned';
  END IF;
  SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0) INTO net
    FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
   WHERE l.journal_entry_id = e.id AND c.system_code = 'WHT_PAYABLE';
  expected := coalesce((SELECT sum(w.wht_amount) FROM wht_withholdings w WHERE w.journal_entry_id = e.id AND w.status = 'withheld'), 0)
            - coalesce((SELECT sum(r.amount) FROM wht_remittances r WHERE r.journal_entry_id = e.id), 0)
            + coalesce((SELECT sum(r.amount) FROM wht_remittance_reversals x JOIN wht_remittances r ON r.id = x.remittance_id WHERE x.journal_entry_id = e.id), 0);
  IF net <> expected THEN
    RAISE EXCEPTION 'journal entry % (%) moves Withholding tax payable by % but its WHT records say %', e.id, e.entry_number, net, expected
      USING ERRCODE = '23514', CONSTRAINT = 'wht_payable_amount';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wht_payable_line_owned() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER wht_payable_line_owned AFTER INSERT OR UPDATE ON "journal_entry_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wht_payable_line_owned();--> statement-breakpoint

-- ── 5. The entries a tax record owns are corrected through it, never reversed generically ──
-- ONE definition, read by the service (documentOwner) and by both guards.
CREATE INDEX IF NOT EXISTS "tax_computation_versions_accrual_entry_idx" ON "tax_computation_versions" USING btree ("accrual_journal_entry_id") WHERE accrual_journal_entry_id IS NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION tax_journal_owner(p_entry_id integer) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM wht_withholdings WHERE journal_entry_id = p_entry_id) THEN 'wht_withholding'
    WHEN EXISTS (SELECT 1 FROM wht_remittances WHERE journal_entry_id = p_entry_id) THEN 'wht_remittance'
    WHEN EXISTS (SELECT 1 FROM wht_remittance_reversals WHERE journal_entry_id = p_entry_id) THEN 'wht_remittance_reversal'
    WHEN EXISTS (SELECT 1 FROM tax_computation_versions WHERE accrual_journal_entry_id = p_entry_id) THEN 'tax_accrual'
  END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION tax_journal_owner(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tax_journal_owner(integer) TO authenticated;--> statement-breakpoint
CREATE OR REPLACE FUNCTION tax_journal_protected(p_entry_id integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT tax_journal_owner(p_entry_id) IS NOT NULL
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION tax_journal_protected(integer) FROM PUBLIC;--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal_entries_tax_reversal_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'posted' AND NEW.status = 'reversed' AND tax_journal_protected(NEW.id) THEN
    RAISE EXCEPTION 'journal entry % (%) belongs to a WHT record or a tax computation; it is corrected through that record, never reversed generically',
      NEW.id, NEW.entry_number USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_tax_reversal_guard';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION journal_entries_tax_reversal_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER journal_entries_tax_reversal_guard BEFORE UPDATE OF status ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION journal_entries_tax_reversal_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal_entry_lines_tax_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF tax_journal_protected(OLD.journal_entry_id) AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'journal line % belongs to entry %, which a WHT record or a tax computation owns; its lines cannot be changed', OLD.id, OLD.journal_entry_id
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_lines_tax_guard';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION journal_entry_lines_tax_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER journal_entry_lines_tax_guard BEFORE UPDATE OR DELETE ON "journal_entry_lines"
  FOR EACH ROW EXECUTE FUNCTION journal_entry_lines_tax_guard();--> statement-breakpoint

-- ── 6a. The Zakat classification: a balance-sheet LEAF of this organisation, a class its type admits ──
CREATE OR REPLACE FUNCTION zakat_account_classifications_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a record;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.account_id IS DISTINCT FROM OLD.account_id) THEN
    RAISE EXCEPTION 'Zakat classification %: its account is fixed', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'zakat_classification_identity';
  END IF;
  SELECT id, organization_id, type, is_posting INTO a FROM categories WHERE id = NEW.account_id;
  IF a.id IS NULL OR a.organization_id IS DISTINCT FROM NEW.organization_id OR a.is_posting IS NOT TRUE THEN
    RAISE EXCEPTION 'Zakat classification: account % is not a posting account of this organisation', NEW.account_id
      USING ERRCODE = '23514', CONSTRAINT = 'zakat_classification_account';
  END IF;
  -- Art. 9: an EQUITY account is equity by its own SOCPA type — it is never classified here
  IF a.type = 'asset' AND NEW.classification NOT IN ('noncurrent_asset_deducted', 'noncurrent_asset_not_deducted', 'current_asset_deducted', 'current_asset_not_deducted') THEN
    RAISE EXCEPTION 'Zakat classification: an asset takes an asset class, not %', NEW.classification USING ERRCODE = '23514', CONSTRAINT = 'zakat_classification_type';
  ELSIF a.type = 'liability' AND NEW.classification NOT IN ('equity', 'provision_as_equity', 'noncurrent_liability', 'current_liability') THEN
    RAISE EXCEPTION 'Zakat classification: a liability takes a liability, provision or equity class, not %', NEW.classification USING ERRCODE = '23514', CONSTRAINT = 'zakat_classification_type';
  ELSIF a.type NOT IN ('asset', 'liability') THEN
    RAISE EXCEPTION 'Zakat classification: only asset and liability accounts are classified (equity is equity, Art. 23(1); income and expense enter through net profit)'
      USING ERRCODE = '23514', CONSTRAINT = 'zakat_classification_type';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION zakat_account_classifications_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER zakat_account_classifications_admit BEFORE INSERT OR UPDATE ON "zakat_account_classifications" FOR EACH ROW EXECUTE FUNCTION zakat_account_classifications_admit();--> statement-breakpoint

-- ── 6b. Computations: a frozen fiscal year (the budgets pattern) ───────────
CREATE OR REPLACE FUNCTION tax_computations_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE co record;
BEGIN
  SELECT id, organization_id INTO co FROM companies WHERE id = NEW.company_id;
  IF co.id IS NULL OR co.organization_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'tax computation: company % is not in this organisation', NEW.company_id USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_tenant';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION tax_computations_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER tax_computations_admit BEFORE INSERT ON "tax_computations" FOR EACH ROW EXECUTE FUNCTION tax_computations_admit();--> statement-breakpoint
CREATE OR REPLACE FUNCTION tax_computations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.fiscal_calendar IS DISTINCT FROM OLD.fiscal_calendar OR NEW.fiscal_start_month IS DISTINCT FROM OLD.fiscal_start_month
     OR NEW.fiscal_label IS DISTINCT FROM OLD.fiscal_label OR NEW.fiscal_year_start IS DISTINCT FROM OLD.fiscal_year_start
     OR NEW.fiscal_year_end IS DISTINCT FROM OLD.fiscal_year_end
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tax computation %: its company, kind and fiscal year are fixed when it is created (only its notes may change)', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_frozen';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER tax_computations_guard BEFORE UPDATE ON "tax_computations" FOR EACH ROW EXECUTE FUNCTION tax_computations_guard();--> statement-breakpoint

-- ── 6c. Versions: born a draft; moved only along the lifecycle; frozen once approved ──
CREATE OR REPLACE FUNCTION tax_computation_versions_admit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c record; base record; next_no integer;
BEGIN
  SELECT id, organization_id, company_id INTO c FROM tax_computations WHERE id = NEW.computation_id;
  IF c.id IS NULL OR c.organization_id IS DISTINCT FROM NEW.organization_id OR c.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'tax computation version: computation % is not in this organisation and company', NEW.computation_id
      USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_tenant';
  END IF;
  IF NEW.status <> 'draft' OR NEW.submitted_at IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.superseded_at IS NOT NULL
     OR NEW.snapshot IS NOT NULL OR NEW.result_amount IS NOT NULL OR NEW.accrual_journal_entry_id IS NOT NULL OR NEW.accrued_amount IS NOT NULL THEN
    RAISE EXCEPTION 'tax computation version: a version is created as a DRAFT and moves on only through the lifecycle'
      USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_born_draft';
  END IF;
  SELECT coalesce(max(version_no), 0) + 1 INTO next_no FROM tax_computation_versions WHERE computation_id = NEW.computation_id;
  IF NEW.version_no <> next_no THEN
    RAISE EXCEPTION 'tax computation version: the next version of computation % is %, not %', NEW.computation_id, next_no, NEW.version_no
      USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_sequence';
  END IF;
  IF NEW.based_on_version_id IS NOT NULL THEN
    SELECT id, computation_id, status INTO base FROM tax_computation_versions WHERE id = NEW.based_on_version_id;
    IF base.id IS NULL OR base.computation_id <> NEW.computation_id OR base.status <> 'approved' THEN
      RAISE EXCEPTION 'tax computation version: a revision is copied from the computation''s APPROVED version'
        USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_revision_base';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION tax_computation_versions_admit() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER tax_computation_versions_admit BEFORE INSERT ON "tax_computation_versions" FOR EACH ROW EXECUTE FUNCTION tax_computation_versions_admit();--> statement-breakpoint
CREATE OR REPLACE FUNCTION tax_computation_versions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved', 'superseded') THEN
      RAISE EXCEPTION 'tax computation version % (v%) is %: an approved computation is a record and is never deleted — revise it instead', OLD.id, OLD.version_no, OLD.status
        USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.computation_id IS DISTINCT FROM OLD.computation_id OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.based_on_version_id IS DISTINCT FROM OLD.based_on_version_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tax computation version %: its identity is fixed', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_identity';
  END IF;
  -- the approval evidence and the accrual are written ONLY by the approval step and pinned after it
  IF NOT ((OLD.status, NEW.status) IN (('draft', 'approved'), ('submitted', 'approved')))
     AND (NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.inputs_fingerprint IS DISTINCT FROM OLD.inputs_fingerprint
          OR NEW.result_amount IS DISTINCT FROM OLD.result_amount OR NEW.accrual_journal_entry_id IS DISTINCT FROM OLD.accrual_journal_entry_id
          OR NEW.accrued_amount IS DISTINCT FROM OLD.accrued_amount OR NEW.accrual_date IS DISTINCT FROM OLD.accrual_date) THEN
    RAISE EXCEPTION 'tax computation version % (v%): its snapshot and accrual are written only by its approval', OLD.id, OLD.version_no
      USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_transition';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'draft' OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.send_back_note IS DISTINCT FROM OLD.send_back_note THEN
      RAISE EXCEPTION 'tax computation version % (v%) is %: it cannot be changed', OLD.id, OLD.version_no, OLD.status
        USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.loss_carryforward_available IS DISTINCT FROM OLD.loss_carryforward_available OR NEW.loss_carryforward_reference IS DISTINCT FROM OLD.loss_carryforward_reference
     OR NEW.notes IS DISTINCT FROM OLD.notes THEN
    RAISE EXCEPTION 'tax computation version % (v%): a transition changes nothing but its own record', OLD.id, OLD.version_no
      USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_transition';
  END IF;
  IF (OLD.status, NEW.status) = ('draft', 'submitted') THEN
    IF NEW.submitted_at IS NULL OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
      RAISE EXCEPTION 'tax computation version % (v%): a submission records only who submitted and when', OLD.id, OLD.version_no
        USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_transition';
    END IF;
  ELSIF (OLD.status, NEW.status) = ('submitted', 'draft') THEN
    IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
      RAISE EXCEPTION 'tax computation version % (v%): a send-back records only its note', OLD.id, OLD.version_no
        USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_transition';
    END IF;
  ELSIF (OLD.status, NEW.status) IN (('draft', 'approved'), ('submitted', 'approved')) THEN
    IF NEW.approved_at IS NULL OR NEW.snapshot IS NULL OR NEW.result_amount IS NULL
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
      RAISE EXCEPTION 'tax computation version % (v%): an approval records who approved, when, the snapshot and the result', OLD.id, OLD.version_no
        USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_transition';
    END IF;
    IF NEW.accrual_journal_entry_id IS NOT NULL THEN
      SELECT id, organization_id, company_id INTO e FROM journal_entries WHERE id = NEW.accrual_journal_entry_id;
      IF e.id IS NULL OR e.organization_id IS DISTINCT FROM NEW.organization_id OR e.company_id IS DISTINCT FROM NEW.company_id THEN
        RAISE EXCEPTION 'tax computation version %: accrual entry % is not in this organisation and company', OLD.id, NEW.accrual_journal_entry_id
          USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_tenant';
      END IF;
    END IF;
  ELSIF (OLD.status, NEW.status) = ('approved', 'superseded') THEN
    IF NEW.superseded_at IS NULL OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
       OR NEW.send_back_note IS DISTINCT FROM OLD.send_back_note
       OR NOT EXISTS (SELECT 1 FROM tax_computation_versions v WHERE v.computation_id = OLD.computation_id AND v.version_no > OLD.version_no AND v.status IN ('draft', 'submitted')) THEN
      RAISE EXCEPTION 'tax computation version % (v%): an approved version is superseded only by approving a newer revision', OLD.id, OLD.version_no
        USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_transition';
    END IF;
  ELSE
    RAISE EXCEPTION 'tax computation version % (v%): % → % is not a step of the lifecycle', OLD.id, OLD.version_no, OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_transition';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION tax_computation_versions_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER tax_computation_versions_guard BEFORE UPDATE OR DELETE ON "tax_computation_versions" FOR EACH ROW EXECUTE FUNCTION tax_computation_versions_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION tax_computation_versions_one_approved_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tax_computation_versions WHERE computation_id = NEW.computation_id AND status = 'approved') THEN
    RAISE EXCEPTION 'tax computation %: a superseded version must be replaced by an approved one in the same transaction', NEW.computation_id
      USING ERRCODE = '23514', CONSTRAINT = 'tax_computation_version_superseded_alone';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION tax_computation_versions_one_approved_check() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER tax_computation_versions_one_approved AFTER UPDATE OF status ON "tax_computation_versions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'superseded') EXECUTE FUNCTION tax_computation_versions_one_approved_check();--> statement-breakpoint

-- ── 6d. Adjustments: only a draft's; a target the computation's kind has ──
CREATE OR REPLACE FUNCTION tax_adjustments_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v record; a record; ver_id integer;
BEGIN
  ver_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  SELECT tv.id, tv.organization_id, tv.company_id, tv.status, tv.version_no, c.kind INTO v
    FROM tax_computation_versions tv JOIN tax_computations c ON c.id = tv.computation_id WHERE tv.id = ver_id FOR UPDATE OF tv;
  IF TG_OP = 'DELETE' THEN
    IF v.id IS NOT NULL AND v.status <> 'draft' THEN
      RAISE EXCEPTION 'tax computation version % (v%) is %: its adjustments are locked', v.id, v.version_no, v.status
        USING ERRCODE = '23514', CONSTRAINT = 'tax_adjustment_locked';
    END IF;
    RETURN OLD;
  END IF;
  IF v.id IS NULL OR v.organization_id IS DISTINCT FROM NEW.organization_id OR v.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'tax adjustment: version % is not in this organisation and company', NEW.version_id USING ERRCODE = '23514', CONSTRAINT = 'tax_adjustment_tenant';
  END IF;
  IF v.status <> 'draft' THEN
    RAISE EXCEPTION 'tax computation version % (v%) is %: its adjustments are locked', v.id, v.version_no, v.status
      USING ERRCODE = '23514', CONSTRAINT = 'tax_adjustment_locked';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.version_id IS DISTINCT FROM OLD.version_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'tax adjustment %: its version and author are fixed', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'tax_adjustment_identity';
  END IF;
  IF (v.kind = 'zakat' AND NEW.target NOT IN ('adjusted_net_profit', 'zakat_base'))
     OR (v.kind = 'income_tax' AND NEW.target <> 'taxable_income') THEN
    RAISE EXCEPTION 'tax adjustment: a % computation has no % line', v.kind, NEW.target USING ERRCODE = '23514', CONSTRAINT = 'tax_adjustment_target';
  END IF;
  IF NEW.account_id IS NOT NULL THEN
    SELECT id, organization_id INTO a FROM categories WHERE id = NEW.account_id;
    IF a.id IS NULL OR a.organization_id IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'tax adjustment: account % is not an account of this organisation', NEW.account_id USING ERRCODE = '23514', CONSTRAINT = 'tax_adjustment_account';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION tax_adjustments_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER tax_adjustments_guard BEFORE INSERT OR UPDATE OR DELETE ON "tax_adjustments" FOR EACH ROW EXECUTE FUNCTION tax_adjustments_guard();--> statement-breakpoint

-- records never vanish by TRUNCATE (the 0110/0112 pattern)
CREATE OR REPLACE FUNCTION tax_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: tax records; TRUNCATE is refused', TG_TABLE_NAME USING ERRCODE = '23514', CONSTRAINT = 'tax_no_truncate';
END $$;--> statement-breakpoint
CREATE TRIGGER wht_rates_no_truncate BEFORE TRUNCATE ON "wht_rates" FOR EACH STATEMENT EXECUTE FUNCTION tax_no_truncate();--> statement-breakpoint
CREATE TRIGGER vendor_wht_treaty_reliefs_no_truncate BEFORE TRUNCATE ON "vendor_wht_treaty_reliefs" FOR EACH STATEMENT EXECUTE FUNCTION tax_no_truncate();--> statement-breakpoint
CREATE TRIGGER wht_withholdings_no_truncate BEFORE TRUNCATE ON "wht_withholdings" FOR EACH STATEMENT EXECUTE FUNCTION tax_no_truncate();--> statement-breakpoint
CREATE TRIGGER wht_remittances_no_truncate BEFORE TRUNCATE ON "wht_remittances" FOR EACH STATEMENT EXECUTE FUNCTION tax_no_truncate();--> statement-breakpoint
CREATE TRIGGER wht_remittance_reversals_no_truncate BEFORE TRUNCATE ON "wht_remittance_reversals" FOR EACH STATEMENT EXECUTE FUNCTION tax_no_truncate();--> statement-breakpoint
CREATE TRIGGER zakat_account_classifications_no_truncate BEFORE TRUNCATE ON "zakat_account_classifications" FOR EACH STATEMENT EXECUTE FUNCTION tax_no_truncate();--> statement-breakpoint
CREATE TRIGGER tax_computations_no_truncate BEFORE TRUNCATE ON "tax_computations" FOR EACH STATEMENT EXECUTE FUNCTION tax_no_truncate();--> statement-breakpoint
CREATE TRIGGER tax_computation_versions_no_truncate BEFORE TRUNCATE ON "tax_computation_versions" FOR EACH STATEMENT EXECUTE FUNCTION tax_no_truncate();--> statement-breakpoint
CREATE TRIGGER tax_adjustments_no_truncate BEFORE TRUNCATE ON "tax_adjustments" FOR EACH STATEMENT EXECUTE FUNCTION tax_no_truncate();--> statement-breakpoint

-- ── 7. Tenant isolation, grants, permissions ───────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_wht_treaty_reliefs', 'wht_withholdings', 'wht_remittances', 'wht_remittance_reversals',
                           'tax_computations', 'tax_computation_versions', 'tax_adjustments'] LOOP
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
-- the chart is organisation-level, and so is its Zakat classification (Q6)
ALTER TABLE "zakat_account_classifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON public."zakat_account_classifications"
  USING ( (organization_id)::text = current_setting('app.current_org_id', true) )
  WITH CHECK ( (organization_id)::text = current_setting('app.current_org_id', true) );--> statement-breakpoint
GRANT SELECT ON TABLE "wht_rates" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "vendor_wht_treaty_reliefs" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "vendor_wht_treaty_reliefs_id_seq" TO authenticated;--> statement-breakpoint
-- 🔴 append-only: INSERT and SELECT only (the triggers refuse the rest for every role besides)
GRANT SELECT, INSERT ON TABLE "wht_withholdings" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "wht_withholdings_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "wht_remittances" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "wht_remittances_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "wht_remittance_reversals" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "wht_remittance_reversals_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "zakat_account_classifications" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "zakat_account_classifications_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tax_computations" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "tax_computations_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tax_computation_versions" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "tax_computation_versions_id_seq" TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tax_adjustments" TO authenticated;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "tax_adjustments_id_seq" TO authenticated;--> statement-breakpoint
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['wht_rates', 'vendor_wht_treaty_reliefs', 'wht_withholdings', 'wht_remittances', 'wht_remittance_reversals',
                               'zakat_account_classifications', 'tax_computations', 'tax_computation_versions', 'tax_adjustments'] LOOP
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I', t, r);
        IF current_setting('server_version_num')::int >= 170000 THEN
          EXECUTE format('REVOKE MAINTAIN ON TABLE public.%I FROM %I', t, r);
        END IF;
      END LOOP;
      -- the regulation's table: read, never written, by any application role
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE public.wht_rates FROM %I', r);
      IF r <> 'authenticated' THEN
        EXECUTE format('REVOKE ALL ON TABLE public.wht_withholdings, public.wht_remittances, public.wht_remittance_reversals FROM %I', r);
      END IF;
    END IF;
  END LOOP;
  -- the reader of the opening WHT balance and the owner predicate run for the application
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.wht_unremitted(uuid, text) TO authenticated';
  END IF;
END $$;--> statement-breakpoint
-- `tax`: everyone reads; a bookkeeper drafts computations, adjustments,
-- classifications and treaty reliefs; an approver approves them, remits WHT and
-- reverses a remittance; deleting a never-approved computation is an admin's.
INSERT INTO "permissions" (role, resource, action) VALUES
  ('admin', 'tax', 'read'), ('admin', 'tax', 'create'), ('admin', 'tax', 'update'), ('admin', 'tax', 'approve'), ('admin', 'tax', 'delete'),
  ('accountant', 'tax', 'read'), ('accountant', 'tax', 'create'), ('accountant', 'tax', 'update'), ('accountant', 'tax', 'approve'),
  ('bookkeeper', 'tax', 'read'), ('bookkeeper', 'tax', 'create'), ('bookkeeper', 'tax', 'update'),
  ('viewer', 'tax', 'read')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- ── 8. 🔴 THE GATE — nothing already on WHT_PAYABLE breaks the new rule ────
-- Before this migration nothing wrote WHT_PAYABLE (B8 foundation); a manual
-- journal could have. Such a line is NAMED and the migration STOPS — never
-- grandfathered into a payable no WHT record explains.
DO $$
DECLARE n integer; sample text;
BEGIN
  SELECT count(*), string_agg(DISTINCT e.entry_number, ', ') INTO n, sample
    FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
   WHERE c.system_code = 'WHT_PAYABLE' AND coalesce(e.source, '') NOT IN ('opening', 'opening_reversal', 'opening_correction');
  IF n > 0 THEN
    RAISE EXCEPTION 'migration 0113: % journal line(s) already move Withholding tax payable outside any WHT record (entries: %); resolve them before Phase 16', n, sample;
  END IF;
END $$;
