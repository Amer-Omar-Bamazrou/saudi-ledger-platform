/**
 * PHASE 12C — A TRANSFER BETWEEN THE BUSINESS'S OWN BANKS (2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §5.
 *
 * ONE document, ONE entry, TWO cash lines — never two:
 *
 *   Dr <destination bank's cash leaf>   amount
 *     Cr <source bank's cash leaf>      amount
 *
 * The two statement lines the banks later report (a debit on the source, a
 * credit on the destination) are RECONCILED to those two cash lines through
 * `bank_statement_links` (method `transfer`) — they are never accepted to
 * post, which would move the cash a second time. The acceptance guard that
 * refuses a reconciled line (12B) is what makes that duplicate unsayable.
 *
 * This is the reference implementations' shape (pack §2): ERPNext's Payment
 * Entry of type "Internal Transfer" and Odoo's paired internal-transfer
 * payment both RECORD the transfer and reconcile the statement to it.
 *
 * The OTHER path that already existed stays: a statement leg accepted as an
 * own-account transfer posts cash against Transfer clearing, and the second
 * leg nets it. The two are different facts (a transfer we recorded, versus a
 * movement we only saw on a statement), and 12C refuses to let one movement
 * be both: recording a transfer that looks like one already posted through
 * clearing, or already recorded, needs an explicit confirmation with a
 * reason — kept on the row.
 *
 * Append-only. A wrong transfer is reversed by a superseding row whose
 * mirror entry posts in an OPEN period; nothing is edited or deleted. A
 * transfer whose cash lines are reconciled cannot be reversed until the
 * reconciliation is undone (the journal-entry trigger in migration 0101).
 */
import { pgTable, serial, integer, text, numeric, date, uuid, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { bankAccountsTable } from "./bankAccounts";
import { journalEntriesTable } from "./journalEntries";

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

export const bankTransfersTable = pgTable(
  "bank_transfers",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    fromBankAccountId: integer("from_bank_account_id").notNull().references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    toBankAccountId: integer("to_bank_account_id").notNull().references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    transferDate: date("transfer_date").notNull(),
    reference: text("reference"),
    memo: text("memo"),
    journalEntryId: integer("journal_entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    /**
     * Set only when the person confirmed a POSSIBLE DUPLICATE (a transfer of
     * the same amount between the same banks already recorded, or already
     * posted through Transfer clearing, near the date): what they said.
     */
    duplicateConfirmationReason: text("duplicate_confirmation_reason"),
    idempotencyKey: text("idempotency_key"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("bank_transfers_from_idx").on(t.fromBankAccountId, t.transferDate),
    index("bank_transfers_to_idx").on(t.toBankAccountId, t.transferDate),
    uniqueIndex("bank_transfers_entry_unq").on(t.journalEntryId),
    uniqueIndex("bank_transfers_idempotency_unq").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
    check("bank_transfers_amount_chk", sql`amount > 0`),
    check("bank_transfers_distinct_banks_chk", sql`from_bank_account_id <> to_bank_account_id`),
  ],
);

export const bankTransferReversalsTable = pgTable(
  "bank_transfer_reversals",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    transferId: integer("transfer_id").notNull().references(() => bankTransfersTable.id, { onDelete: "restrict" }),
    reversalJournalEntryId: integer("reversal_journal_entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bank_transfer_reversals_transfer_unq").on(t.transferId),
    check("bank_transfer_reversals_reason_chk", sql`length(btrim(reason)) > 0`),
  ],
);

export type BankTransfer = typeof bankTransfersTable.$inferSelect;
export type BankTransferReversal = typeof bankTransferReversalsTable.$inferSelect;
