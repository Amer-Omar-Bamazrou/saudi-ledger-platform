/**
 * FIXED ASSETS — the register (FA-A foundation, 2026-09-22).
 *
 * Decision record: docs/product/fixed-assets-decision-pack.md §3, §6, §8, §13.
 *
 * What this replaces: the pre-FA register stored `accumulated_depreciation`
 * and `current_book_value` ON the asset beside the rows that produced them —
 * two value spaces with no forcing function — and its depreciation never
 * touched the GL. Here the register holds FACTS (cost, residual, life, method,
 * the opening position of a migrated asset, the VAT and income-tax facts the
 * Saudi texts require) and the SCHEDULE holds every period once; accumulated
 * depreciation and the carrying amount are DERIVED from the posted schedule
 * rows, which are the same rows that posted the GL entries. There is nothing
 * to drift.
 *
 * Two bases, one register (pack §8): the BOOK basis (IFRS, the Zakat basis by
 * Art. 48/63(2)) lives on the asset and its schedule; the INCOME-TAX basis
 * (Income Tax Law Art. 17 — pooled declining balance by group) is a report
 * over the register and needs only the GROUP on every asset, captured from
 * the category at creation and frozen at capitalisation. The VAT capital-asset
 * facts (IR Art. 52: the adjustment clock, the input tax deducted, the
 * recovery %, the class) are stored from day one; the annual adjustment is a
 * later engine over them.
 *
 * Every table is tenant-scoped (organization_id + company_id, RLS
 * tenant_isolation with the N1 company arm) and none is ever hard-deleted
 * once an asset has entered the books (Art. 66 retention).
 */
import { pgTable, serial, text, timestamp, integer, numeric, uuid, index, jsonb, date, unique, boolean, smallint } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { categoriesTable } from "./categories";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { journalEntriesTable } from "./journalEntries";
import { usersTable } from "./users";

const tenantColumns = {
  organizationId: uuid("organization_id")
    .notNull()
    .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
    .references(() => organizationsTable.id),
  companyId: uuid("company_id")
    .notNull()
    .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
    .references(() => companiesTable.id),
};

export const DEPRECIATION_METHODS = ["straight_line", "declining_balance", "units_of_production"] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];
export const ASSET_STATUSES = ["draft", "in_service", "disposed", "cancelled"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ASSET_SOURCES = ["manual", "bill", "transaction", "migration"] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];
export const VAT_CAPITAL_ASSET_CLASSES = ["movable", "immovable", "not_capital"] as const;
export type VatCapitalAssetClass = (typeof VAT_CAPITAL_ASSET_CLASSES)[number];
export const ASSET_EVENT_KINDS = [
  "created", "updated", "capitalised", "addition", "depreciated", "estimate_changed", "transferred", "disposed", "reversed", "vat_use_recorded", "vat_adjusted", "cancelled",
] as const;
export type AssetEventKind = (typeof ASSET_EVENT_KINDS)[number];

/**
 * A category binds an asset to exactly one account triple (cost / accumulated
 * depreciation / depreciation expense — ERPNext's Asset Category Account,
 * Odoo's account.asset.category) and carries the two Saudi classifications
 * every asset inherits: the Income Tax Law Art. 17(b) GROUP (1–5, the rate
 * follows from it) and the VAT IR Art. 52(2) CLASS (movable 6 y / immovable
 * 10 y / not a capital asset).
 */
export const assetCategoriesTable = pgTable(
  "asset_categories",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    name: text("name").notNull(),
    nameAr: text("name_ar"),
    costAccountId: integer("cost_account_id").notNull().references(() => categoriesTable.id, { onDelete: "restrict" }),
    accumulatedDepreciationAccountId: integer("accumulated_depreciation_account_id").notNull().references(() => categoriesTable.id, { onDelete: "restrict" }),
    depreciationExpenseAccountId: integer("depreciation_expense_account_id").notNull().references(() => categoriesTable.id, { onDelete: "restrict" }),
    defaultUsefulLifeMonths: integer("default_useful_life_months").notNull(),
    defaultMethod: text("default_method").notNull().default("straight_line"),
    defaultResidualPct: numeric("default_residual_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    /** Income Tax Law Art. 17(b): 1 buildings 5% · 2 movable industrial/agricultural buildings 10% · 3 factories, machines, equipment, vehicles, hardware & software 25% · 4 geological surveying 20% · 5 all other 10%. */
    incomeTaxGroup: smallint("income_tax_group").notNull(),
    vatCapitalAssetClass: text("vat_capital_asset_class").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("asset_categories_org_idx").on(t.organizationId, t.companyId),
    unique("asset_categories_company_name_unq").on(t.companyId, t.name),
  ],
);

export const fixedAssetsTable = pgTable(
  "fixed_assets",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    assetNumber: text("asset_number").notNull(),
    name: text("name").notNull(),
    nameAr: text("name_ar"),
    description: text("description"),
    serialNumber: text("serial_number"),
    categoryId: integer("category_id").notNull().references(() => assetCategoriesTable.id, { onDelete: "restrict" }),
    location: text("location"),
    department: text("department"),
    custodianUserId: integer("custodian_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    // ── dates ──
    /** The VAT Art. 52 adjustment clock (52(2), (5)) and the Art. 17 half-year convention both key on it. */
    acquisitionDate: date("acquisition_date", { mode: "string" }).notNull(),
    /** IAS 16.55 — depreciation begins here; mandatory at capitalisation, may differ from the purchase date. */
    availableForUseDate: date("available_for_use_date", { mode: "string" }),
    disposalDate: date("disposal_date", { mode: "string" }),
    // ── the book basis ──
    cost: numeric("cost", { precision: 15, scale: 2 }).notNull(),
    residualValue: numeric("residual_value", { precision: 15, scale: 2 }).notNull().default("0"),
    usefulLifeMonths: integer("useful_life_months").notNull(),
    depreciationMethod: text("depreciation_method").notNull().default("straight_line"),
    /** A migrated asset (pack §10): accumulated depreciation at the opening date, and the periods the previous system booked — the schedule continues from there. */
    openingAccumulatedDepreciation: numeric("opening_accumulated_depreciation", { precision: 15, scale: 2 }).notNull().default("0"),
    openingPeriodsBooked: integer("opening_periods_booked").notNull().default(0),
    // ── VAT IR Art. 52 facts (stored from day one; pack §7) ──
    vatInputTaxAmount: numeric("vat_input_tax_amount", { precision: 15, scale: 2 }).notNull().default("0"),
    vatInitialRecoveryPct: numeric("vat_initial_recovery_pct", { precision: 5, scale: 2 }).notNull().default("100"),
    vatCapitalAssetClass: text("vat_capital_asset_class").notNull(),
    vatNonDeductibleReason: text("vat_non_deductible_reason"),
    // ── income tax (Art. 17(b)) — copied from the category at creation; frozen at capitalisation ──
    incomeTaxGroup: smallint("income_tax_group").notNull(),
    // ── provenance ──
    source: text("source").notNull().default("manual"),
    billId: integer("bill_id"),
    transactionId: integer("transaction_id"),
    migrationBatchId: integer("migration_batch_id"),
    sourceReference: text("source_reference"),
    // ── state ──
    status: text("status").notNull().default("draft"),
    capitalisationJournalEntryId: integer("capitalisation_journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("fixed_assets_org_idx").on(t.organizationId, t.companyId),
    index("fixed_assets_category_idx").on(t.categoryId),
    unique("fixed_assets_company_number_unq").on(t.companyId, t.assetNumber),
  ],
);

/**
 * One row per asset per period, generated at capitalisation and posted once:
 * `journal_entry_id` NULL = planned, set = posted (and then FROZEN by
 * trigger). `unique(asset_id, period)` is what makes "a period is depreciated
 * once" a property of the table, not of the caller.
 */
export const assetDepreciationScheduleTable = pgTable(
  "asset_depreciation_schedule",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    assetId: integer("asset_id").notNull().references(() => fixedAssetsTable.id, { onDelete: "restrict" }),
    /** YYYY-MM */
    period: text("period").notNull(),
    sequence: integer("sequence").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    accumulatedAfter: numeric("accumulated_after", { precision: 15, scale: 2 }).notNull(),
    carryingAfter: numeric("carrying_after", { precision: 15, scale: 2 }).notNull(),
    journalEntryId: integer("journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("asset_depreciation_schedule_asset_idx").on(t.assetId, t.sequence),
    unique("asset_depreciation_schedule_asset_period_unq").on(t.assetId, t.period),
  ],
);

/** The audit spine of the register (pack §17) — append-only, beside `audit_logs`. */
export const assetEventsTable = pgTable(
  "asset_events",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    assetId: integer("asset_id").notNull().references(() => fixedAssetsTable.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    journalEntryId: integer("journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    documentRef: text("document_ref"),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("asset_events_asset_idx").on(t.assetId, t.id)],
);

/**
 * FA-C: the derecognition (IAS 16.67–71). One row per asset — a disposal is
 * terminal and is corrected by REVERSAL and a new act, never edited.
 *
 * `kind` separates the VAT consequences the Saudi text gives them: a SALE is
 * a taxable supply (its own tax invoice, Art. 3(5)) unless the asset was a
 * restricted motor vehicle bought without deduction, whose sale is outside
 * the economic activity (Art. 50(3)); `scrapped | destroyed | stolen` attract
 * NO Art. 52(7) adjustment (52(7) says so in terms); `withdrawn` while the
 * asset is still usable is a NOMINAL SUPPLY valued by the Art. 52(8) formula
 * — the value is computed and STORED here, and whether v1 declares it is the
 * FA-2 engine's business (pack §7, §9).
 */
export const ASSET_DISPOSAL_KINDS = ["sold", "scrapped", "destroyed", "stolen", "withdrawn"] as const;
export type AssetDisposalKind = (typeof ASSET_DISPOSAL_KINDS)[number];
export const ASSET_DISPOSAL_VAT_TREATMENTS = ["taxable_supply", "out_of_scope_restricted_vehicle", "no_adjustment", "nominal_supply"] as const;
export type AssetDisposalVatTreatment = (typeof ASSET_DISPOSAL_VAT_TREATMENTS)[number];

export const assetDisposalsTable = pgTable(
  "asset_disposals",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    assetId: integer("asset_id").notNull().references(() => fixedAssetsTable.id, { onDelete: "restrict" }),
    date: date("date", { mode: "string" }).notNull(),
    kind: text("kind").notNull(),
    proceeds: numeric("proceeds", { precision: 15, scale: 2 }).notNull().default("0"),
    /** The tax invoice that sold it (a sale is an ordinary invoice of this product). */
    invoiceId: integer("invoice_id"),
    accumulatedAtDisposal: numeric("accumulated_at_disposal", { precision: 15, scale: 2 }).notNull(),
    carryingAmountAtDisposal: numeric("carrying_amount_at_disposal", { precision: 15, scale: 2 }).notNull(),
    /** proceeds − carrying amount (IAS 16.71): positive is a gain, negative a loss. */
    gainLoss: numeric("gain_loss", { precision: 15, scale: 2 }).notNull(),
    vatTreatment: text("vat_treatment").notNull(),
    /** VAT IR Art. 52(8): purchase value × initial recovery % × remaining useful life ÷ adjustment period. */
    nominalSupplyValue: numeric("nominal_supply_value", { precision: 15, scale: 2 }),
    reason: text("reason"),
    journalEntryId: integer("journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("asset_disposals_asset_unq").on(t.assetId)],
);

/**
 * FA-E (2026-09-22) — the Income Tax Law Art. 17 POOL, and the ONE thing about
 * it the platform cannot derive.
 *
 * The pool is a report, not a ledger: for each Art. 17(b) group and each tax
 * year it is the previous year's closing balance, plus 50 % of the cost base
 * of assets IN USE added in this year and the previous one, less 50 % of the
 * compensation for assets disposed of in those two years — every figure of
 * which the register already holds. Nothing about it is stored, for the same
 * reason the VAT return is not stored: a second value space beside the rows
 * that produce it drifts.
 *
 * Two inputs are NOT in the register, and this table is where the taxpayer
 * states them. Neither is ever assumed:
 *
 *  1. 🔴 THE OPENING ANCHOR. A chain has to start. The balance of a group at
 *     the end of a year already FILED is a fact of the taxpayer's own return
 *     (Art. 81(a) for assets predating the Law), and no book register can
 *     produce it — a pool balance is a declining-balance figure, not a
 *     carrying amount. Without an anchor the report says NOT DECLARED and
 *     computes nothing; a company with no pool history declares a nil anchor,
 *     which is an ACT, not a default. The anchor also carries its own year's
 *     additions and disposals, because Art. 17(e)'s 50 % reaches back one
 *     year — and the derivation then starts strictly AFTER the anchor year, so
 *     the same addition can never be counted twice.
 *
 *  2. 🔴 ART. 18 REPAIRS. Repair and improvement expenditure is deductible up
 *     to 4 % of the group's year-end balance and the excess is ADDED to the
 *     pool (Art. 18(a)–(c)). The platform has no way to attribute repair
 *     expense to an Art. 17 group — it is ordinary expense in the GL, not an
 *     asset — so the taxpayer declares the year's figure per group and the
 *     engine does the Art. 18 arithmetic. Undeclared reads UNDECLARED on the
 *     report, never zero.
 *
 * The two ELECTIONS live here too. Art. 17(h) ("the amount of the balance MAY
 * be deducted" when it falls below SAR 1,000 after the year's deduction) and
 * Art. 17(i) ("where all the assets in a group are disposed of, the balance
 * MAY be deducted") are permissive, so the platform computes what is available
 * and does not take it: an election changes the balance carried into the next
 * year, and choosing on the taxpayer's behalf would silently rewrite every
 * later year of the chain.
 */
export const assetTaxPoolDeclarationsTable = pgTable(
  "asset_tax_pool_declarations",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    /** Art. 17(b) group 1–5. */
    incomeTaxGroup: smallint("income_tax_group").notNull(),
    /** The fiscal year LABEL as `lib/fiscalYear.ts` names it — the company's own calendar (Art. 22(a)–(b)). */
    taxYear: integer("tax_year").notNull(),
    /** The ANCHOR: the group balance at the END of this year, after that year's deduction, as filed. NULL on a row that only carries repairs or an election. */
    closingBalanceDeclared: numeric("closing_balance_declared", { precision: 15, scale: 2 }),
    /** The anchor year's own additions and disposals — Art. 17(e) needs the previous year's halves. */
    additionsDeclared: numeric("additions_declared", { precision: 15, scale: 2 }),
    disposalsDeclared: numeric("disposals_declared", { precision: 15, scale: 2 }),
    /** Art. 18(a): the year's TOTAL repair and improvement expenditure for the group. The 4 % cap and the excess are computed, never declared. */
    repairsDeclared: numeric("repairs_declared", { precision: 15, scale: 2 }),
    /** Art. 17(h) — elective. */
    electSmallBalanceWriteOff: boolean("elect_small_balance_write_off").notNull().default(false),
    /** Art. 17(i) — elective, and only available when every asset of the group has been disposed of. */
    electGroupClosedWriteOff: boolean("elect_group_closed_write_off").notNull().default(false),
    note: text("note"),
    declaredBy: integer("declared_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("asset_tax_pool_declarations_org_idx").on(t.organizationId, t.companyId),
    unique("asset_tax_pool_declarations_company_group_year_unq").on(t.companyId, t.incomeTaxGroup, t.taxYear),
  ],
);

export type AssetTaxPoolDeclaration = typeof assetTaxPoolDeclarationsTable.$inferSelect;
export type AssetDisposal = typeof assetDisposalsTable.$inferSelect;
export type AssetCategory = typeof assetCategoriesTable.$inferSelect;
export type FixedAsset = typeof fixedAssetsTable.$inferSelect;
export type AssetDepreciationScheduleRow = typeof assetDepreciationScheduleTable.$inferSelect;
export type AssetEvent = typeof assetEventsTable.$inferSelect;
