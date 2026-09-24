/**
 * PHASE 12D — A BANK RECONCILIATION, COMPLETED AS OF A DATE (2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §6.
 *
 * The identity it proves, for one bank as of a date D:
 *
 *   statement balance  =  ledger balance
 *                         − ledger-only movements   (in the books, not yet on the statement:
 *                                                    outstanding payments, deposits in transit)
 *                         + statement-only movements (on the statement, not yet in the books:
 *                                                    a bank charge nobody has recorded)
 *
 * every term computed from the ONE definition of reconciliation
 * (`bank_line_reconciliation`) and the ONE definition of a bank's ledger
 * (`journal_line_bank_identity`). 🔴 It is recorded only when the difference
 * is ZERO: there is no plug, no "reconciliation difference" account, and no
 * way to say "close enough". A difference is something to find, not to book.
 *
 * Append-only. A completed reconciliation is SNAPSHOTTED (every term and every
 * reconciling item, as it stood) and it LOCKS what it relied on: a link or
 * match on a statement line dated on or before D cannot be undone while it
 * stands. Reopening is a superseding row with a reason — the latest first,
 * so the chain of completed dates never has a hole.
 */
import { pgTable, serial, integer, text, numeric, date, jsonb, uuid, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { bankAccountsTable } from "./bankAccounts";
import { bankStatementsTable } from "./bankStatements";

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

export const bankReconciliationsTable = pgTable(
  "bank_reconciliations",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    bankAccountId: integer("bank_account_id").notNull().references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    asOf: date("as_of").notNull(),
    /** The statement whose closing balance was used, when there is one. */
    bankStatementId: integer("bank_statement_id").references(() => bankStatementsTable.id, { onDelete: "restrict" }),
    statementBalance: numeric("statement_balance", { precision: 15, scale: 2 }).notNull(),
    ledgerBalance: numeric("ledger_balance", { precision: 15, scale: 2 }).notNull(),
    ledgerOnlyTotal: numeric("ledger_only_total", { precision: 15, scale: 2 }).notNull(),
    statementOnlyTotal: numeric("statement_only_total", { precision: 15, scale: 2 }).notNull(),
    /** Always 0.00 — recorded so the row states its own proof. */
    difference: numeric("difference", { precision: 15, scale: 2 }).notNull(),
    /** Every reconciling item as it stood: { ledgerOnly: [...], statementOnly: [...] }. */
    snapshot: jsonb("snapshot").notNull(),
    notes: text("notes"),
    completedBy: integer("completed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("bank_reconciliations_bank_idx").on(t.bankAccountId, t.asOf),
    check("bank_reconciliations_zero_chk", sql`difference = 0`),
  ],
);

export const bankReconciliationReopeningsTable = pgTable(
  "bank_reconciliation_reopenings",
  {
    id: serial("id").primaryKey(),
    ...tenantColumns,
    reconciliationId: integer("reconciliation_id").notNull().references(() => bankReconciliationsTable.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    reopenedBy: integer("reopened_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bank_reconciliation_reopenings_unq").on(t.reconciliationId),
    check("bank_reconciliation_reopenings_reason_chk", sql`length(btrim(reason)) > 0`),
  ],
);

export type BankReconciliation = typeof bankReconciliationsTable.$inferSelect;
