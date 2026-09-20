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
import { pgTable, serial, integer, date, boolean, timestamp, numeric, uuid, text, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { invoicesTable } from "./invoices";
import { billsTable } from "./bills";
import { bankAccountsTable } from "./bankAccounts";
import { customersTable } from "./customers";
import { journalEntriesTable } from "./journalEntries";
import { transactionsTable } from "./transactions";

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
    /**
     * 🔴 D-3 (2026-09-16): WHICH BANK the money arrived in — the source
     * evidence that makes this payment's bank identity DETERMINISTIC for
     * every later migration (D-4's backfill reads it). Required on every
     * payment recorded since 0073; NULL only on history, which is exactly the
     * set the cash cut-over classifies AMBIGUOUS_REQUIRES_REVIEW.
     */
    bankAccountId: integer("bank_account_id").references(() => bankAccountsTable.id, { onDelete: "restrict" }),
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
    /** D-3: the paying bank — see `invoicePaymentsTable.bankAccountId`. */
    bankAccountId: integer("bank_account_id").references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("bill_payments_bill_idx").on(t.billId), index("bill_payments_org_idx").on(t.organizationId)],
);

export type InvoicePayment = typeof invoicePaymentsTable.$inferSelect;
export type BillPayment = typeof billPaymentsTable.$inferSelect;

/**
 * D-4 (2026-09-17) — THE PAYMENT: one row per cash event with a party.
 *
 * Three identities, kept apart by construction (batch-1b-decision-pack §4):
 *   BANK identity       `bank_account_id` — which of OUR accounts the money
 *                        moved through; the cash line posts to that bank's
 *                        own GL leaf (D-3). Never inferred from the party.
 *   PAYMENT identity    party + direction + date + amount + reference — the
 *                        economic event. Never inferred from a statement
 *                        row's amount or from a document.
 *   ALLOCATION identity `payment_allocations` — which document(s) this
 *                        payment settles and for how much. The unallocated
 *                        remainder IS the customer's deposit (a liability,
 *                        never a credit inside AR — accountant-confirmed).
 *
 * `journal_entry_id` is NOT NULL: a payment exists only as a posted entry
 * (Dr bank / Cr AR for the allocated part / Cr Customer deposits for the
 * rest). Append-only for the app role — a wrong payment is reversed and
 * re-entered, never edited. `idempotency_key` is unique per company so the
 * same request twice is one payment (DB-enforced, not a client courtesy).
 *
 * Future integrations (documentation only — no provider code exists): a
 * gateway transaction, a bank settlement, this payment and an allocation
 * are four different facts. A customer paying 1,000 through a gateway that
 * nets 980 to the bank settles an invoice for 1,000; nothing here requires
 * the payment amount to equal a bank movement amount, and nothing here
 * references a provider.
 */
export const paymentsTable = pgTable(
  "payments",
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
    /** `in` = a receipt (customer → us). `out` is reserved for Part 2 refunds; no writer produces it yet. */
    direction: text("direction").notNull(),
    /** `customer` names `customer_id`; `none` is a B2C receipt fully allocated to unidentified-customer invoices. */
    partyType: text("party_type").notNull(),
    customerId: integer("customer_id").references(() => customersTable.id, { onDelete: "restrict" }),
    bankAccountId: integer("bank_account_id")
      .notNull()
      .references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    paidAt: date("paid_at").notNull(),
    method: text("method"),
    reference: text("reference"),
    idempotencyKey: text("idempotency_key"),
    /** `manual` (POST /payments), `invoice_pay` (the Mark-Paid convenience), `settlement` (a bank row settled from Review). */
    source: text("source").notNull(),
    journalEntryId: integer("journal_entry_id")
      .notNull()
      .references(() => journalEntriesTable.id, { onDelete: "cascade" }),
    /** The bank row this payment was settled from, when it was. */
    sourceTransactionId: integer("source_transaction_id").references(() => transactionsTable.id, { onDelete: "set null" }),
    /** Batch 1C: the staged advance this deposit was migrated from (source = 'opening'); its cash is inside the bank's opening balance. */
    migrationAdvanceId: integer("migration_advance_id"),
    /**
     * Batch 1C Policy C (accountant A4, 2026-09-20; pack §16.12.1): a migrated
     * deposit is never deleted. Its reversal is a SUPERSEDING RECORD in
     * `migration_deposit_reversals` (payments stay append-only — UPDATE and
     * DELETE revoked; the 0079 DELETE grant is withdrawn by 0081). The
     * replacement deposit of a corrected re-run points back here; opening-only
     * by CHECK.
     */
    replacesPaymentId: integer("replaces_payment_id"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("payments_idempotency_unq").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
    index("payments_customer_idx").on(t.customerId),
    index("payments_company_idx").on(t.companyId),
    check("payments_amount_positive_chk", sql`amount > 0`),
    check("payments_direction_chk", sql`direction IN ('in', 'out')`),
    check("payments_party_chk", sql`(party_type = 'customer' AND customer_id IS NOT NULL) OR (party_type = 'none' AND customer_id IS NULL)`),
    check("payments_source_chk", sql`source IN ('manual', 'invoice_pay', 'settlement', 'opening')`),
  ],
);

/**
 * D-4 — THE ALLOCATION: `source → invoice, amount`. Exactly one source:
 * a payment (`payment_id`) or a credit note (`credit_note_id`, an
 * `invoices` row of document_type credit_note). One row per (source,
 * invoice) — a second allocation of the same pair is a duplicate request,
 * refused by the index rather than by the client. `journal_entry_id` is
 * set when THIS allocation posted something on its own (a later allocation
 * of a deposit: Dr Customer deposits / Cr AR; a later application of a
 * credit: Dr Customer credit balances / Cr AR) and NULL when its effect
 * was folded into the source's own entry (allocated at receipt; a note's
 * own settlement of its original at issue). Append-only.
 */
export const paymentAllocationsTable = pgTable(
  "payment_allocations",
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
    paymentId: integer("payment_id").references(() => paymentsTable.id, { onDelete: "cascade" }),
    creditNoteId: integer("credit_note_id").references(() => invoicesTable.id, { onDelete: "cascade" }),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "cascade" }),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    journalEntryId: integer("journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Phase A (2026-09-17): the (source, invoice) pair is no longer unique at
    // the index — a corrected allocation may be re-made to the same invoice.
    // "One ACTIVE allocation per pair" is enforced by the service under the
    // source lock, and "one correction per allocation" by
    // payment_allocation_reversals.allocation_id UNIQUE.
    uniqueIndex("payment_allocations_idempotency_unq").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
    index("payment_allocations_invoice_idx").on(t.invoiceId),
    check("payment_allocations_amount_positive_chk", sql`amount > 0`),
    check("payment_allocations_one_source_chk", sql`(payment_id IS NOT NULL) <> (credit_note_id IS NOT NULL)`),
  ],
);

export type Payment = typeof paymentsTable.$inferSelect;
export type PaymentAllocation = typeof paymentAllocationsTable.$inferSelect;

/**
 * Phase A (2026-09-17) — THE CORRECTION OF AN ALLOCATION: a superseding
 * record, never an edit or a delete. One row per corrected allocation
 * (`allocation_id` UNIQUE — the database refuses a second correction, which
 * is also what serialises two concurrent attempts into one success and one
 * deterministic conflict). The row carries the reversing journal entry:
 *   payment allocation  → Dr AR(customer) / Cr Customer deposits(customer)
 *   credit application  → Dr AR(customer) / Cr Customer credit balances(customer)
 * so the source's availability and the invoice's outstanding return by
 * exactly the allocation's amount and nothing else. The original allocation
 * stays exactly as it was, visible, with this row beside it. Append-only.
 */
export const paymentAllocationReversalsTable = pgTable(
  "payment_allocation_reversals",
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
    allocationId: integer("allocation_id")
      .notNull()
      .references(() => paymentAllocationsTable.id, { onDelete: "cascade" }),
    /** Copied from the allocation so the correction reads on its own. */
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    journalEntryId: integer("journal_entry_id")
      .notNull()
      .references(() => journalEntriesTable.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("payment_allocation_reversals_allocation_unq").on(t.allocationId),
    uniqueIndex("payment_allocation_reversals_idempotency_unq").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
    check("payment_allocation_reversals_amount_positive_chk", sql`amount > 0`),
  ],
);

/**
 * Phase C (2026-09-17) — A CUSTOMER REFUND settles an existing credit; it
 * never reverses the receipt or the credit note it returns. The ORIGIN is
 * explicit and the source is a specific record: a deposit refund names the
 * receipt (`payment_id`) whose unapplied remainder it returns; a credit-note
 * refund names the note (`credit_note_id`) whose unconsumed balance it
 * returns. Journal (through the seam, accounts from customerCreditPolicy):
 *   deposit      Dr Customer deposits(customer)        / Cr bank leaf
 *   credit_note  Dr Customer credit balances(customer) / Cr bank leaf
 * No VAT is posted or altered here: a credit note carried its own VAT
 * adjustment at issue, and the platform cannot have tax-invoiced a deposit
 * (no advance-invoice document exists — see paymentsService.refund).
 * Append-only; `idempotency_key` unique per company.
 */
export const customerRefundsTable = pgTable(
  "customer_refunds",
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
    customerId: integer("customer_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "restrict" }),
    bankAccountId: integer("bank_account_id")
      .notNull()
      .references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    origin: text("origin").notNull(),
    paymentId: integer("payment_id").references(() => paymentsTable.id, { onDelete: "cascade" }),
    creditNoteId: integer("credit_note_id").references(() => invoicesTable.id, { onDelete: "cascade" }),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    refundedAt: date("refunded_at").notNull(),
    reason: text("reason").notNull(),
    reference: text("reference"),
    journalEntryId: integer("journal_entry_id")
      .notNull()
      .references(() => journalEntriesTable.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("customer_refunds_idempotency_unq").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
    index("customer_refunds_customer_idx").on(t.customerId),
    index("customer_refunds_payment_idx").on(t.paymentId),
    index("customer_refunds_note_idx").on(t.creditNoteId),
    check("customer_refunds_amount_positive_chk", sql`amount > 0`),
    check("customer_refunds_origin_chk", sql`(origin = 'deposit' AND payment_id IS NOT NULL AND credit_note_id IS NULL) OR (origin = 'credit_note' AND credit_note_id IS NOT NULL AND payment_id IS NULL)`),
  ],
);

export type PaymentAllocationReversal = typeof paymentAllocationReversalsTable.$inferSelect;
export type CustomerRefund = typeof customerRefundsTable.$inferSelect;
