import { pgTable, serial, text, timestamp, integer, numeric, uuid, boolean, jsonb, date, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { journalEntriesTable } from "./journalEntries";
import { categoriesTable } from "./categories";
import { bankAccountsTable } from "./bankAccounts";
import { customersTable } from "./customers";
import { vendorsTable } from "./vendors";
import { invoicesTable } from "./invoices";
import { billsTable } from "./bills";
import { paymentsTable } from "./payments";
import { periodLocksTable } from "./periodLocks";

/**
 * BATCH 1C (2026-09-18) — MIGRATION OF AN EXISTING BUSINESS.
 *
 * Decision record: docs/product/batch-1c-migration-opening-balances-decision-pack.md
 * (§15 — the accountant's decisions A1/A2/A3, the ZATCA boundary, the
 * chart-mapping design, the reconciliation gates R1–R10).
 *
 * One BATCH per migration attempt; the batch owns STAGING rows (chart rows
 * with their opening balances, parties, open AR/AP items, customer advances)
 * that are validated as a set and committed as ONE transaction: parties and
 * categories created, `opening` invoices/bills and deposit payments inserted,
 * ONE opening journal posted through `postJournalEntry` (source = 'opening',
 * dated cutover − 1), the reconciliation stored, the opening month locked.
 * 🔴 The opening journal balances on NAMED accounts or the commit is refused:
 * there is no opening-balance-equity account and no declared residual
 * (accountant A5, 2026-09-20; decision pack §16.12.2).
 *
 * Identity is deterministic: `(company_id, source_system, source_id)` on every
 * staged row, enforced by unique indexes — a re-import of the same source row
 * is refused or replays idempotently; nothing is ever identified by amount,
 * date or name. A committed batch is immutable (DB trigger, migration 0077;
 * strict again since 0081 — no unlink exception); corrections after commit
 * are new accounting events (reversal / dated journals), never edits.
 *
 * 🔴 POLICY C (accountant A4, 2026-09-20; decision pack §16.12.1). A reversal
 * mirrors the opening journal and MARKS the opening invoices, bills and
 * deposits reversed — nothing the commit wrote is ever deleted, and the
 * staging rows keep pointing at the reversed rows. A corrected re-run is a
 * REPLACEMENT batch (`replaces_batch_id`, set automatically at creation when
 * the company's most recent batch is reversed): its opening items receive NEW
 * Saudi Ledger numbers `OPEN-<batch>-<seq>` (the prefix is reserved), each
 * pointing back at the reversed row it replaces; the previous system's
 * number stays verbatim in `document_number` as provenance, and
 * `ledger_document_number` records what the ledger row was actually called.
 */

const orgCol = () =>
  uuid("organization_id")
    .notNull()
    .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
    .references(() => organizationsTable.id);
const companyCol = () =>
  uuid("company_id")
    .notNull()
    .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
    .references(() => companiesTable.id);

export const MIGRATION_BATCH_STATUSES = ["draft", "validated", "committed", "reversed", "discarded"] as const;
export type MigrationBatchStatus = (typeof MIGRATION_BATCH_STATUSES)[number];

export const migrationBatchesTable = pgTable(
  "migration_batches",
  {
    id: serial("id").primaryKey(),
    organizationId: orgCol(),
    companyId: companyCol(),
    /** draft → validated → committed (→ reversed); draft → discarded. */
    status: text("status").notNull().default("draft"),
    /** The previous system, as the operator names it ("PreviousERP", "Excel", "Qoyod export"…). */
    sourceSystem: text("source_system").notNull(),
    sourceVersion: text("source_version"),
    /** The first business day in Saudi Ledger. */
    cutoverDate: date("cutover_date").notNull(),
    /** cutover − 1: the previous system's closing position IS this day's closing position. */
    openingDate: date("opening_date").notNull(),
    notes: text("notes"),
    /** Client idempotency key for the commit; the same key returns the same batch. */
    idempotencyKey: text("idempotency_key"),
    /** SHA-256 over the canonical staged content at validation; commit refuses if it moved. */
    contentHash: text("content_hash"),
    /**
     * Phase 2 — the last filed VAT return's closing position, as supplied by
     * the operator with the return's reference (R9): { returnReference,
     * periodStart, periodEnd, outputVatPayable, inputVatReceivable, netPayable }.
     * Required whenever a chart row with a balance maps to VAT_OUTPUT / VAT_INPUT.
     */
    vatPosition: jsonb("vat_position"),
    /**
     * Policy C: the reversed batch this one replaces (same company; set at
     * creation when the company's most recent batch is `reversed`). Decides the
     * numbering of the opening items (`OPEN-<batch>-<seq>`) and the
     * `replaces_*` provenance written at commit. NULL = a first migration.
     */
    replacesBatchId: integer("replaces_batch_id"),
    /** The last validation run: { ok, checks: [...], totals: {...}, at } */
    validation: jsonb("validation"),
    /** R1–R10 as computed at commit (and re-computed after posting). */
    reconciliation: jsonb("reconciliation"),
    openingJournalEntryId: integer("opening_journal_entry_id").references(() => journalEntriesTable.id),
    reversalJournalEntryId: integer("reversal_journal_entry_id").references(() => journalEntriesTable.id),
    periodLockId: integer("period_lock_id").references(() => periodLocksTable.id, { onDelete: "set null" }),
    createdBy: integer("created_by"),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    committedBy: integer("committed_by"),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    reversedBy: integer("reversed_by"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversalReason: text("reversal_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("migration_batches_company_idx").on(t.companyId),
    // One LIVE (committed, not reversed) migration per company.
    uniqueIndex("migration_batches_company_committed_unq").on(t.companyId).where(sql`status = 'committed'`),
    uniqueIndex("migration_batches_idempotency_unq").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
    check("migration_batches_status_chk", sql`status IN ('draft', 'validated', 'committed', 'reversed', 'discarded')`),
    // The opening date is DEFINED, not chosen: the day before cutover (pack §5, §15.5).
    check("migration_batches_opening_date_chk", sql`opening_date = cutover_date - INTERVAL '1 day'`),
  ],
);

export const MIGRATION_CHART_DECISIONS = ["map_to_system", "map_to_bank", "create", "merge_into", "skip"] as const;
export type MigrationChartDecision = (typeof MIGRATION_CHART_DECISIONS)[number];

/**
 * One row per account of the OLD chart, carrying its opening balance (the
 * previous system's closing trial balance line) and the operator's mapping
 * decision. The old code, name, type, parent and balances are preserved here
 * verbatim; the decision says where the balance lands in Saudi Ledger.
 */
export const migrationChartRowsTable = pgTable(
  "migration_chart_rows",
  {
    id: serial("id").primaryKey(),
    organizationId: orgCol(),
    companyId: companyCol(),
    batchId: integer("batch_id")
      .notNull()
      .references(() => migrationBatchesTable.id, { onDelete: "cascade" }),
    sourceSystem: text("source_system").notNull(),
    sourceCode: text("source_code").notNull(),
    sourceName: text("source_name").notNull(),
    sourceNameAr: text("source_name_ar"),
    sourceParentCode: text("source_parent_code"),
    /** asset | liability | equity | income | expense — as classified from the file; anything else is refused at import. */
    sourceType: text("source_type").notNull(),
    sourceIsGroup: boolean("source_is_group").notNull().default(false),
    sourceCurrency: text("source_currency").notNull().default("SAR"),
    /** The old system's closing balance for this account, split Dr/Cr as the file states it. */
    openingDebit: numeric("opening_debit", { precision: 15, scale: 2 }).notNull().default("0"),
    openingCredit: numeric("opening_credit", { precision: 15, scale: 2 }).notNull().default("0"),
    /** Role hints the file may carry: receivable | payable | bank | cash | vat_output | vat_input | retained_earnings | null. */
    sourceRole: text("source_role"),
    /** Evidence reference for the balance (statement page, TB export line…). */
    evidenceNote: text("evidence_note"),
    decision: text("decision"),
    /** map_to_system → a SYSTEM_ACCOUNTS code (never CASH, a header). */
    targetSystemCode: text("target_system_code"),
    /** map_to_bank → the bank whose D-3 leaf takes the balance. */
    targetBankAccountId: integer("target_bank_account_id").references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    /** merge_into → an existing non-system category; create → filled with the created category at commit. */
    targetCategoryId: integer("target_category_id").references(() => categoriesTable.id, { onDelete: "restrict" }),
    skipReason: text("skip_reason"),
    decidedBy: integer("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** After commit: the category the balance was posted to (leaf, system account, created or merged). */
    resolvedCategoryId: integer("resolved_category_id").references(() => categoriesTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("migration_chart_rows_batch_code_unq").on(t.batchId, t.sourceCode),
    index("migration_chart_rows_batch_idx").on(t.batchId),
    check("migration_chart_rows_type_chk", sql`source_type IN ('asset', 'liability', 'equity', 'income', 'expense')`),
    check("migration_chart_rows_decision_chk", sql`decision IS NULL OR decision IN ('map_to_system', 'map_to_bank', 'create', 'merge_into', 'skip')`),
    check("migration_chart_rows_amounts_chk", sql`opening_debit >= 0 AND opening_credit >= 0`),
    check("migration_chart_rows_currency_chk", sql`source_currency = 'SAR'`),
  ],
);

export const migrationPartiesTable = pgTable(
  "migration_parties",
  {
    id: serial("id").primaryKey(),
    organizationId: orgCol(),
    companyId: companyCol(),
    batchId: integer("batch_id")
      .notNull()
      .references(() => migrationBatchesTable.id, { onDelete: "cascade" }),
    sourceSystem: text("source_system").notNull(),
    partyType: text("party_type").notNull(), // customer | vendor
    sourceId: text("source_id").notNull(),
    name: text("name").notNull(),
    nameAr: text("name_ar"),
    taxNumber: text("tax_number"),
    crNumber: text("cr_number"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    city: text("city"),
    /**
     * create | use_existing — NULL while undecided. Import sets `create` when no
     * existing customer/vendor looks like this party; a likely duplicate (same
     * VAT number, or the same name) leaves it NULL and blocks until the operator
     * decides. `use_existing` names the existing record.
     */
    decision: text("decision"),
    decidedBy: integer("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    existingCustomerId: integer("existing_customer_id").references(() => customersTable.id, { onDelete: "restrict" }),
    existingVendorId: integer("existing_vendor_id").references(() => vendorsTable.id, { onDelete: "restrict" }),
    resolvedCustomerId: integer("resolved_customer_id").references(() => customersTable.id, { onDelete: "restrict" }),
    resolvedVendorId: integer("resolved_vendor_id").references(() => vendorsTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // 🔴 THE IDENTITY: (company, source system, party type, source id). Unique
    // within a batch; across batches the one-committed-batch-per-company rule
    // (migration_batches_company_committed_unq) is what keeps one source row
    // from producing two accounting events — a discarded or reversed batch has
    // no live effect, and a re-run after reversal imports the same ids again.
    uniqueIndex("migration_parties_identity_unq").on(t.batchId, t.partyType, t.sourceId),
    index("migration_parties_batch_idx").on(t.batchId),
    check("migration_parties_type_chk", sql`party_type IN ('customer', 'vendor')`),
    check("migration_parties_decision_chk", sql`decision IN ('create', 'use_existing')`),
  ],
);

/**
 * One row per OPEN document of the previous system — receivable (ar) or
 * payable (ap). Original number, dates and amounts are kept verbatim; the
 * outstanding amount at cut-off is what the opening journal posts (with the
 * party) and what the `opening` invoice/bill row carries as its total.
 * `composition_unknown` marks the one-item representation of a party whose
 * old system tracked only a balance (pack §13.2).
 */
export const migrationOpenItemsTable = pgTable(
  "migration_open_items",
  {
    id: serial("id").primaryKey(),
    organizationId: orgCol(),
    companyId: companyCol(),
    batchId: integer("batch_id")
      .notNull()
      .references(() => migrationBatchesTable.id, { onDelete: "cascade" }),
    sourceSystem: text("source_system").notNull(),
    sourceId: text("source_id").notNull(),
    itemType: text("item_type").notNull(), // ar | ap
    /** The party's source id (→ migration_parties of the same batch). */
    partySourceId: text("party_source_id").notNull(),
    documentNumber: text("document_number").notNull(),
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),
    originalAmount: numeric("original_amount", { precision: 15, scale: 2 }).notNull(),
    outstandingAmount: numeric("outstanding_amount", { precision: 15, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("SAR"),
    compositionUnknown: boolean("composition_unknown").notNull().default(false),
    /** { rate, amount, taxableAmount, category, reportedPeriod } — kept for reconciliation and the future Art. 40(10) engine; never posted. */
    historicalVat: jsonb("historical_vat"),
    /**
     * 2026-09-22 (migration follow-ups; accountant answer 3): the original
     * document's E-INVOICING IDENTITY, for the day a credit note must name it
     * through Fatoora. `einvoicingStatus`: `cleared` (a standard tax invoice the
     * previous solution cleared), `reported` (a simplified one it reported),
     * `pre_einvoicing` (issued before the e-invoicing obligation applied to
     * the taxpayer) — or NULL: NOT STATED, which is not a guess and gates the
     * note. `sourceUuid`: the previous solution's document UUID, verbatim,
     * required for `cleared`/`reported`; never invented. AR items only.
     */
    sourceUuid: text("source_uuid"),
    einvoicingStatus: text("einvoicing_status"),
    description: text("description"),
    /**
     * Policy C: what the ledger row was actually CALLED — the source number
     * for a first migration, `OPEN-<batch>-<seq>` for a replacement. Written at
     * commit. `document_number` above stays the previous system's number,
     * verbatim, whatever the ledger row is called (provenance, A4).
     */
    ledgerDocumentNumber: text("ledger_document_number"),
    resolvedInvoiceId: integer("resolved_invoice_id").references(() => invoicesTable.id, { onDelete: "restrict" }),
    resolvedBillId: integer("resolved_bill_id").references(() => billsTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("migration_open_items_identity_unq").on(t.batchId, t.sourceId),
    index("migration_open_items_batch_idx").on(t.batchId),
    check("migration_open_items_type_chk", sql`item_type IN ('ar', 'ap')`),
    check("migration_open_items_amounts_chk", sql`outstanding_amount > 0 AND original_amount >= outstanding_amount`),
    check("migration_open_items_currency_chk", sql`currency = 'SAR'`),
    check("migration_open_items_einvoicing_status_chk", sql`einvoicing_status IS NULL OR einvoicing_status IN ('cleared', 'reported', 'pre_einvoicing')`),
    // identity is a fact about a tax invoice the previous solution issued: AR only; cleared/reported carry the UUID
    check("migration_open_items_identity_ar_only_chk", sql`item_type = 'ar' OR (source_uuid IS NULL AND einvoicing_status IS NULL)`),
    check("migration_open_items_identity_uuid_chk", sql`einvoicing_status IS NULL OR einvoicing_status = 'pre_einvoicing' OR source_uuid IS NOT NULL`),
  ],
);

/**
 * A customer advance held at cut-off: becomes a `payments` row (source =
 * 'opening', direction in, no allocation) whose deposit line is in the
 * opening journal; its cash is INSIDE the bank's opening balance, so it posts
 * no cash line of its own. The old advance tax invoice's identifiers and VAT
 * position travel with it so a later invoice can reference them (Guideline
 * §8); `vat_position = unknown` fails closed downstream.
 */
export const migrationAdvancesTable = pgTable(
  "migration_advances",
  {
    id: serial("id").primaryKey(),
    organizationId: orgCol(),
    companyId: companyCol(),
    batchId: integer("batch_id")
      .notNull()
      .references(() => migrationBatchesTable.id, { onDelete: "cascade" }),
    sourceSystem: text("source_system").notNull(),
    sourceId: text("source_id").notNull(),
    partySourceId: text("party_source_id").notNull(),
    /** The old chart's bank account code the money arrived in (→ a chart row mapped to a bank). */
    bankSourceCode: text("bank_source_code").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    receivedAt: date("received_at").notNull(),
    reference: text("reference"),
    /** invoiced (the old system issued the advance tax invoice) | unknown. */
    vatPosition: text("vat_position").notNull(),
    advanceInvoiceNumber: text("advance_invoice_number"),
    advanceInvoiceDate: date("advance_invoice_date"),
    advanceInvoiceTime: text("advance_invoice_time"),
    vatCategory: text("vat_category"),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }),
    resolvedPaymentId: integer("resolved_payment_id").references(() => paymentsTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("migration_advances_identity_unq").on(t.batchId, t.sourceId),
    index("migration_advances_batch_idx").on(t.batchId),
    check("migration_advances_amount_chk", sql`amount > 0`),
    check("migration_advances_vat_position_chk", sql`vat_position IN ('invoiced', 'unknown')`),
    check("migration_advances_invoiced_chk", sql`vat_position <> 'invoiced' OR advance_invoice_number IS NOT NULL`),
  ],
);

/**
 * Policy C — the SUPERSEDING RECORD that reverses a migrated deposit. Payments
 * are append-only (UPDATE and DELETE revoked), so the reversal of a
 * `source = 'opening'` payment is a row here, never a change to the payment:
 * one per payment, written by the migration's reversal inside its
 * transaction, carrying the batch and the mirror journal. Readers that
 * compute a deposit position exclude a payment with a row here through the
 * one predicate (apps/api `repositories/openingReversal.ts`).
 */
export const migrationDepositReversalsTable = pgTable(
  "migration_deposit_reversals",
  {
    id: serial("id").primaryKey(),
    organizationId: orgCol(),
    companyId: companyCol(),
    paymentId: integer("payment_id").notNull().references(() => paymentsTable.id, { onDelete: "restrict" }),
    batchId: integer("batch_id").notNull().references(() => migrationBatchesTable.id, { onDelete: "restrict" }),
    reversalJournalEntryId: integer("reversal_journal_entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("migration_deposit_reversals_payment_unq").on(t.paymentId),
    index("migration_deposit_reversals_batch_idx").on(t.batchId),
  ],
);

export type MigrationDepositReversal = typeof migrationDepositReversalsTable.$inferSelect;
export type MigrationBatch = typeof migrationBatchesTable.$inferSelect;
export type MigrationChartRow = typeof migrationChartRowsTable.$inferSelect;
export type MigrationParty = typeof migrationPartiesTable.$inferSelect;
export type MigrationOpenItem = typeof migrationOpenItemsTable.$inferSelect;
export type MigrationAdvance = typeof migrationAdvancesTable.$inferSelect;

/**
 * Batch 1C + FA-D (2026-09-22): the FIXED ASSETS the previous system held at
 * cut-off. Record: fixed-assets-decision-pack.md §10, §23.
 *
 * What a migrated asset IS: the register's facts of an asset already in
 * service — its original cost, the accumulated depreciation the previous
 * system booked, how many periods that was, and the Saudi classifications
 * every asset carries (the Income Tax Law Art. 17 group and the VAT Art. 52
 * class, which come from the asset CATEGORY it lands in).
 *
 * 🔴 It creates NO journal line of its own. The cost and the accumulated
 * depreciation are already in the staged trial balance (A5: one balanced
 * opening position, no plug), so the register must RECONCILE to those mapped
 * balances — a control, exactly as open items reconcile to AR/AP. The
 * register rows are created at commit and carry the opening journal as their
 * capitalisation entry; their schedule resumes the month AFTER the opening
 * date.
 */
export const migrationAssetsTable = pgTable(
  "migration_assets",
  {
    id: serial("id").primaryKey(),
    organizationId: orgCol(),
    companyId: companyCol(),
    batchId: integer("batch_id")
      .notNull()
      .references(() => migrationBatchesTable.id, { onDelete: "cascade" }),
    sourceSystem: text("source_system").notNull(),
    sourceId: text("source_id").notNull(),
    name: text("name").notNull(),
    nameAr: text("name_ar"),
    serialNumber: text("serial_number"),
    /** The asset CATEGORY this asset lands in, by NAME — resolved at validation against the company's own categories (it carries the accounts, the Art. 17 group and the Art. 52 class). */
    categoryName: text("category_name").notNull(),
    acquisitionDate: date("acquisition_date").notNull(),
    availableForUseDate: date("available_for_use_date").notNull(),
    cost: numeric("cost", { precision: 15, scale: 2 }).notNull(),
    residualValue: numeric("residual_value", { precision: 15, scale: 2 }).notNull().default("0"),
    usefulLifeMonths: integer("useful_life_months").notNull(),
    depreciationMethod: text("depreciation_method").notNull().default("straight_line"),
    /** What the previous system had already depreciated at the opening date, and over how many periods. */
    openingAccumulatedDepreciation: numeric("opening_accumulated_depreciation", { precision: 15, scale: 2 }).notNull(),
    openingPeriodsBooked: integer("opening_periods_booked").notNull(),
    /** VAT IR Art. 52: REQUIRED while the asset is still inside its adjustment period (the validator says so); optional for an older one. */
    vatInputTaxAmount: numeric("vat_input_tax_amount", { precision: 15, scale: 2 }),
    vatInitialRecoveryPct: numeric("vat_initial_recovery_pct", { precision: 5, scale: 2 }),
    vatNonDeductibleReason: text("vat_non_deductible_reason"),
    location: text("location"),
    description: text("description"),
    resolvedAssetId: integer("resolved_asset_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("migration_assets_identity_unq").on(t.batchId, t.sourceId),
    index("migration_assets_batch_idx").on(t.batchId),
    check("migration_assets_money_chk", sql`cost >= 0 AND residual_value >= 0 AND residual_value <= cost AND opening_accumulated_depreciation >= 0 AND opening_accumulated_depreciation <= cost - residual_value`),
    check("migration_assets_life_chk", sql`useful_life_months > 0 AND opening_periods_booked >= 0 AND opening_periods_booked <= useful_life_months`),
    check("migration_assets_method_chk", sql`depreciation_method IN ('straight_line', 'declining_balance', 'units_of_production')`),
    check("migration_assets_dates_chk", sql`available_for_use_date >= acquisition_date`),
    check("migration_assets_vat_chk", sql`(vat_input_tax_amount IS NULL OR vat_input_tax_amount >= 0) AND (vat_initial_recovery_pct IS NULL OR vat_initial_recovery_pct BETWEEN 0 AND 100)`),
  ],
);

export type MigrationAsset = typeof migrationAssetsTable.$inferSelect;
