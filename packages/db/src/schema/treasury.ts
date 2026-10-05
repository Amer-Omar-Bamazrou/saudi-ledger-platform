import { pgTable, serial, text, timestamp, integer, smallint, numeric, uuid, date, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { billsTable } from "./bills";
import { billPaymentsTable } from "./payments";
import { bankAccountsTable } from "./bankAccounts";
import { WHT_PAYMENT_TYPES_SQL } from "./whtTypes";

/**
 * Phase 17 — Treasury (docs/product/phase-16-17-tax-treasury-decision-pack.md §8).
 *
 * 🔴 NONE OF THESE TABLES HOLDS CASH. The cash position is the ledger (per bank
 * through `journal_line_bank_identity`); what is owed is `billPosition` and the
 * customer statement. These tables hold only what a PERSON decided about the
 * future: a minimum cash buffer, a plan to pay a bill on a date, an assumption
 * the books cannot know. None of them ever posts — a plan is paid through the
 * EXISTING pay path (`payBill`), and nothing here executes a bank payment.
 */

/** One row per company: the treasury policy a person set (never defaulted into a figure). */
export const treasurySettingsTable = pgTable(
  "treasury_settings",
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
    /** The cash the company wants never to fall below; NULL = not declared (the page says so — never read as 0 silently). */
    minimumCashBalance: numeric("minimum_cash_balance", { precision: 15, scale: 2 }),
    forecastHorizonWeeks: smallint("forecast_horizon_weeks").notNull().default(13),
    updatedBy: integer("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("treasury_settings_company_unq").on(t.companyId),
    check("treasury_settings_buffer_chk", sql`${t.minimumCashBalance} is null or ${t.minimumCashBalance} >= 0`),
    check("treasury_settings_horizon_chk", sql`${t.forecastHorizonWeeks} between 1 and 52`),
  ],
);

/**
 * A PLAN to pay (part of) one bill on a date — planned → approved → paid |
 * cancelled. 🔴 "paid" is reached ONLY by paying through `payBill`, and the
 * database checks the payment named is this bill's, of this amount. Edits only
 * while planned; an approved plan is immutable but cancellable, with a reason.
 */
export const scheduledPaymentsTable = pgTable(
  "scheduled_payments",
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
    billId: integer("bill_id").notNull().references(() => billsTable.id, { onDelete: "restrict" }),
    plannedDate: date("planned_date").notNull(),
    /** What the plan will settle with the supplier (the AP amount — the cash is this less any WHT). */
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    /** The bank the plan intends to pay from (D-3: required to EXECUTE, optional to plan). */
    bankAccountId: integer("bank_account_id").references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    /** high | normal | low */
    priority: text("priority").notNull().default("normal"),
    /** planned | approved | paid | cancelled */
    status: text("status").notNull().default("planned"),
    /** For a non-resident's bill: the WHT nature the payment will declare (pack §2.3). */
    whtPaymentType: text("wht_payment_type"),
    notes: text("notes"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    approvedBy: integer("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    paidBillPaymentId: integer("paid_bill_payment_id").references(() => billPaymentsTable.id, { onDelete: "restrict" }),
    paidBy: integer("paid_by"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    cancelledBy: integer("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
  },
  (t) => [
    index("scheduled_payments_company_idx").on(t.companyId, t.status, t.plannedDate),
    index("scheduled_payments_bill_idx").on(t.billId),
    uniqueIndex("scheduled_payments_payment_unq").on(t.paidBillPaymentId).where(sql`paid_bill_payment_id is not null`),
    check("scheduled_payments_amount_chk", sql`${t.amount} > 0`),
    check("scheduled_payments_priority_chk", sql`${t.priority} in ('high', 'normal', 'low')`),
    check("scheduled_payments_status_chk", sql`${t.status} in ('planned', 'approved', 'paid', 'cancelled')`),
    check("scheduled_payments_wht_type_chk", sql`${t.whtPaymentType} is null or ${t.whtPaymentType} in (${WHT_PAYMENT_TYPES_SQL})`),
    check("scheduled_payments_paid_chk", sql`(${t.status} = 'paid') = (${t.paidBillPaymentId} is not null)`),
    check("scheduled_payments_cancel_chk", sql`(${t.status} = 'cancelled') = (${t.cancelReason} is not null)`),
    check("scheduled_payments_approved_chk", sql`${t.status} not in ('approved', 'paid') or ${t.approvedAt} is not null`),
  ],
);

/**
 * A MANUAL ASSUMPTION in the cash forecast — money the books cannot know is
 * coming or going (a loan drawdown, a capital injection, a tax instalment, a
 * planned purchase). Typed `manual` everywhere it appears; it never posts and
 * never reads as cash.
 */
export const treasuryForecastEntriesTable = pgTable(
  "treasury_forecast_entries",
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
    entryDate: date("entry_date").notNull(),
    /** inflow | outflow */
    direction: text("direction").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    /** financing | capex | tax | payroll | receipt | payment | other */
    category: text("category").notNull().default("other"),
    description: text("description").notNull(),
    notes: text("notes"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedBy: integer("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [
    index("treasury_forecast_entries_company_idx").on(t.companyId, t.entryDate),
    check("treasury_forecast_entries_direction_chk", sql`${t.direction} in ('inflow', 'outflow')`),
    check("treasury_forecast_entries_amount_chk", sql`${t.amount} > 0`),
    check("treasury_forecast_entries_category_chk", sql`${t.category} in ('financing', 'capex', 'tax', 'payroll', 'receipt', 'payment', 'other')`),
    check("treasury_forecast_entries_description_chk", sql`length(btrim(${t.description})) >= 3`),
  ],
);

export type TreasurySettings = typeof treasurySettingsTable.$inferSelect;
export type ScheduledPayment = typeof scheduledPaymentsTable.$inferSelect;
export type TreasuryForecastEntry = typeof treasuryForecastEntriesTable.$inferSelect;
