/**
 * DATABASE REFUSALS → HTTP, IN ONE PLACE.
 *
 * A trigger that refuses a write from EVERY path (a payment, a journal, an
 * import, a reversal) is a business refusal, not a server fault. It reaches the
 * HTTP layer two ways, and both must say the same thing:
 *
 *   - a BEFORE trigger throws inside the handler → `middleware/errorHandler.ts`;
 *   - a DEFERRED constraint trigger (Phase 16's `wht_payable_line_owned`) throws
 *     at COMMIT → `lib/responseCommit.ts`, which used to answer every COMMIT
 *     failure with a 500 `commit_failed` ("please try again") AND page a
 *     critical database-health alert — for a refusal no retry can ever pass.
 *
 * So the translation lives here and both call it. An EXACT allow-list: a plain
 * CHECK, a primary-key fault or an unnamed constraint is a bug, never a refusal
 * the caller is told to fix, and stays a logged 500.
 *
 * 409: a lifecycle state or a concurrent request (the row moved under it).
 * 422: the request names something it may not (another tenant's row, a wrong
 *      account, a rate the schedule does not allow).
 * The constraint name is the stable `code` the UI keys on; the database's own
 * sentence is the message.
 */

/** Phase 15 — the 0112 budget triggers. */
const BUDGET_TRIGGER_STATUS: Record<string, 409 | 422> = {
  budget_header_frozen: 409,
  budget_header_tenant: 422,
  budget_version_superseded_alone: 409,
  budget_version_tenant: 422,
  budget_version_born_draft: 409,
  budget_version_sequence: 409,
  budget_version_revision_base: 409,
  budget_version_immutable: 409,
  budget_version_identity: 409,
  budget_version_transition: 409,
  budget_line_tenant: 422,
  budget_line_locked: 409,
  budget_line_identity: 409,
  budget_line_account: 422,
  budget_line_mode: 422,
  budget_no_truncate: 409,
};
/** The 0112 unique indexes a concurrent request can collide on. */
const BUDGET_UNIQUE_MESSAGE: Record<string, string> = {
  budgets_company_year_scenario_name_unq: "A budget with this name and scenario already exists for that fiscal year.",
  budget_versions_one_open_unq: "Another version of this budget is already open — finish or reject it first.",
  budget_versions_one_approved_unq: "This budget already has an approved version.",
  budget_versions_no_unq: "Another version of this budget was created at the same moment — reload and try again.",
};

/**
 * Phase 16 + 17 — the 0113/0114/0115 triggers (QA 2026-10-04: none was mapped,
 * so a remittance race, a treaty rate above the statutory one, or a manual
 * journal line on WHT_PAYABLE answered 500). `wht_rates_*` is deliberately
 * absent: no tenant path writes the rate schedule, so reaching it is a bug.
 */
const TAX_TREASURY_TRIGGER_STATUS: Record<string, 409 | 422> = {
  // withholding tax
  wht_remittance_exceeds: 409,
  wht_remittance_tenant: 422,
  wht_remittance_reversal_tenant: 422,
  wht_append_only: 409,
  wht_withholding_tenant: 422,
  wht_withholding_payment: 422,
  wht_withholding_rate: 422,
  wht_withholding_relief: 422,
  wht_withholding_residency: 422,
  // Q2 (0116): the class of the money decides the determination
  wht_withholding_class: 422,
  wht_withholding_provenance: 422,
  wht_withholding_supersede: 409,
  wht_late_withholding: 409,
  // Q1 (0117): the return month, the filing record, the correction
  wht_month_filed: 409,
  wht_return_period: 422,
  wht_correction_link: 422,
  wht_correction_tenant: 422,
  wht_correction_source: 422,
  wht_correction_superseded: 409,
  wht_correction_entry: 422,
  wht_correction_immutable: 409,
  wht_filing_tenant: 422,
  wht_filing_amends: 409,
  wht_payable_unowned: 422,
  wht_payable_amount: 422,
  wht_relief_tenant: 422,
  wht_relief_rate: 422,
  wht_relief_no_rate: 422,
  wht_relief_not_non_resident: 422,
  wht_relief_born_pending: 409,
  wht_relief_immutable: 409,
  wht_relief_transition: 409,
  wht_relief_terms_frozen: 409,
  journal_entries_tax_reversal_guard: 409,
  journal_entry_lines_tax_guard: 422,
  tax_no_truncate: 409,
  // Zakat classification
  zakat_classification_account: 422,
  zakat_classification_type: 422,
  zakat_classification_identity: 409,
  // computations and adjustments
  tax_computation_tenant: 422,
  tax_computation_frozen: 409,
  tax_computation_version_tenant: 422,
  tax_computation_version_born_draft: 409,
  tax_computation_version_identity: 409,
  tax_computation_version_immutable: 409,
  tax_computation_version_revision_base: 409,
  tax_computation_version_sequence: 409,
  tax_computation_version_superseded_alone: 409,
  tax_computation_version_transition: 409,
  tax_adjustment_tenant: 422,
  tax_adjustment_account: 422,
  tax_adjustment_target: 422,
  tax_adjustment_identity: 409,
  tax_adjustment_locked: 409,
  // treasury
  scheduled_payment_tenant: 422,
  scheduled_payment_bill: 422,
  scheduled_payment_bill_reversed: 409,
  scheduled_payment_born_planned: 409,
  scheduled_payment_identity: 409,
  scheduled_payment_immutable: 409,
  scheduled_payment_paid_by: 409,
  scheduled_payment_transition: 409,
  treasury_forecast_entry_tenant: 422,
  treasury_forecast_entry_identity: 409,
  treasury_settings_tenant: 422,
  treasury_settings_identity: 409,
  treasury_no_truncate: 409,
  // the final audit's fixes (0119, 2026-10-05): MG-2 — a mirror is never reversed, a migration's entries belong to its
  // workspace; MG-1 — an asset out of the books (reversed with its batch, disposed, cancelled) is never depreciated
  journal_mirror_not_reversible: 409,
  journal_migration_owned: 409,
  journal_reversal_tenant: 422,
  depreciation_asset_out_of_books: 409,
};
/** The 0113/0114 unique indexes two concurrent requests can collide on. */
const TAX_TREASURY_UNIQUE_MESSAGE: Record<string, string> = {
  tax_computations_company_kind_year_unq: "A computation for that fiscal year was created at the same moment — reload and open it.",
  tax_computation_versions_one_open_unq: "Another version of this computation is already open — finish or reject it first.",
  tax_computation_versions_one_approved_unq: "This computation already has an approved version.",
  tax_computation_versions_no_unq: "Another version of this computation was created at the same moment — reload and try again.",
  wht_remittance_reversals_one_unq: "This remittance has already been reversed.",
  wht_remittances_idempotency_unq: "This remittance is already being recorded — reload to see it.",
  wht_corrections_withholding_unq: "This withholding was corrected by another request a moment ago; that correction is the record.",
  wht_corrections_idempotency_unq: "This correction is already being recorded — reload to see it.",
  wht_return_filings_one_original_unq: "This month's filing was recorded at the same moment — reload to see it.",
  // SEC-4 (0119): a ZATCA acknowledgement names ONE filing of a month — the same reference again is the same filing
  wht_return_filings_reference_unq: "That ZATCA reference is already recorded for this month's return — it is the same filing, not an amendment. Reload to see it.",
  zakat_account_classifications_account_unq: "This account was classified at the same moment — reload to see its class.",
  scheduled_payments_payment_unq: "This plan was paid at the same moment — reload to see it.",
  treasury_settings_company_unq: "The treasury settings were saved at the same moment — reload and try again.",
  // Not a Phase 16/17 index, but every system-posted entry whose number carries a clock
  // (SPAY-, BTR-, SALLOC-, RECLASS-…) can meet another request in the same millisecond:
  // nothing duplicates (the index holds), and a retry passes — a conflict, not a fault.
  journal_entries_company_number_unq: "Another entry was recorded at the same moment — reload and try again.",
};

export interface DbRefusal {
  status: 409 | 422;
  body: { code: string; error: string; constraint?: string };
}

/**
 * The HTTP answer a database refusal deserves, or null when the error is not a
 * refusal we recognise (it then stays a logged 500). Drizzle may wrap the
 * driver error in `cause`.
 */
export function translateDbRefusal(err: unknown): DbRefusal | null {
  const pg = err as { code?: string; message?: string; constraint?: string; cause?: { code?: string; message?: string; constraint?: string } };
  const pgCode = pg?.code && /^[0-9A-Z]{5}$/.test(pg.code) ? pg.code : pg?.cause?.code;
  const pgMessage = pg?.cause?.message ?? pg?.message ?? "";
  const constraint = pg?.constraint ?? pg?.cause?.constraint;

  // Phase 12C/12D: the banking triggers (keyed on their sentence — they raise no constraint name).
  if (pgCode === "23514" && /is reconciled through/.test(pgMessage)) return { status: 409, body: { code: "bank_reconciled_through", error: pgMessage } };
  if (pgCode === "23514" && /is reconciled to a bank statement line/.test(pgMessage)) return { status: 409, body: { code: "entry_reconciled", error: pgMessage } };

  if (pgCode === "23514" && constraint) {
    const status = BUDGET_TRIGGER_STATUS[constraint] ?? TAX_TREASURY_TRIGGER_STATUS[constraint];
    if (status) return { status, body: { code: constraint, error: pgMessage } };
  }
  if (pgCode === "23505" && constraint) {
    const budget = BUDGET_UNIQUE_MESSAGE[constraint];
    if (budget) return { status: 409, body: { code: "budget_conflict", constraint, error: budget } };
    const taxTreasury = TAX_TREASURY_UNIQUE_MESSAGE[constraint];
    if (taxTreasury) return { status: 409, body: { code: "concurrent_conflict", constraint, error: taxTreasury } };
  }
  return null;
}
