/**
 * THE ACCOUNTS-PAYABLE SUBLEDGER (Phase 11 Part 2, B3/B4/B7, 2026-09-22).
 *
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §9–§12.
 *
 * ── 🔴 WHY THIS IS A PARALLEL MODEL AND NOT A RETROFIT ─────────────────────
 * `payments` / `payment_allocations` are structurally CUSTOMER-specific, not
 * incidentally so: `payment_allocations.invoice_id` is NOT NULL and points at
 * `invoices`; its `credit_note_id` points at `invoices`; `payments` carries
 * `customer_id` with `party_type IN ('customer','none')`; and the correction
 * entries in `payment_allocation_reversals` name AR and the customer-deposit
 * liabilities by construction. Making those nullable and adding bill columns
 * would leave every existing AR query reading a table where half the rows are
 * not its business — and the D-4 invariants, the customer statement and the
 * deposit-classification policy all assume otherwise.
 *
 * So AP gets its own tables with the SAME DISCIPLINE the AR side proved:
 * append-only records, allocations as their own rows, corrections as
 * SUPERSEDING records rather than edits, and one active allocation per pair.
 * The shapes are deliberately recognisable; the columns are AP's own.
 *
 * ── 🔴 THE DIRECTION IS NOT A MIRROR ───────────────────────────────────────
 * A customer advance is a LIABILITY (we owe goods). A supplier advance is an
 * ASSET (they owe us goods). Every on-account balance here is therefore a
 * DEBIT balance on an asset account, and the reclassification map below moves
 * between assets — never between the customer-side liabilities.
 *
 * ── 🔴 AND NEITHER IS THE VAT ──────────────────────────────────────────────
 * VAT IR Art. 49(7): "Input Tax may only be deducted where the Taxable Person
 * HOLDS EVIDENCE of the amount of Input Tax paid or payable…". Our right to
 * deduct depends on holding the SUPPLIER'S tax invoice, not on our payment —
 * so a supplier advance carries NO input VAT when it is paid. VAT enters when
 * the supplier's document does, which in this product is a BILL. That is the
 * asymmetry with AR, where the tax point is the receipt because the output tax
 * is ours to declare.
 */
import { pgTable, serial, integer, date, text, numeric, uuid, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { vendorsTable } from "./vendors";
import { bankAccountsTable } from "./bankAccounts";
import { billsTable } from "./bills";
import { journalEntriesTable } from "./journalEntries";
import { transactionsTable } from "./transactions";

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
 * `advance`          — a genuine payment on account for goods/services to come.
 * `security_deposit` — refundable, outside the scope of a supply until forfeited.
 * `erroneous`        — paid in error; it is coming back.
 * `unknown`          — not yet classified. 🔴 The DEFAULT, and never silently
 *                      an advance: an unclassified payment that quietly became
 *                      an advance would assert a commercial fact nobody stated.
 */
export const SUPPLIER_PAYMENT_CLASSIFICATIONS = ["advance", "security_deposit", "erroneous", "unknown"] as const;
export type SupplierPaymentClassification = (typeof SUPPLIER_PAYMENT_CLASSIFICATIONS)[number];

export const supplierPaymentsTable = pgTable(
  "supplier_payments",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    vendorId: integer("vendor_id").notNull().references(() => vendorsTable.id, { onDelete: "restrict" }),
    /** D-3: which bank the money actually left. Never a default, never inferred. */
    bankAccountId: integer("bank_account_id").notNull().references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    paidAt: date("paid_at").notNull(),
    method: text("method"),
    reference: text("reference"),
    notes: text("notes"),
    /**
     * The on-account classification at the moment of payment, and the thing the
     * unallocated remainder's account is chosen from. `unknown` until someone
     * says otherwise.
     */
    classification: text("classification").notNull().default("unknown"),
    /** `manual` (a payment run) · `bill_pay` (the per-bill convenience) · `opening` (migrated). */
    source: text("source").notNull(),
    /** The entry that moved the cash. NOT NULL: a supplier payment that posted nothing is not a payment. */
    journalEntryId: integer("journal_entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key"),
    /**
     * 🔴 THREE COLUMNS WERE HERE AND ARE GONE (2026-09-22, before this
     * schema was ever committed): `source_transaction_id`,
     * `migration_batch_id`, `source_reference`. Each was written for work this
     * batch did NOT do — statement-line matching for supplier payments, and
     * migrated supplier advances (B4.6) — and each had no writer and no
     * reader. A column that looks exactly like progress and holds nothing is
     * the shape this codebase already names three times (`feature_flags`,
     * `branches`, `departments`): build the consumer, or do not add the
     * column. When either lands, it adds its own column in its own migration,
     * and the column will mean something on the day it appears.
     */
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("supplier_payments_vendor_idx").on(t.vendorId),
    index("supplier_payments_company_idx").on(t.companyId, t.paidAt),
    // Phase 12: the reconciliation reads name a cash line's document by its entry.
    index("supplier_payments_entry_idx").on(t.journalEntryId),
    uniqueIndex("supplier_payments_idempotency_unq").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
    check("supplier_payments_amount_positive_chk", sql`amount > 0`),
    check("supplier_payments_classification_chk", sql`classification IN ('advance', 'security_deposit', 'erroneous', 'unknown')`),
    check("supplier_payments_source_chk", sql`source IN ('manual', 'bill_pay', 'opening')`),
  ],
);

/**
 * What a payment (or a supplier credit note) was applied to.
 *
 * 🔴 ONE ACTIVE ALLOCATION PER (source, bill) is enforced by the SERVICE under
 * the source's lock, not by a unique index — because a corrected allocation may
 * be re-made to the same bill, exactly as Phase A found on the AR side. The
 * index that IS unique is the correction's (`allocation_id` on the reversal
 * table), which is what serialises two concurrent corrections into one success
 * and one deterministic conflict.
 */
export const supplierPaymentAllocationsTable = pgTable(
  "supplier_payment_allocations",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    supplierPaymentId: integer("supplier_payment_id").references(() => supplierPaymentsTable.id, { onDelete: "restrict" }),
    /** A supplier CREDIT NOTE applied to a bill — the other source of AP settlement (B7). */
    supplierCreditNoteId: integer("supplier_credit_note_id").references(() => billsTable.id, { onDelete: "restrict" }),
    billId: integer("bill_id").notNull().references(() => billsTable.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    /** The entry that moved the value from the on-account asset (or the credit) onto AP. */
    journalEntryId: integer("journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    // (An `idempotency_key` column was dropped in 0098: it had no writer and
    // no reader. One request writes SEVERAL allocation rows, so a per-row
    // unique key could never have represented a replay of it.)
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("supplier_payment_allocations_bill_idx").on(t.billId),
    index("supplier_payment_allocations_payment_idx").on(t.supplierPaymentId),
    check("supplier_payment_allocations_amount_positive_chk", sql`amount > 0`),
    // Exactly one source: a payment or a credit note, never both and never neither.
    check("supplier_payment_allocations_one_source_chk", sql`(supplier_payment_id IS NOT NULL) <> (supplier_credit_note_id IS NOT NULL)`),
  ],
);

/**
 * 🔴 THE CORRECTION OF AN ALLOCATION IS A SUPERSEDING RECORD, never an edit or
 * a delete — the AR side's Phase A discipline, for the same reason: the
 * original allocation is a fact of record and an auditor wants to see it beside
 * what replaced it. `allocation_id` UNIQUE means the database refuses a second
 * correction of the same allocation.
 */
export const supplierPaymentAllocationReversalsTable = pgTable(
  "supplier_payment_allocation_reversals",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    allocationId: integer("allocation_id").notNull().references(() => supplierPaymentAllocationsTable.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    /**
     * NULL exactly when the reversed allocation was a CREDIT-NOTE application:
     * applying a note posted nothing (its debit was already in AP), so undoing
     * it posts nothing either (pack §17). A reversed PAYMENT allocation always
     * carries its mirror entry — the service decides which by the source.
     */
    journalEntryId: integer("journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("supplier_payment_allocation_reversals_allocation_unq").on(t.allocationId),
  ],
);

/**
 * A change of classification, and the entry that reclassified the on-account
 * balance when the ACCOUNT changed.
 *
 * Append-only: one row per act, so the history of what this money was believed
 * to be is readable. A classification that keeps the same account posts nothing
 * and carries NULL — a reclassification entry for a move that did not happen
 * would be a journal entry with no economic event behind it.
 */
export const supplierPaymentClassificationsTable = pgTable(
  "supplier_payment_classifications",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    supplierPaymentId: integer("supplier_payment_id").notNull().references(() => supplierPaymentsTable.id, { onDelete: "cascade" }),
    classification: text("classification").notNull(),
    note: text("note"),
    /** The date the reclassification entry is posted on — in an OPEN period, never re-dated into a closed one. */
    effectiveDate: date("effective_date"),
    journalEntryId: integer("journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("supplier_payment_classifications_payment_idx").on(t.supplierPaymentId),
    check("supplier_payment_classifications_kind_chk", sql`classification IN ('advance', 'security_deposit', 'erroneous', 'unknown')`),
  ],
);

/**
 * Money coming BACK from a supplier — an unused advance or a returned security
 * deposit. The mirror of `customer_refunds`, in the other direction: the asset
 * falls and the bank rises.
 */
export const supplierRefundsTable = pgTable(
  "supplier_refunds",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    supplierPaymentId: integer("supplier_payment_id").notNull().references(() => supplierPaymentsTable.id, { onDelete: "restrict" }),
    vendorId: integer("vendor_id").notNull().references(() => vendorsTable.id, { onDelete: "restrict" }),
    bankAccountId: integer("bank_account_id").notNull().references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    refundedAt: date("refunded_at").notNull(),
    reason: text("reason").notNull(),
    journalEntryId: integer("journal_entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("supplier_refunds_payment_idx").on(t.supplierPaymentId),
    // Phase 12: the reconciliation reads name a cash line's document by its entry.
    index("supplier_refunds_entry_idx").on(t.journalEntryId),
    check("supplier_refunds_amount_positive_chk", sql`amount > 0`),
  ],
);

export type SupplierPayment = typeof supplierPaymentsTable.$inferSelect;
export type SupplierPaymentAllocation = typeof supplierPaymentAllocationsTable.$inferSelect;
export type SupplierPaymentAllocationReversal = typeof supplierPaymentAllocationReversalsTable.$inferSelect;
export type SupplierPaymentClassificationRow = typeof supplierPaymentClassificationsTable.$inferSelect;
export type SupplierRefund = typeof supplierRefundsTable.$inferSelect;
