/**
 * PHASE 12A — A BANK STATEMENT IS A RECORD, NOT ONLY ITS LINES (2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §3.
 *
 * Before 12A an import left nothing behind but its lines: no record of which
 * file they came from, which period it covered, or what the bank said the
 * balance was at either end. So nothing could prove a statement was complete,
 * that two statements were continuous, or that the ledger agreed with the
 * bank at the date the bank stated a balance — the question a bank
 * reconciliation exists to answer (12D reads `closing_balance`).
 *
 *   period_from/_to     the dates the statement covers; every line imported
 *                       under it falls inside them (checked before writing).
 *   opening/closing     what the BANK said, both or neither. When given, the
 *                       file must agree with itself: opening + Σ credits −
 *                       Σ debits = closing, over EVERY line in the file —
 *                       or nothing is imported (`statement_does_not_balance`).
 *   file_sha256         the file's identity. The same file for the same bank
 *                       is refused (409) with the statement it already made.
 *   file_*_total/line_count  facts ABOUT THE FILE, kept as provenance. What
 *                       was actually imported is DERIVED (count of lines
 *                       carrying this id), never a stored counter: re-importing
 *                       a period can legitimately import nothing new, and the
 *                       file still happened.
 *
 * 🔴 APPEND-ONLY: the app role holds SELECT and INSERT only. A statement is
 * a fact about what the bank sent; a wrong one is answered by importing the
 * right one, and the continuity report shows both.
 */
import { pgTable, serial, integer, date, text, numeric, uuid, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { bankAccountsTable } from "./bankAccounts";

export const BANK_STATEMENT_SOURCES = ["file_upload", "manual_entry"] as const;

export const bankStatementsTable = pgTable(
  "bank_statements",
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
    bankAccountId: integer("bank_account_id").notNull().references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    openingBalance: numeric("opening_balance", { precision: 15, scale: 2 }),
    closingBalance: numeric("closing_balance", { precision: 15, scale: 2 }),
    source: text("source").notNull(),
    fileName: text("file_name"),
    fileSha256: text("file_sha256"),
    lineCount: integer("line_count").notNull(),
    fileCreditTotal: numeric("file_credit_total", { precision: 15, scale: 2 }).notNull(),
    fileDebitTotal: numeric("file_debit_total", { precision: 15, scale: 2 }).notNull(),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("bank_statements_bank_idx").on(t.companyId, t.bankAccountId, t.periodFrom),
    uniqueIndex("bank_statements_file_unq").on(t.companyId, t.bankAccountId, t.fileSha256).where(sql`file_sha256 IS NOT NULL`),
    check("bank_statements_period_chk", sql`period_from <= period_to`),
    check("bank_statements_balances_both_chk", sql`(opening_balance IS NULL) = (closing_balance IS NULL)`),
    check("bank_statements_source_chk", sql`source IN ('file_upload', 'manual_entry')`),
    check("bank_statements_sha_chk", sql`file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'`),
    check("bank_statements_file_needs_sha_chk", sql`source <> 'file_upload' OR file_sha256 IS NOT NULL`),
    check("bank_statements_totals_chk", sql`line_count >= 0 AND file_credit_total >= 0 AND file_debit_total >= 0`),
  ],
);

export type BankStatement = typeof bankStatementsTable.$inferSelect;
