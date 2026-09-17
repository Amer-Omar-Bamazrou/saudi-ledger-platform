/**
 * D-3 / G3 — THE CASH CUT-OVER'S EVIDENCE, under the ANNOTATION model (2026-09-17).
 *
 * ── The model ──────────────────────────────────────────────────────────────
 * A posted journal line is immutable. The per-bank cut-over therefore never
 * rewrites a historical line's account: history stays on "Cash and Bank"
 * (the header) exactly as it was posted, and its BANK IDENTITY is carried
 * BESIDE it — one row here per attributed line, naming the bank the source
 * evidence established and the rule that established it. New postings go
 * straight to the bank's own GL leaf, whose `categories.bank_account_id` is
 * their bank identity. The ONE resolver of "which bank does this cash line
 * belong to" is the view `journal_line_bank_identity` (migration 0073): leaf
 * first, attribution second, never both — every per-bank reader joins it and
 * nothing else re-derives the answer.
 *
 * ── Historical ACCOUNT identity vs historical BANK identity ───────────────
 * `account_id` / `account_name` here record the account the line SITS ON at
 * attribution time (the header, as posted) — the accounting identity, which
 * this table never alters. `bank_account_id` / `gl_account_id` record the bank
 * identity and the bank's own leaf — the reporting identity. The two are
 * different facts and stay in different columns.
 *
 * ── Why a separate table and not a column on journal_entry_lines ──────────
 * The pack proposed `journal_entry_lines.bank_account_id`. A column would be a
 * SECOND place bank identity lives (the leaf is the first), writable by any
 * line writer, and would sit on the immutable row itself. A one-row-per-line
 * table (UNIQUE on line_id) keeps the posted row untouched, keeps the evidence
 * (rule, run, classification) with the fact, and is append-only for the app
 * role — the migration cannot quietly amend what it once decided.
 *
 * Tenant-scoped with the N1 company arm: a cut-over is a per-COMPANY act.
 */
import { pgTable, serial, integer, text, jsonb, numeric, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { journalEntryLinesTable, journalEntriesTable } from "./journalEntries";
import { categoriesTable } from "./categories";
import { bankAccountsTable } from "./bankAccounts";

export const cashCutoverRunsTable = pgTable(
  "cash_cutover_runs",
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
    /** `dry_run` | `commit` */
    mode: text("mode").notNull(),
    /** `clean` | `blocked` | `committed` | `nothing_to_do` */
    state: text("state").notNull(),
    /** Per-classification counts: { DETERMINISTIC, AMBIGUOUS_REQUIRES_REVIEW, UNMAPPABLE, INCONSISTENT }. */
    counts: jsonb("counts").notNull(),
    /** The full classified report (every unattributed line, every blocking record's fields) as the run saw it. */
    report: jsonb("report").notNull(),
    /** Σ cash-classified GL balance for the company before the run, to the halala. */
    cashBefore: numeric("cash_before", { precision: 15, scale: 2 }).notNull(),
    /** …and after. Equal by invariant: an attribution changes no balance. */
    cashAfter: numeric("cash_after", { precision: 15, scale: 2 }).notNull(),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("cash_cutover_runs_company_idx").on(t.companyId)],
);

export const cashLineBankAttributionsTable = pgTable(
  "cash_line_bank_attributions",
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
    /** The run that established it; NULL for an attribution copied onto a reversal mirror by the reversal path. */
    runId: integer("run_id").references(() => cashCutoverRunsTable.id),
    /** The attributed line. UNIQUE: a line's bank identity is established once, ever — the idempotency backstop. */
    lineId: integer("line_id").notNull().references(() => journalEntryLinesTable.id),
    journalEntryId: integer("journal_entry_id").notNull().references(() => journalEntriesTable.id),
    /** The ACCOUNTING identity: the account the line sits on, as posted. Never changed by this table. */
    accountId: integer("account_id").notNull().references(() => categoriesTable.id),
    accountName: text("account_name").notNull(),
    /** The BANK identity the evidence established, and that bank's own GL leaf. */
    bankAccountId: integer("bank_account_id").notNull().references(() => bankAccountsTable.id),
    glAccountId: integer("gl_account_id").notNull().references(() => categoriesTable.id),
    /** Always DETERMINISTIC on an attributed line; stored so the evidence is self-describing. */
    classification: text("classification").notNull(),
    /** The rule that established the bank: A0 payment record, A1 transaction, A2 settlement pairing, A3 mirror of an attributed original. */
    rule: text("rule").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("cash_line_bank_attributions_line_unq").on(t.lineId), index("cash_line_bank_attributions_run_idx").on(t.runId), index("cash_line_bank_attributions_bank_idx").on(t.bankAccountId)],
);

export type CashCutoverRun = typeof cashCutoverRunsTable.$inferSelect;
export type CashLineBankAttribution = typeof cashLineBankAttributionsTable.$inferSelect;
