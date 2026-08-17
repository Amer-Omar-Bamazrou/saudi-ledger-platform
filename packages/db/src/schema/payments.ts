/**
 * B4 — payment HISTORY: one row per payment, with its own date and amount.
 *
 * ── The loss this stops ────────────────────────────────────────────────────
 * A payment used to write `invoices.paid_amount` (a running total) and
 * `invoices.paid_at` (only the LAST payment's date). A second partial payment
 * overwrote the first one's date and left no trace of it — information that
 * stopped existing the moment it happened, unrecoverable by any later care.
 * These tables are the dated record: written by `invoicesService.pay` /
 * `billsService.pay` on the existing path, in the same tenant transaction as
 * the running total. A RECORD beside the posting — never a second posting
 * path.
 *
 * ── 🔴 `backfilled` is what makes the migration honest ─────────────────────
 * Rows created by migration 0046 carry `backfilled = true` and mean "one or
 * more payments totalling this amount, the LAST of them on this date". The
 * instalment split and the earlier instalments' dates were never recorded and
 * are NOT recoverable — the flag says so instead of lying with precision.
 * 🔴 Any consumer that would be wrong on aggregates — days-sales-outstanding,
 * collection-speed trends, instalment analytics — MUST filter `backfilled =
 * false`; a backfilled row is a valid total but a fabricated-looking single
 * payment.
 *
 * ── Append-only ────────────────────────────────────────────────────────────
 * SELECT + INSERT only for the app role (the recurring_runs / audit_logs
 * discipline): the record of when money actually arrived is exactly the row
 * someone would want to quietly amend.
 */
import { pgTable, serial, integer, date, boolean, timestamp, numeric, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { invoicesTable } from "./invoices";
import { billsTable } from "./bills";

export const invoicePaymentsTable = pgTable(
  "invoice_payments",
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
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    paidAt: date("paid_at").notNull(),
    /** True ⇒ an AGGREGATE of pre-B4 payments; date is the last one's. See header. */
    backfilled: boolean("backfilled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("invoice_payments_invoice_idx").on(t.invoiceId), index("invoice_payments_org_idx").on(t.organizationId)],
);

export const billPaymentsTable = pgTable(
  "bill_payments",
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
    billId: integer("bill_id")
      .notNull()
      .references(() => billsTable.id),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    paidAt: date("paid_at").notNull(),
    /** True ⇒ an AGGREGATE of pre-B4 payments; date is the last one's. See header. */
    backfilled: boolean("backfilled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("bill_payments_bill_idx").on(t.billId), index("bill_payments_org_idx").on(t.organizationId)],
);

export type InvoicePayment = typeof invoicePaymentsTable.$inferSelect;
export type BillPayment = typeof billPaymentsTable.$inferSelect;
