/**
 * Batch 1B Part 2, Phase D (2026-09-17) — BANK STATEMENT ↔ PAYMENT MATCHING.
 *
 * A statement row (`transactions`) is a BANK movement; a payment is the
 * ACCOUNTING event; a refund is the money-out accounting event. A match
 * links one row to one of them. It is reconciliation identity, never an
 * accounting event: no journal is created, and no posted line is rewritten
 * because a row was matched (decision pack §3, §4).
 *
 *   method       `deterministic` — every piece of evidence held (same bank,
 *                 same direction, exact amount, an identifying reference
 *                 resolving uniquely, date inside the window, exactly one
 *                 candidate, one-to-one); `manual` — a human's override with
 *                 a reason; `settlement` — the row was settled from Review
 *                 and the payment was created FROM it (source_transaction_id).
 *   evidence     what was seen: the reference token, the window, the
 *                 candidate count, the pairing group — enough to re-check.
 *
 * Append-only. A wrong match is superseded by a `statement_match_reversals`
 * row (one per match), never edited or deleted. "One ACTIVE match per row
 * and per target" is enforced by a DB trigger with its own advisory lock
 * (migration 0076) — a future caller that forgets the service lock is still
 * refused by the database.
 */
import { pgTable, serial, integer, text, jsonb, timestamp, uuid, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { transactionsTable } from "./transactions";
import { paymentsTable, customerRefundsTable } from "./payments";

export const statementMatchesTable = pgTable(
  "statement_matches",
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
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactionsTable.id, { onDelete: "cascade" }),
    paymentId: integer("payment_id").references(() => paymentsTable.id, { onDelete: "cascade" }),
    refundId: integer("refund_id").references(() => customerRefundsTable.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    evidence: jsonb("evidence").notNull(),
    reason: text("reason"),
    idempotencyKey: text("idempotency_key"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("statement_matches_idempotency_unq").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
    index("statement_matches_transaction_idx").on(t.transactionId),
    index("statement_matches_payment_idx").on(t.paymentId),
    index("statement_matches_refund_idx").on(t.refundId),
    check("statement_matches_one_target_chk", sql`(payment_id IS NOT NULL) <> (refund_id IS NOT NULL)`),
    check("statement_matches_method_chk", sql`method IN ('deterministic', 'manual', 'settlement')`),
    check("statement_matches_manual_reason_chk", sql`method <> 'manual' OR (reason IS NOT NULL AND length(trim(reason)) > 0)`),
  ],
);

export const statementMatchReversalsTable = pgTable(
  "statement_match_reversals",
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
    matchId: integer("match_id")
      .notNull()
      .references(() => statementMatchesTable.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("statement_match_reversals_match_unq").on(t.matchId)],
);

export type StatementMatch = typeof statementMatchesTable.$inferSelect;
export type StatementMatchReversal = typeof statementMatchReversalsTable.$inferSelect;
