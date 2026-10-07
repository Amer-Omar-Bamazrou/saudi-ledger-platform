/**
 * 🔴 TENANT FOREIGN-KEY RATCHET (G04, 2026-10-07) — a reference from one
 * tenant row to another carries the ORGANIZATION in its foreign key.
 *
 * WHY: Postgres checks a foreign key OUTSIDE row-level security. A plain key
 * `journal_entry_lines.account_id → categories.id` accepted ANOTHER tenant's
 * account (G04: written, approved and posted), and failed a missing one as a
 * raw 23503 — an existence oracle. A key that includes the organization,
 * `(organization_id, account_id) → categories (organization_id, id)`, compares
 * the tenant itself, so no writer — under RLS or not — can store the edge, and
 * a foreign id and a missing id become the same failure.
 *
 * THE RATCHET, read from the CATALOG (never the schema files — a declaration
 * that drifted from the database would agree with a lie):
 *   - every foreign key between two tables that both carry `organization_id`
 *     must pair `organization_id` with `organization_id`;
 *   - the keys that do not yet are PINNED below. A NEW plain key fails here,
 *     and so does a pinned entry that no longer exists — the list only SHRINKS,
 *     in the commit that converts a key.
 *
 * FRAME (what is NOT measured, stated beside the count): keys whose source
 * columns are only `organization_id` / `company_id` (the tenant keys
 * themselves); keys to `users` / `organizations` (no `organization_id`); and
 * id columns with no foreign key at all (a reader cannot see an absent key —
 * the G04 sweep test covers the body ids).
 *
 * Converted in 0122: journal_entry_lines.{account_id, customer_id, vendor_id},
 * invoice_items.product_id; added: fixed_assets.custodian_user_id (to a
 * MEMBERSHIP of the asset's organization), bills.capitalises_asset_id (company
 * too). The proposed conversion order for the rest:
 * docs/security-g04-cross-tenant-account-investigation.md §14.
 */
import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

/** The tenant→tenant foreign keys that do NOT yet carry the organization. Shrink-only. */
const PLAIN_TENANT_KEYS = `
asset_categories.accumulated_depreciation_account_id → categories.id
asset_categories.cost_account_id → categories.id
asset_categories.depreciation_expense_account_id → categories.id
asset_depreciation_schedule.asset_id → fixed_assets.id
asset_depreciation_schedule.journal_entry_id → journal_entries.id
asset_disposals.asset_id → fixed_assets.id
asset_disposals.journal_entry_id → journal_entries.id
asset_events.asset_id → fixed_assets.id
asset_events.journal_entry_id → journal_entries.id
asset_vat_use_records.asset_id → fixed_assets.id
bank_accounts.opening_journal_entry_id → journal_entries.id
bank_reconciliation_reopenings.reconciliation_id → bank_reconciliations.id
bank_reconciliations.bank_account_id → bank_accounts.id
bank_reconciliations.bank_statement_id → bank_statements.id
bank_statement_link_reversals.link_id → bank_statement_links.id
bank_statement_links.journal_line_id → journal_entry_lines.id
bank_statement_links.transaction_id → transactions.id
bank_statements.bank_account_id → bank_accounts.id
bank_transfer_reversals.reversal_journal_entry_id → journal_entries.id
bank_transfer_reversals.transfer_id → bank_transfers.id
bank_transfers.from_bank_account_id → bank_accounts.id
bank_transfers.journal_entry_id → journal_entries.id
bank_transfers.to_bank_account_id → bank_accounts.id
bill_items.bill_id → bills.id
bill_items.product_id → products.id
bill_payments.bank_account_id → bank_accounts.id
bill_payments.bill_id → bills.id
bill_payments.journal_entry_id → journal_entries.id
bill_prepayments.advance_bill_id → bills.id
bill_prepayments.allocation_id → supplier_payment_allocations.id
bill_prepayments.bill_id → bills.id
bills.advance_supplier_payment_id → supplier_payments.id
bills.credit_note_against_bill_id → bills.id
bills.expense_account_id → categories.id
bills.expense_paid_from_bank_account_id → bank_accounts.id
bills.migration_open_item_id → migration_open_items.id
bills.opening_correction_journal_entry_id → journal_entries.id
bills.replaces_bill_id → bills.id
bills.reversed_by_migration_batch_id → migration_batches.id
bills.vendor_id → vendors.id
budget_lines.account_id → categories.id
budget_lines.version_id → budget_versions.id
budget_versions.budget_id → budgets.id
budgets_legacy.category_id → categories.id
captured_documents.bill_id → bills.id
cash_line_bank_attributions.account_id → categories.id
cash_line_bank_attributions.bank_account_id → bank_accounts.id
cash_line_bank_attributions.gl_account_id → categories.id
cash_line_bank_attributions.journal_entry_id → journal_entries.id
cash_line_bank_attributions.line_id → journal_entry_lines.id
cash_line_bank_attributions.run_id → cash_cutover_runs.id
categories.bank_account_id → bank_accounts.id
categories.parent_id → categories.id
customer_refunds.bank_account_id → bank_accounts.id
customer_refunds.credit_note_id → invoices.id
customer_refunds.customer_id → customers.id
customer_refunds.journal_entry_id → journal_entries.id
customer_refunds.payment_id → payments.id
departments.branch_id → branches.id
einvoice_archive.einvoice_document_id → einvoice_documents.id
einvoice_archive.invoice_id → invoices.id
einvoice_documents.invoice_id → invoices.id
fixed_assets.capitalisation_journal_entry_id → journal_entries.id
fixed_assets.category_id → asset_categories.id
fixed_assets.replaces_asset_id → fixed_assets.id
fixed_assets.reversed_by_migration_batch_id → migration_batches.id
input_vat_balances.document_id → bills.id
input_vat_events.declaration_id → opening_payable_vat_declarations.id
input_vat_events.document_id → bills.id
input_vat_events.evidence_capture_id → captured_documents.id
input_vat_events.follows_event_id → input_vat_events.id
input_vat_events.journal_entry_id → journal_entries.id
input_vat_events.related_document_id → bills.id
invoice_items.invoice_id → invoices.id
invoice_payments.bank_account_id → bank_accounts.id
invoice_payments.invoice_id → invoices.id
invoice_prepayments.advance_invoice_id → invoices.id
invoice_prepayments.allocation_id → payment_allocations.id
invoice_prepayments.invoice_id → invoices.id
invoices.advance_payment_id → payments.id
invoices.bad_debt_relief_journal_entry_id → journal_entries.id
invoices.customer_id → customers.id
invoices.issued_bank_account_id → bank_accounts.id
invoices.migration_open_item_id → migration_open_items.id
invoices.opening_correction_journal_entry_id → journal_entries.id
invoices.original_invoice_id → invoices.id
invoices.recovers_invoice_id → invoices.id
invoices.recovery_payment_id → payments.id
invoices.replaces_invoice_id → invoices.id
invoices.reversed_by_migration_batch_id → migration_batches.id
journal_entries.migration_batch_id → migration_batches.id
journal_entry_lines.journal_entry_id → journal_entries.id
migration_advances.batch_id → migration_batches.id
migration_advances.resolved_payment_id → payments.id
migration_assets.batch_id → migration_batches.id
migration_assets.batch_id → migration_batches.id
migration_assets.resolved_asset_id → fixed_assets.id
migration_batches.opening_journal_entry_id → journal_entries.id
migration_batches.period_lock_id → period_locks.id
migration_batches.replaces_batch_id → migration_batches.id
migration_batches.reversal_journal_entry_id → journal_entries.id
migration_chart_rows.batch_id → migration_batches.id
migration_chart_rows.resolved_category_id → categories.id
migration_chart_rows.target_bank_account_id → bank_accounts.id
migration_chart_rows.target_category_id → categories.id
migration_deposit_reversals.batch_id → migration_batches.id
migration_deposit_reversals.payment_id → payments.id
migration_deposit_reversals.reversal_journal_entry_id → journal_entries.id
migration_open_items.batch_id → migration_batches.id
migration_open_items.resolved_bill_id → bills.id
migration_open_items.resolved_invoice_id → invoices.id
migration_parties.batch_id → migration_batches.id
migration_parties.existing_customer_id → customers.id
migration_parties.existing_vendor_id → vendors.id
migration_parties.resolved_customer_id → customers.id
migration_parties.resolved_vendor_id → vendors.id
opening_payable_vat_declaration_evidence.capture_id → captured_documents.id
opening_payable_vat_declaration_evidence.declaration_id → opening_payable_vat_declarations.id
opening_payable_vat_declarations.bill_id → bills.id
opening_payable_vat_declarations.migration_open_item_id → migration_open_items.id
payment_allocation_reversals.allocation_id → payment_allocations.id
payment_allocation_reversals.journal_entry_id → journal_entries.id
payment_allocations.credit_note_id → invoices.id
payment_allocations.invoice_id → invoices.id
payment_allocations.journal_entry_id → journal_entries.id
payment_allocations.payment_id → payments.id
payment_classifications.journal_entry_id → journal_entries.id
payment_classifications.payment_id → payments.id
payments.bank_account_id → bank_accounts.id
payments.customer_id → customers.id
payments.journal_entry_id → journal_entries.id
payments.migration_advance_id → migration_advances.id
payments.replaces_payment_id → payments.id
payments.source_transaction_id → transactions.id
payroll_items.employee_id → employees.id
payroll_items.payroll_run_id → payroll_runs.id
products.category_id → categories.id
purchase_order_conversion_items.conversion_id → purchase_order_conversions.id
purchase_order_conversion_items.purchase_order_item_id → purchase_order_items.id
purchase_order_conversions.bill_id → bills.id
purchase_order_conversions.purchase_order_id → purchase_orders.id
purchase_order_items.product_id → products.id
purchase_order_items.purchase_order_id → purchase_orders.id
purchase_orders.vendor_id → vendors.id
quotation_conversion_items.conversion_id → quotation_conversions.id
quotation_conversion_items.quotation_item_id → quotation_items.id
quotation_conversions.invoice_id → invoices.id
quotation_conversions.quotation_id → quotations.id
quotation_items.product_id → products.id
quotation_items.quotation_id → quotations.id
quotations.customer_id → customers.id
recognition_schedule_rows.journal_entry_id → journal_entries.id
recognition_schedule_rows.schedule_id → recognition_schedules.id
recognition_schedules.balance_account_id → categories.id
recognition_schedules.expense_account_id → categories.id
recognition_schedules.opening_journal_entry_id → journal_entries.id
recognition_schedules.vendor_id → vendors.id
recurring_runs.rule_id → recurring_rules.id
scheduled_payments.bank_account_id → bank_accounts.id
scheduled_payments.bill_id → bills.id
scheduled_payments.paid_bill_payment_id → bill_payments.id
statement_match_reversals.match_id → statement_matches.id
statement_matches.payment_id → payments.id
statement_matches.refund_id → customer_refunds.id
statement_matches.transaction_id → transactions.id
supplier_payment_allocation_reversals.allocation_id → supplier_payment_allocations.id
supplier_payment_allocation_reversals.journal_entry_id → journal_entries.id
supplier_payment_allocations.bill_id → bills.id
supplier_payment_allocations.journal_entry_id → journal_entries.id
supplier_payment_allocations.supplier_credit_note_id → bills.id
supplier_payment_allocations.supplier_payment_id → supplier_payments.id
supplier_payment_classifications.journal_entry_id → journal_entries.id
supplier_payment_classifications.supplier_payment_id → supplier_payments.id
supplier_payments.bank_account_id → bank_accounts.id
supplier_payments.journal_entry_id → journal_entries.id
supplier_payments.vendor_id → vendors.id
supplier_refunds.bank_account_id → bank_accounts.id
supplier_refunds.journal_entry_id → journal_entries.id
supplier_refunds.supplier_payment_id → supplier_payments.id
supplier_refunds.vendor_id → vendors.id
tax_adjustments.account_id → categories.id
tax_adjustments.version_id → tax_computation_versions.id
tax_computation_versions.accrual_journal_entry_id → journal_entries.id
tax_computation_versions.computation_id → tax_computations.id
transactions.bank_account_id → bank_accounts.id
transactions.bank_statement_id → bank_statements.id
transactions.category_id → categories.id
transactions.counterparty_bank_account_id → bank_accounts.id
transactions.journal_entry_id → journal_entries.id
transactions.settles_bill_id → bills.id
transactions.settles_invoice_id → invoices.id
vendor_wht_treaty_reliefs.vendor_id → vendors.id
wht_corrections.bill_payment_id → bill_payments.id
wht_corrections.corrected_bill_payment_id → bill_payments.id
wht_corrections.corrected_supplier_payment_id → supplier_payments.id
wht_corrections.original_filing_id → wht_return_filings.id
wht_corrections.reversal_journal_entry_id → journal_entries.id
wht_corrections.supplier_payment_id → supplier_payments.id
wht_corrections.withholding_id → wht_withholdings.id
wht_remittance_reversals.journal_entry_id → journal_entries.id
wht_remittance_reversals.remittance_id → wht_remittances.id
wht_remittances.bank_account_id → bank_accounts.id
wht_remittances.journal_entry_id → journal_entries.id
wht_return_filings.amends_filing_id → wht_return_filings.id
wht_withholdings.bill_id → bills.id
wht_withholdings.bill_payment_id → bill_payments.id
wht_withholdings.correction_id → wht_corrections.id
wht_withholdings.journal_entry_id → journal_entries.id
wht_withholdings.supersedes_withholding_id → wht_withholdings.id
wht_withholdings.supplier_payment_id → supplier_payments.id
wht_withholdings.treaty_relief_id → vendor_wht_treaty_reliefs.id
wht_withholdings.vendor_id → vendors.id
zakat_account_classifications.account_id → categories.id
`.trim().split("\n").map((l) => l.trim());

/** The keys G04 made tenant-scoped — asserted PRESENT by name, so a dropped key cannot pass as "fewer violations". */
const TENANT_KEYED = {
  journal_entry_lines_account_tenant_fk: "journal_entry_lines.organization_id,account_id → categories.organization_id,id",
  journal_entry_lines_customer_tenant_fk: "journal_entry_lines.organization_id,customer_id → customers.organization_id,id",
  journal_entry_lines_vendor_tenant_fk: "journal_entry_lines.organization_id,vendor_id → vendors.organization_id,id",
  invoice_items_product_tenant_fk: "invoice_items.organization_id,product_id → products.organization_id,id",
  fixed_assets_custodian_member_fk: "fixed_assets.custodian_user_id,organization_id → organization_memberships.user_id,organization_id",
  bills_capitalises_asset_tenant_fk: "bills.organization_id,company_id,capitalises_asset_id → fixed_assets.organization_id,company_id,id",
} as const;

const EDGES_SQL = `
  WITH tenant AS (
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind IN ('r','p') AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
  ), fk AS (
    SELECT k.conname, k.conrelid, k.confrelid,
           array_agg(sa.attname ORDER BY u.ord) AS src_cols, array_agg(da.attname ORDER BY u.ord) AS dst_cols
      FROM pg_constraint k
      JOIN LATERAL unnest(k.conkey, k.confkey) WITH ORDINALITY AS u(sk, dk, ord) ON true
      JOIN pg_attribute sa ON sa.attrelid = k.conrelid AND sa.attnum = u.sk
      JOIN pg_attribute da ON da.attrelid = k.confrelid AND da.attnum = u.dk
     WHERE k.contype = 'f' AND k.conrelid IN (SELECT oid FROM tenant) AND k.confrelid IN (SELECT oid FROM tenant)
     GROUP BY k.oid, k.conname, k.conrelid, k.confrelid
  )
  SELECT conname,
         conrelid::regclass::text || '.' || array_to_string(src_cols, ',') || ' → ' || confrelid::regclass::text || '.' || array_to_string(dst_cols, ',') AS edge,
         EXISTS (SELECT 1 FROM unnest(src_cols, dst_cols) AS p(s, d) WHERE s = 'organization_id' AND d = 'organization_id') AS tenant_keyed
    FROM fk
   WHERE NOT (src_cols <@ ARRAY['organization_id','company_id']::name[])`;

describeMaybe("tenant foreign-key ratchet — every tenant→tenant reference carries the organization", () => {
  const read = async () => (await pool.query(EDGES_SQL)).rows as { conname: string; edge: string; tenant_keyed: boolean }[];

  it("the pinned list has no duplicates (a duplicate would let one key be converted twice in the count)", () => {
    expect(new Set(PLAIN_TENANT_KEYS).size).toBe(PLAIN_TENANT_KEYS.length);
  });

  it("🔴 no NEW plain tenant→tenant key, and no pinned entry that has gone (the list only shrinks)", async () => {
    const plain = (await read()).filter((r) => !r.tenant_keyed).map((r) => r.edge);
    const added = plain.filter((e) => !PLAIN_TENANT_KEYS.includes(e)).sort();
    const gone = PLAIN_TENANT_KEYS.filter((e) => !plain.includes(e)).sort();
    expect(added, "a new foreign key between tenant tables must include organization_id (composite key)").toEqual([]);
    expect(gone, "a converted or removed key leaves PLAIN_TENANT_KEYS in the same commit").toEqual([]);
  });

  it("🔴 the six G04 keys EXIST, tenant-keyed, with the exact columns", async () => {
    const rows = await read();
    for (const [name, edge] of Object.entries(TENANT_KEYED)) {
      const r = rows.find((x) => x.conname === name);
      expect(r, `${name} must exist`).toBeTruthy();
      expect(r!.edge).toBe(edge);
      expect(r!.tenant_keyed).toBe(true);
    }
  });

  it("🔴 the six G04 keys are VALIDATED (no NOT VALID key that only checks new rows)", async () => {
    const { rows } = await pool.query(`SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1)`, [Object.keys(TENANT_KEYED)]);
    expect(rows.length).toBe(6);
    for (const r of rows) expect(r.convalidated, `${r.conname} validated`).toBe(true);
  });

  it("ANTI-VACUITY: the detector flags a planted plain key between tenant tables (in a rolled-back transaction)", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await client.query(`CREATE TABLE g04_ratchet_probe (id serial PRIMARY KEY, organization_id uuid, account_id integer REFERENCES categories(id))`);
      const plain = (await client.query(EDGES_SQL)).rows.filter((r) => !r.tenant_keyed).map((r) => r.edge);
      expect(plain).toContain("g04_ratchet_probe.account_id → categories.id");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
