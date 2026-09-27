/**
 * PHASE 12B — RECONCILING A STATEMENT LINE TO THE LEDGER (2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §4.
 *
 * A LINK says: this much of this bank statement line IS this GL cash line.
 * It is reconciliation identity, never an accounting event — nothing posts
 * because a link is made, and no posted line is rewritten.
 *
 * It exists for every cash movement the Phase D matcher cannot express:
 * supplier payments and refunds (Phase 11), legacy bill payments, manual
 * journals (a bank charge journalled by hand), transfers — and for PARTIAL
 * and MULTI-DOCUMENT reconciliation: one statement line may be several links
 * (a single bank debit that paid two suppliers), and one cash line may be
 * answered by several statement lines (a payment the bank split in two).
 *
 * 🔴 ONE DEFINITION of "how much of this line is reconciled" — the view
 * `bank_line_reconciliation` (migration 0100), which unions THIS table with
 * the sources that already existed (a line's own posting, Phase D matches,
 * receipts settled from Review). The caps — a statement line never
 * reconciled beyond its amount, a cash line never beyond ITS amount, across
 * every source — are enforced by triggers reading that view, not by the
 * service alone: a future writer that forgets the check is refused by the
 * database.
 *
 * Append-only. A wrong link is superseded by a reversal (one per link);
 * nothing is edited or deleted. Both reference implementations DELETE the
 * link when a reconciliation is undone (pack §2.3); this keeps the record.
 */
import { pgTable, serial, integer, text, numeric, jsonb, uuid, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { transactionsTable } from "./transactions";
import { journalEntryLinesTable } from "./journalEntries";

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

export const BANK_LINK_METHODS = ["manual", "deterministic", "settlement", "transfer"] as const;

export const bankStatementLinksTable = pgTable(
  "bank_statement_links",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    transactionId: integer("transaction_id").notNull().references(() => transactionsTable.id, { onDelete: "restrict" }),
    journalLineId: integer("journal_line_id").notNull().references(() => journalEntryLinesTable.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    /**
     * `manual`        a person's decision, with a reason when the evidence
     *                 does not speak for itself (a date or amount difference);
     * `deterministic` every clause of the matching policy held (the same
     *                 policy as Phase D: same bank, direction, exact amount,
     *                 an identifying reference, inside the window, one
     *                 candidate, one-to-one);
     * `settlement`    the source was CREATED from this line (a bill settled
     *                 from Review);
     * `transfer`      the line is one leg of a bank-to-bank transfer (12C).
     */
    method: text("method").notNull(),
    evidence: jsonb("evidence").notNull().default(sql`'{}'::jsonb`),
    reason: text("reason"),
    idempotencyKey: text("idempotency_key"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("bank_statement_links_transaction_idx").on(t.transactionId),
    index("bank_statement_links_line_idx").on(t.journalLineId),
    uniqueIndex("bank_statement_links_idempotency_unq").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
    check("bank_statement_links_amount_chk", sql`amount > 0`),
    check("bank_statement_links_method_chk", sql`method IN ('manual', 'deterministic', 'settlement', 'transfer')`),
  ],
);

export const bankStatementLinkReversalsTable = pgTable(
  "bank_statement_link_reversals",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    linkId: integer("link_id").notNull().references(() => bankStatementLinksTable.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bank_statement_link_reversals_link_unq").on(t.linkId),
    check("bank_statement_link_reversals_reason_chk", sql`length(trim(reason)) > 0`),
  ],
);

export type BankStatementLink = typeof bankStatementLinksTable.$inferSelect;
export type BankStatementLinkReversal = typeof bankStatementLinkReversalsTable.$inferSelect;
