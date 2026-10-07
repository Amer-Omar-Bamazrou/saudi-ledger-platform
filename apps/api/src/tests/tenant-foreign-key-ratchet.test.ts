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
 * too). The proposed conversion order for the rest: docs/security-g04-tenant-keys.md.
 */
import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

/**
 * The tenant→tenant foreign keys that do NOT yet carry the organization, as
 * `constraint: edge` — by NAME, because two constraints can share one edge
 * (`migration_assets.batch_id` carries two identical keys today). Shrink-only.
 */
const PLAIN_TENANT_KEYS = `
asset_categories_accumulated_depreciation_account_id_categories: asset_categories.accumulated_depreciation_account_id → categories.id
asset_categories_cost_account_id_categories_id_fk: asset_categories.cost_account_id → categories.id
asset_categories_depreciation_expense_account_id_categories_id_: asset_categories.depreciation_expense_account_id → categories.id
asset_depreciation_schedule_asset_id_fixed_assets_id_fk: asset_depreciation_schedule.asset_id → fixed_assets.id
asset_depreciation_schedule_journal_entry_id_journal_entries_id: asset_depreciation_schedule.journal_entry_id → journal_entries.id
asset_disposals_asset_id_fixed_assets_id_fk: asset_disposals.asset_id → fixed_assets.id
asset_disposals_journal_entry_id_journal_entries_id_fk: asset_disposals.journal_entry_id → journal_entries.id
asset_events_asset_id_fixed_assets_id_fk: asset_events.asset_id → fixed_assets.id
asset_events_journal_entry_id_journal_entries_id_fk: asset_events.journal_entry_id → journal_entries.id
asset_vat_use_records_asset_id_fixed_assets_id_fk: asset_vat_use_records.asset_id → fixed_assets.id
bank_accounts_opening_journal_entry_id_fk: bank_accounts.opening_journal_entry_id → journal_entries.id
bank_reconciliation_reopenings_reconciliation_id_bank_reconcili: bank_reconciliation_reopenings.reconciliation_id → bank_reconciliations.id
bank_reconciliations_bank_account_id_bank_accounts_id_fk: bank_reconciliations.bank_account_id → bank_accounts.id
bank_reconciliations_bank_statement_id_bank_statements_id_fk: bank_reconciliations.bank_statement_id → bank_statements.id
bank_statement_link_reversals_link_id_bank_statement_links_id_f: bank_statement_link_reversals.link_id → bank_statement_links.id
bank_statement_links_journal_line_id_journal_entry_lines_id_fk: bank_statement_links.journal_line_id → journal_entry_lines.id
bank_statement_links_transaction_id_transactions_id_fk: bank_statement_links.transaction_id → transactions.id
bank_statements_bank_account_id_bank_accounts_id_fk: bank_statements.bank_account_id → bank_accounts.id
bank_transfer_reversals_reversal_journal_entry_id_journal_entri: bank_transfer_reversals.reversal_journal_entry_id → journal_entries.id
bank_transfer_reversals_transfer_id_bank_transfers_id_fk: bank_transfer_reversals.transfer_id → bank_transfers.id
bank_transfers_from_bank_account_id_bank_accounts_id_fk: bank_transfers.from_bank_account_id → bank_accounts.id
bank_transfers_journal_entry_id_journal_entries_id_fk: bank_transfers.journal_entry_id → journal_entries.id
bank_transfers_to_bank_account_id_bank_accounts_id_fk: bank_transfers.to_bank_account_id → bank_accounts.id
bill_items_bill_id_bills_id_fk: bill_items.bill_id → bills.id
bill_items_product_id_products_id_fk: bill_items.product_id → products.id
bill_payments_bank_account_id_bank_accounts_id_fk: bill_payments.bank_account_id → bank_accounts.id
bill_payments_bill_id_bills_id_fk: bill_payments.bill_id → bills.id
bill_payments_journal_entry_id_journal_entries_id_fk: bill_payments.journal_entry_id → journal_entries.id
bill_prepayments_advance_bill_id_bills_id_fk: bill_prepayments.advance_bill_id → bills.id
bill_prepayments_allocation_id_supplier_payment_allocations_id_: bill_prepayments.allocation_id → supplier_payment_allocations.id
bill_prepayments_bill_id_bills_id_fk: bill_prepayments.bill_id → bills.id
bills_advance_supplier_payment_fk: bills.advance_supplier_payment_id → supplier_payments.id
bills_expense_account_id_categories_id_fk: bills.expense_account_id → categories.id
bills_expense_bank_fk: bills.expense_paid_from_bank_account_id → bank_accounts.id
bills_migration_open_item_id_fk: bills.migration_open_item_id → migration_open_items.id
bills_note_against_fk: bills.credit_note_against_bill_id → bills.id
bills_opening_correction_je_fk: bills.opening_correction_journal_entry_id → journal_entries.id
bills_replaces_bill_fk: bills.replaces_bill_id → bills.id
bills_reversed_by_batch_fk: bills.reversed_by_migration_batch_id → migration_batches.id
bills_vendor_id_vendors_id_fk: bills.vendor_id → vendors.id
budget_lines_account_id_categories_id_fk: budget_lines.account_id → categories.id
budget_lines_version_id_budget_versions_id_fk: budget_lines.version_id → budget_versions.id
budget_versions_budget_id_budgets_id_fk: budget_versions.budget_id → budgets.id
budgets_legacy_category_id_fk: budgets_legacy.category_id → categories.id
captured_documents_bill_id_bills_id_fk: captured_documents.bill_id → bills.id
cash_line_bank_attributions_account_id_categories_id_fk: cash_line_bank_attributions.account_id → categories.id
cash_line_bank_attributions_bank_account_id_bank_accounts_id_fk: cash_line_bank_attributions.bank_account_id → bank_accounts.id
cash_line_bank_attributions_gl_account_id_categories_id_fk: cash_line_bank_attributions.gl_account_id → categories.id
cash_line_bank_attributions_journal_entry_id_journal_entries_id: cash_line_bank_attributions.journal_entry_id → journal_entries.id
cash_line_bank_attributions_line_id_journal_entry_lines_id_fk: cash_line_bank_attributions.line_id → journal_entry_lines.id
cash_line_bank_attributions_run_id_cash_cutover_runs_id_fk: cash_line_bank_attributions.run_id → cash_cutover_runs.id
categories_bank_account_id_bank_accounts_id_fk: categories.bank_account_id → bank_accounts.id
categories_parent_id_categories_id_fk: categories.parent_id → categories.id
customer_refunds_bank_account_id_bank_accounts_id_fk: customer_refunds.bank_account_id → bank_accounts.id
customer_refunds_credit_note_id_invoices_id_fk: customer_refunds.credit_note_id → invoices.id
customer_refunds_customer_id_customers_id_fk: customer_refunds.customer_id → customers.id
customer_refunds_journal_entry_id_journal_entries_id_fk: customer_refunds.journal_entry_id → journal_entries.id
customer_refunds_payment_id_payments_id_fk: customer_refunds.payment_id → payments.id
departments_branch_id_branches_id_fk: departments.branch_id → branches.id
einvoice_archive_einvoice_document_id_einvoice_documents_id_fk: einvoice_archive.einvoice_document_id → einvoice_documents.id
einvoice_archive_invoice_id_invoices_id_fk: einvoice_archive.invoice_id → invoices.id
einvoice_documents_invoice_id_invoices_id_fk: einvoice_documents.invoice_id → invoices.id
fixed_assets_capitalisation_journal_entry_id_journal_entries_id: fixed_assets.capitalisation_journal_entry_id → journal_entries.id
fixed_assets_category_id_asset_categories_id_fk: fixed_assets.category_id → asset_categories.id
fixed_assets_replaces_asset_id_fixed_assets_id_fk: fixed_assets.replaces_asset_id → fixed_assets.id
fixed_assets_reversed_by_batch_fk: fixed_assets.reversed_by_migration_batch_id → migration_batches.id
input_vat_balances_document_id_bills_id_fk: input_vat_balances.document_id → bills.id
input_vat_events_declaration_id_opening_payable_vat_declaration: input_vat_events.declaration_id → opening_payable_vat_declarations.id
input_vat_events_document_id_bills_id_fk: input_vat_events.document_id → bills.id
input_vat_events_evidence_capture_id_captured_documents_id_fk: input_vat_events.evidence_capture_id → captured_documents.id
input_vat_events_follows_fk: input_vat_events.follows_event_id → input_vat_events.id
input_vat_events_journal_entry_id_journal_entries_id_fk: input_vat_events.journal_entry_id → journal_entries.id
input_vat_events_related_document_id_bills_id_fk: input_vat_events.related_document_id → bills.id
invoice_items_invoice_id_invoices_id_fk: invoice_items.invoice_id → invoices.id
invoice_payments_bank_account_id_bank_accounts_id_fk: invoice_payments.bank_account_id → bank_accounts.id
invoice_payments_invoice_id_invoices_id_fk: invoice_payments.invoice_id → invoices.id
invoice_prepayments_advance_invoice_id_invoices_id_fk: invoice_prepayments.advance_invoice_id → invoices.id
invoice_prepayments_allocation_id_payment_allocations_id_fk: invoice_prepayments.allocation_id → payment_allocations.id
invoice_prepayments_invoice_id_invoices_id_fk: invoice_prepayments.invoice_id → invoices.id
invoices_advance_payment_id_payments_id_fk: invoices.advance_payment_id → payments.id
invoices_bad_debt_relief_journal_entry_id_fk: invoices.bad_debt_relief_journal_entry_id → journal_entries.id
invoices_customer_id_customers_id_fk: invoices.customer_id → customers.id
invoices_issued_bank_account_id_bank_accounts_id_fk: invoices.issued_bank_account_id → bank_accounts.id
invoices_migration_open_item_id_fk: invoices.migration_open_item_id → migration_open_items.id
invoices_opening_correction_je_fk: invoices.opening_correction_journal_entry_id → journal_entries.id
invoices_original_invoice_id_fk: invoices.original_invoice_id → invoices.id
invoices_recovers_invoice_id_fk: invoices.recovers_invoice_id → invoices.id
invoices_recovery_payment_id_fk: invoices.recovery_payment_id → payments.id
invoices_replaces_invoice_fk: invoices.replaces_invoice_id → invoices.id
invoices_reversed_by_batch_fk: invoices.reversed_by_migration_batch_id → migration_batches.id
journal_entries_migration_batch_id_fk: journal_entries.migration_batch_id → migration_batches.id
journal_entry_lines_journal_entry_id_journal_entries_id_fk: journal_entry_lines.journal_entry_id → journal_entries.id
migration_advances_batch_id_migration_batches_id_fk: migration_advances.batch_id → migration_batches.id
migration_advances_resolved_payment_id_payments_id_fk: migration_advances.resolved_payment_id → payments.id
migration_assets_batch_id_fk: migration_assets.batch_id → migration_batches.id
migration_assets_batch_id_migration_batches_id_fk: migration_assets.batch_id → migration_batches.id
migration_assets_resolved_asset_id_fk: migration_assets.resolved_asset_id → fixed_assets.id
migration_batches_opening_journal_entry_id_journal_entries_id_f: migration_batches.opening_journal_entry_id → journal_entries.id
migration_batches_period_lock_id_period_locks_id_fk: migration_batches.period_lock_id → period_locks.id
migration_batches_replaces_batch_fk: migration_batches.replaces_batch_id → migration_batches.id
migration_batches_reversal_journal_entry_id_journal_entries_id_: migration_batches.reversal_journal_entry_id → journal_entries.id
migration_chart_rows_batch_id_migration_batches_id_fk: migration_chart_rows.batch_id → migration_batches.id
migration_chart_rows_resolved_category_id_categories_id_fk: migration_chart_rows.resolved_category_id → categories.id
migration_chart_rows_target_bank_account_id_bank_accounts_id_fk: migration_chart_rows.target_bank_account_id → bank_accounts.id
migration_chart_rows_target_category_id_categories_id_fk: migration_chart_rows.target_category_id → categories.id
migration_deposit_reversals_batch_id_migration_batches_id_fk: migration_deposit_reversals.batch_id → migration_batches.id
migration_deposit_reversals_payment_id_payments_id_fk: migration_deposit_reversals.payment_id → payments.id
migration_deposit_reversals_reversal_journal_entry_id_journal_e: migration_deposit_reversals.reversal_journal_entry_id → journal_entries.id
migration_open_items_batch_id_migration_batches_id_fk: migration_open_items.batch_id → migration_batches.id
migration_open_items_resolved_bill_id_bills_id_fk: migration_open_items.resolved_bill_id → bills.id
migration_open_items_resolved_invoice_id_invoices_id_fk: migration_open_items.resolved_invoice_id → invoices.id
migration_parties_batch_id_migration_batches_id_fk: migration_parties.batch_id → migration_batches.id
migration_parties_existing_customer_id_customers_id_fk: migration_parties.existing_customer_id → customers.id
migration_parties_existing_vendor_id_vendors_id_fk: migration_parties.existing_vendor_id → vendors.id
migration_parties_resolved_customer_id_customers_id_fk: migration_parties.resolved_customer_id → customers.id
migration_parties_resolved_vendor_id_vendors_id_fk: migration_parties.resolved_vendor_id → vendors.id
opening_payable_vat_declaration_evidence_capture_id_captured_do: opening_payable_vat_declaration_evidence.capture_id → captured_documents.id
opening_payable_vat_declaration_evidence_declaration_id_opening: opening_payable_vat_declaration_evidence.declaration_id → opening_payable_vat_declarations.id
opening_payable_vat_declarations_bill_id_bills_id_fk: opening_payable_vat_declarations.bill_id → bills.id
opening_payable_vat_declarations_migration_open_item_id_migrati: opening_payable_vat_declarations.migration_open_item_id → migration_open_items.id
payment_allocation_reversals_allocation_id_payment_allocations_: payment_allocation_reversals.allocation_id → payment_allocations.id
payment_allocation_reversals_journal_entry_id_journal_entries_i: payment_allocation_reversals.journal_entry_id → journal_entries.id
payment_allocations_credit_note_id_invoices_id_fk: payment_allocations.credit_note_id → invoices.id
payment_allocations_invoice_id_invoices_id_fk: payment_allocations.invoice_id → invoices.id
payment_allocations_journal_entry_id_journal_entries_id_fk: payment_allocations.journal_entry_id → journal_entries.id
payment_allocations_payment_id_payments_id_fk: payment_allocations.payment_id → payments.id
payment_classifications_journal_entry_id_fk: payment_classifications.journal_entry_id → journal_entries.id
payment_classifications_payment_id_payments_id_fk: payment_classifications.payment_id → payments.id
payments_bank_account_id_bank_accounts_id_fk: payments.bank_account_id → bank_accounts.id
payments_customer_id_customers_id_fk: payments.customer_id → customers.id
payments_journal_entry_id_journal_entries_id_fk: payments.journal_entry_id → journal_entries.id
payments_migration_advance_id_fk: payments.migration_advance_id → migration_advances.id
payments_replaces_payment_fk: payments.replaces_payment_id → payments.id
payments_source_transaction_id_transactions_id_fk: payments.source_transaction_id → transactions.id
payroll_items_employee_id_employees_id_fk: payroll_items.employee_id → employees.id
payroll_items_payroll_run_id_payroll_runs_id_fk: payroll_items.payroll_run_id → payroll_runs.id
products_category_id_categories_id_fk: products.category_id → categories.id
purchase_order_conversion_items_conversion_id_fk: purchase_order_conversion_items.conversion_id → purchase_order_conversions.id
purchase_order_conversion_items_order_item_id_fk: purchase_order_conversion_items.purchase_order_item_id → purchase_order_items.id
purchase_order_conversions_bill_id_fk: purchase_order_conversions.bill_id → bills.id
purchase_order_conversions_order_id_fk: purchase_order_conversions.purchase_order_id → purchase_orders.id
purchase_order_items_order_id_fk: purchase_order_items.purchase_order_id → purchase_orders.id
purchase_order_items_product_id_fk: purchase_order_items.product_id → products.id
purchase_orders_vendor_id_fk: purchase_orders.vendor_id → vendors.id
quotation_conversion_items_conversion_id_fk: quotation_conversion_items.conversion_id → quotation_conversions.id
quotation_conversion_items_quotation_item_id_fk: quotation_conversion_items.quotation_item_id → quotation_items.id
quotation_conversions_invoice_id_invoices_id_fk: quotation_conversions.invoice_id → invoices.id
quotation_conversions_quotation_id_quotations_id_fk: quotation_conversions.quotation_id → quotations.id
quotation_items_product_id_products_id_fk: quotation_items.product_id → products.id
quotation_items_quotation_id_quotations_id_fk: quotation_items.quotation_id → quotations.id
quotations_customer_id_customers_id_fk: quotations.customer_id → customers.id
recognition_schedule_rows_journal_entry_id_journal_entries_id_f: recognition_schedule_rows.journal_entry_id → journal_entries.id
recognition_schedule_rows_schedule_id_recognition_schedules_id_: recognition_schedule_rows.schedule_id → recognition_schedules.id
recognition_schedules_balance_account_id_categories_id_fk: recognition_schedules.balance_account_id → categories.id
recognition_schedules_expense_account_id_categories_id_fk: recognition_schedules.expense_account_id → categories.id
recognition_schedules_opening_journal_entry_id_journal_entries_: recognition_schedules.opening_journal_entry_id → journal_entries.id
recognition_schedules_vendor_id_vendors_id_fk: recognition_schedules.vendor_id → vendors.id
recurring_runs_rule_id_recurring_rules_id_fk: recurring_runs.rule_id → recurring_rules.id
scheduled_payments_bank_account_id_bank_accounts_id_fk: scheduled_payments.bank_account_id → bank_accounts.id
scheduled_payments_bill_id_bills_id_fk: scheduled_payments.bill_id → bills.id
scheduled_payments_paid_bill_payment_id_bill_payments_id_fk: scheduled_payments.paid_bill_payment_id → bill_payments.id
statement_match_reversals_match_id_statement_matches_id_fk: statement_match_reversals.match_id → statement_matches.id
statement_matches_payment_id_payments_id_fk: statement_matches.payment_id → payments.id
statement_matches_refund_id_customer_refunds_id_fk: statement_matches.refund_id → customer_refunds.id
statement_matches_transaction_id_transactions_id_fk: statement_matches.transaction_id → transactions.id
supplier_payment_allocation_reversals_allocation_id_supplier_pa: supplier_payment_allocation_reversals.allocation_id → supplier_payment_allocations.id
supplier_payment_allocation_reversals_journal_entry_id_journal_: supplier_payment_allocation_reversals.journal_entry_id → journal_entries.id
supplier_payment_allocations_bill_id_bills_id_fk: supplier_payment_allocations.bill_id → bills.id
supplier_payment_allocations_journal_entry_id_journal_entries_i: supplier_payment_allocations.journal_entry_id → journal_entries.id
supplier_payment_allocations_supplier_credit_note_id_bills_id_f: supplier_payment_allocations.supplier_credit_note_id → bills.id
supplier_payment_allocations_supplier_payment_id_supplier_payme: supplier_payment_allocations.supplier_payment_id → supplier_payments.id
supplier_payment_classifications_journal_entry_id_journal_entri: supplier_payment_classifications.journal_entry_id → journal_entries.id
supplier_payment_classifications_supplier_payment_id_supplier_p: supplier_payment_classifications.supplier_payment_id → supplier_payments.id
supplier_payments_bank_account_id_bank_accounts_id_fk: supplier_payments.bank_account_id → bank_accounts.id
supplier_payments_journal_entry_id_journal_entries_id_fk: supplier_payments.journal_entry_id → journal_entries.id
supplier_payments_vendor_id_vendors_id_fk: supplier_payments.vendor_id → vendors.id
supplier_refunds_bank_account_id_bank_accounts_id_fk: supplier_refunds.bank_account_id → bank_accounts.id
supplier_refunds_journal_entry_id_journal_entries_id_fk: supplier_refunds.journal_entry_id → journal_entries.id
supplier_refunds_supplier_payment_id_supplier_payments_id_fk: supplier_refunds.supplier_payment_id → supplier_payments.id
supplier_refunds_vendor_id_vendors_id_fk: supplier_refunds.vendor_id → vendors.id
tax_adjustments_account_id_categories_id_fk: tax_adjustments.account_id → categories.id
tax_adjustments_version_id_tax_computation_versions_id_fk: tax_adjustments.version_id → tax_computation_versions.id
tax_computation_versions_accrual_journal_entry_id_journal_entri: tax_computation_versions.accrual_journal_entry_id → journal_entries.id
tax_computation_versions_computation_id_tax_computations_id_fk: tax_computation_versions.computation_id → tax_computations.id
transactions_bank_account_id_bank_accounts_id_fk: transactions.bank_account_id → bank_accounts.id
transactions_bank_statement_id_bank_statements_id_fk: transactions.bank_statement_id → bank_statements.id
transactions_category_id_categories_id_fk: transactions.category_id → categories.id
transactions_counterparty_bank_account_id_fkey: transactions.counterparty_bank_account_id → bank_accounts.id
transactions_journal_entry_id_fkey: transactions.journal_entry_id → journal_entries.id
transactions_settles_bill_id_bills_id_fk: transactions.settles_bill_id → bills.id
transactions_settles_invoice_id_invoices_id_fk: transactions.settles_invoice_id → invoices.id
vendor_wht_treaty_reliefs_vendor_id_vendors_id_fk: vendor_wht_treaty_reliefs.vendor_id → vendors.id
wht_corrections_bill_payment_id_bill_payments_id_fk: wht_corrections.bill_payment_id → bill_payments.id
wht_corrections_corrected_bill_payment_id_bill_payments_id_fk: wht_corrections.corrected_bill_payment_id → bill_payments.id
wht_corrections_corrected_supplier_payment_id_supplier_payments: wht_corrections.corrected_supplier_payment_id → supplier_payments.id
wht_corrections_original_filing_id_wht_return_filings_id_fk: wht_corrections.original_filing_id → wht_return_filings.id
wht_corrections_reversal_journal_entry_id_journal_entries_id_fk: wht_corrections.reversal_journal_entry_id → journal_entries.id
wht_corrections_supplier_payment_id_supplier_payments_id_fk: wht_corrections.supplier_payment_id → supplier_payments.id
wht_corrections_withholding_id_wht_withholdings_id_fk: wht_corrections.withholding_id → wht_withholdings.id
wht_remittance_reversals_journal_entry_id_journal_entries_id_fk: wht_remittance_reversals.journal_entry_id → journal_entries.id
wht_remittance_reversals_remittance_id_wht_remittances_id_fk: wht_remittance_reversals.remittance_id → wht_remittances.id
wht_remittances_bank_account_id_bank_accounts_id_fk: wht_remittances.bank_account_id → bank_accounts.id
wht_remittances_journal_entry_id_journal_entries_id_fk: wht_remittances.journal_entry_id → journal_entries.id
wht_return_filings_amends_filing_id_wht_return_filings_id_fk: wht_return_filings.amends_filing_id → wht_return_filings.id
wht_withholdings_bill_id_bills_id_fk: wht_withholdings.bill_id → bills.id
wht_withholdings_bill_payment_id_bill_payments_id_fk: wht_withholdings.bill_payment_id → bill_payments.id
wht_withholdings_correction_id_wht_corrections_id_fk: wht_withholdings.correction_id → wht_corrections.id
wht_withholdings_journal_entry_id_journal_entries_id_fk: wht_withholdings.journal_entry_id → journal_entries.id
wht_withholdings_supersedes_withholding_id_wht_withholdings_id_: wht_withholdings.supersedes_withholding_id → wht_withholdings.id
wht_withholdings_supplier_payment_id_supplier_payments_id_fk: wht_withholdings.supplier_payment_id → supplier_payments.id
wht_withholdings_treaty_relief_id_vendor_wht_treaty_reliefs_id_: wht_withholdings.treaty_relief_id → vendor_wht_treaty_reliefs.id
wht_withholdings_vendor_id_vendors_id_fk: wht_withholdings.vendor_id → vendors.id
zakat_account_classifications_account_id_categories_id_fk: zakat_account_classifications.account_id → categories.id
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
    const plain = (await read()).filter((r) => !r.tenant_keyed).map((r) => `${r.conname}: ${r.edge}`);
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
