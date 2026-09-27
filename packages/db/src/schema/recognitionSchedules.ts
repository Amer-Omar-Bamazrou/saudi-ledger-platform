/**
 * ACCRUALS AND PREPAYMENTS — one engine, two directions (Phase 11 A2/A3,
 * 2026-09-22).
 *
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §2, §3.
 *
 * ── Why one table for both ─────────────────────────────────────────────────
 * An accrual and a prepayment are the same mechanism pointed opposite ways: a
 * total, a number of periods, and a monthly entry between an EXPENSE account
 * and a BALANCE-SHEET account. What differs is which side the balance-sheet
 * account is on and when cash moves — and that is one column (`kind`), not two
 * subsystems. Splitting them would give the product two schedules, two
 * generators and two rounding conventions to keep in step.
 *
 * ── 🔴 THE ACCOUNT AN ACCRUAL MUST NOT USE ─────────────────────────────────
 * IAS 37.11 separates them in terms: trade payables are liabilities for goods
 * or services "that have been received or supplied **and have been invoiced**";
 * accruals are for what has been received "but **have not been paid, invoiced
 * or formally agreed** with the supplier". So an accrual posts to
 * `ACCRUED_LIABILITIES`, never to `AP`. Putting it in AP would create a
 * payable in a supplier's balance that no statement can match and no supplier
 * payment can settle, and it would age in AP ageing as though an invoice
 * existed.
 *
 * ── The shape is the fixed-asset register's, deliberately ──────────────────
 * A document holding the facts; a STORED schedule with one row per period;
 * posted rows FROZEN by trigger; the recognised total DERIVED from the posted
 * rows rather than stored on the header; every effect through
 * `postJournalEntry` after `checkPeriodOpen`. That shape is proven here (FA-A)
 * and reusing it means one set of habits rather than two.
 */
import { pgTable, serial, text, timestamp, integer, numeric, uuid, index, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { categoriesTable } from "./categories";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { journalEntriesTable } from "./journalEntries";
import { vendorsTable } from "./vendors";
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

/**
 * `accrual`     — the expense is INCURRED and not yet invoiced (IAS 37.11).
 *                 Recognition: Dr expense / Cr accrued liabilities.
 * `prepayment`  — cash or an invoice came FIRST and the benefit is later.
 *                 Recognition: Dr expense / Cr prepaid expenses.
 */
export const RECOGNITION_KINDS = ["accrual", "prepayment"] as const;
export type RecognitionKind = (typeof RECOGNITION_KINDS)[number];

export const RECOGNITION_STATUSES = ["draft", "active", "completed", "cancelled"] as const;
export type RecognitionStatus = (typeof RECOGNITION_STATUSES)[number];

export const recognitionSchedulesTable = pgTable(
  "recognition_schedules",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    reference: text("reference").notNull(),
    kind: text("kind").notNull(),
    description: text("description").notNull(),
    descriptionAr: text("description_ar"),
    /** Optional — an accrual for a supplier who has not invoiced yet names them; a prepayment often does too. */
    vendorId: integer("vendor_id").references(() => vendorsTable.id, { onDelete: "restrict" }),
    /** The P&L account each period's recognition debits. */
    expenseAccountId: integer("expense_account_id").notNull().references(() => categoriesTable.id, { onDelete: "restrict" }),
    /**
     * The balance-sheet account each period credits: `ACCRUED_LIABILITIES` for
     * an accrual, `PREPAID_EXPENSES` for a prepayment. Stored rather than
     * derived from `kind` so a tenant with its own chart can point a schedule
     * at its own account — and CHECKED against the kind's type at the service
     * boundary, because a prepayment sitting on a liability is not a
     * prepayment.
     */
    balanceAccountId: integer("balance_account_id").notNull().references(() => categoriesTable.id, { onDelete: "restrict" }),
    totalAmount: numeric("total_amount", { precision: 15, scale: 2 }).notNull(),
    /** How many periods the total is recognised over. Whole periods only — see pack §2.5. */
    periods: integer("periods").notNull(),
    /** `YYYY-MM` — the period the FIRST row recognises in. */
    startPeriod: text("start_period").notNull(),
    status: text("status").notNull().default("draft"),
    /**
     * The entry that RAISED the balance — the prepayment's `Dr prepaid / Cr
     * bank` or the accrual's own opening. NULL while the schedule is a draft,
     * and NULL for a prepayment raised by a bill (the bill's own entry did it).
     */
    openingJournalEntryId: integer("opening_journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    /** The bill whose payment created a prepayment, when that is where it came from. */
    sourceBillId: integer("source_bill_id"),
    notes: text("notes"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("recognition_schedules_org_idx").on(t.organizationId, t.companyId),
    unique("recognition_schedules_company_reference_unq").on(t.companyId, t.reference),
  ],
);

/**
 * One row per period, generated when the schedule is activated and posted once.
 *
 * `journal_entry_id` NULL = planned, set = posted and then FROZEN by trigger.
 * `unique(schedule_id, period)` is what makes "a period is recognised once" a
 * property of the TABLE rather than of the caller — the same guarantee
 * `asset_depreciation_schedule` carries.
 */
export const recognitionScheduleRowsTable = pgTable(
  "recognition_schedule_rows",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    scheduleId: integer("schedule_id").notNull().references(() => recognitionSchedulesTable.id, { onDelete: "restrict" }),
    /** YYYY-MM */
    period: text("period").notNull(),
    sequence: integer("sequence").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    journalEntryId: integer("journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("recognition_schedule_rows_schedule_idx").on(t.scheduleId, t.sequence),
    unique("recognition_schedule_rows_schedule_period_unq").on(t.scheduleId, t.period),
  ],
);

export type RecognitionSchedule = typeof recognitionSchedulesTable.$inferSelect;
export type RecognitionScheduleRow = typeof recognitionScheduleRowsTable.$inferSelect;
