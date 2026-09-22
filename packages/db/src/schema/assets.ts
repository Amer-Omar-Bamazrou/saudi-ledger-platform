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

export type AssetCategory = typeof assetCategoriesTable.$inferSelect;
export type FixedAsset = typeof fixedAssetsTable.$inferSelect;
export type AssetDepreciationScheduleRow = typeof assetDepreciationScheduleTable.$inferSelect;
export type AssetEvent = typeof assetEventsTable.$inferSelect;
