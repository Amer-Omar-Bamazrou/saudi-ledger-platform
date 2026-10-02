import { pgTable, serial, text, timestamp, integer, smallint, numeric, uuid, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { categoriesTable } from "./categories";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

/**
 * Phase 15 — budgets (docs/product/phase-14-15-reporting-budgeting-decision-pack.md §5).
 *
 *   budgets ──< budget_versions ──< budget_lines
 *
 * A budget FREEZES its fiscal year (calendar, start month, label, start/end):
 * `companies.fiscal_year_start` is editable, and a budget keeps the periods it
 * was set against (D15-01). Its twelve periods are re-derived from the frozen
 * fields by `fiscalMonths()` (apps/api/src/lib/fiscalYear.ts).
 *
 * 🔴 The lifecycle is enforced AT THE DATABASE (migration 0112): lines are
 * writable only while their version is `draft`; a version moves only along
 * draft → submitted → approved → superseded (plus send-back submitted → draft);
 * an approved or superseded version can never be deleted — so a budget that was
 * ever approved cannot be deleted either (D15-04). Actor columns are plain ids
 * (the 0110 pattern): an FK to `users` would let a user deletion rewrite an
 * approved, immutable version; the audit log carries the actor as well. Partial unique indexes make
 * two approved versions, or two open ones, inexpressible.
 */
export const budgetsTable = pgTable(
  "budgets",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    name: text("name").notNull(),
    nameAr: text("name_ar"),
    /** base | best_case | worst_case — the analytics card reads `base` (D15-14). */
    scenario: text("scenario").notNull().default("base"),
    /** Frozen fiscal year (D15-01). `fiscal_label` is in the calendar named here (an AH year for Hijri). */
    fiscalCalendar: text("fiscal_calendar").notNull(),
    fiscalStartMonth: smallint("fiscal_start_month").notNull(),
    fiscalLabel: integer("fiscal_label").notNull(),
    fiscalYearStart: text("fiscal_year_start").notNull(),
    fiscalYearEnd: text("fiscal_year_end").notNull(),
    notes: text("notes"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("budgets_company_idx").on(t.companyId, t.fiscalYearStart),
    uniqueIndex("budgets_company_year_scenario_name_unq").on(t.companyId, t.fiscalYearStart, t.scenario, t.name),
    check("budgets_scenario_chk", sql`${t.scenario} in ('base', 'best_case', 'worst_case')`),
    check("budgets_calendar_chk", sql`${t.fiscalCalendar} in ('gregorian', 'hijri')`),
    check("budgets_start_month_chk", sql`${t.fiscalStartMonth} between 1 and 12`),
    check("budgets_year_order_chk", sql`${t.fiscalYearStart} < ${t.fiscalYearEnd}`),
    check("budgets_year_format_chk", sql`${t.fiscalYearStart} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and ${t.fiscalYearEnd} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
  ],
);

export const budgetVersionsTable = pgTable(
  "budget_versions",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    budgetId: integer("budget_id").notNull().references(() => budgetsTable.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    /** draft | submitted | approved | superseded (D15-04). */
    status: text("status").notNull().default("draft"),
    /** The approved version this revision was copied from; null for version 1. */
    basedOnVersionId: integer("based_on_version_id"),
    notes: text("notes"),
    sendBackNote: text("send_back_note"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    submittedBy: integer("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: integer("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("budget_versions_no_unq").on(t.budgetId, t.versionNo),
    uniqueIndex("budget_versions_one_approved_unq").on(t.budgetId).where(sql`status = 'approved'`),
    uniqueIndex("budget_versions_one_open_unq").on(t.budgetId).where(sql`status in ('draft', 'submitted')`),
    index("budget_versions_company_idx").on(t.companyId),
    check("budget_versions_status_chk", sql`${t.status} in ('draft', 'submitted', 'approved', 'superseded')`),
    check("budget_versions_no_chk", sql`${t.versionNo} >= 1`),
  ],
);

export const budgetLinesTable = pgTable(
  "budget_lines",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    versionId: integer("version_id").notNull().references(() => budgetVersionsTable.id, { onDelete: "cascade" }),
    accountId: integer("account_id").notNull().references(() => categoriesTable.id),
    /** 1–12 = that fiscal month; NULL = an ANNUAL-ONLY amount, never divided (D15-03). */
    periodNo: smallint("period_no"),
    /** In the account's natural direction (income: credit; expense: debit). */
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    /** M19 import provenance (D15-11): the `budgets_legacy` row this line was copied from. */
    legacyBudgetId: integer("legacy_budget_id"),
  },
  (t) => [
    uniqueIndex("budget_lines_cell_unq").on(t.versionId, t.accountId, sql`coalesce(${t.periodNo}, 0)`),
    uniqueIndex("budget_lines_legacy_unq").on(t.legacyBudgetId).where(sql`legacy_budget_id is not null`),
    index("budget_lines_account_idx").on(t.accountId),
    check("budget_lines_period_chk", sql`${t.periodNo} is null or ${t.periodNo} between 1 and 12`),
    check("budget_lines_amount_chk", sql`${t.amount} >= 0`),
  ],
);

/**
 * The M19 table, kept as an ARCHIVE (D15-11): renamed, its rows untouched,
 * write grants revoked. Declared here only so the schema snapshot is truthful;
 * nothing in the application reads or writes it. Dropping it is an owner
 * decision.
 */
export const budgetsLegacyTable = pgTable("budgets_legacy", {
  id: serial("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  companyId: uuid("company_id").notNull(),
  name: text("name").notNull(),
  nameAr: text("name_ar"),
  period: text("period").notNull(),
  categoryId: integer("category_id"),
  budgetedAmount: numeric("budgeted_amount", { precision: 15, scale: 2 }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Budget = typeof budgetsTable.$inferSelect;
export type BudgetVersion = typeof budgetVersionsTable.$inferSelect;
export type BudgetLine = typeof budgetLinesTable.$inferSelect;
