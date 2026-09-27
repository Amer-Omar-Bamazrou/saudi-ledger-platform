/**
 * PHASE 12D — BANK RECONCILIATION AS OF A DATE, CASH POSITION, AND THE
 * BANKING EXCEPTIONS (2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §6.
 * Schema and the identity: packages/db/src/schema/bankReconciliations.ts.
 *
 * 🔴 NO PLUG. A reconciliation is recorded only when
 *     statement balance − (ledger balance − ledger-only + statement-only) = 0
 * to the halala, recomputed under the company's reconciliation lock at the
 * moment it is recorded. The difference is shown, itemised, and left for a
 * person to FIND; nothing here books it.
 */
import { eq } from "drizzle-orm";
import { db, bankStatementsTable } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { BusinessRuleError, NotFoundError } from "../../lib/errors.js";
import { round2, money2 } from "../../lib/money.js";
import { auditService } from "../audit.service.js";
import { assertBankAccount } from "./bankIdentity.js";
import { bankReconciliationsRepository as repo, type LedgerOnlyItem, type StatementOnlyItem } from "../../repositories/bankReconciliations.repository.js";
import { bankStatementsService } from "./bankStatements.service.js";

const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): never => {
  throw new BusinessRuleError(status, { code, error, ...extra });
};
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const TOLERANCE = 0.005;

const ledgerItemOut = (r: LedgerOnlyItem) => {
  const signed = Number(r.signed_amount);
  const outstanding = round2(Number(r.outstanding));
  return {
    journalLineId: Number(r.line_id), journalEntryId: Number(r.journal_entry_id), entryNumber: r.entry_number,
    date: r.date, description: r.description,
    direction: signed >= 0 ? ("in" as const) : ("out" as const),
    lineAmount: round2(Math.abs(signed)), outstanding,
    /** The item's effect on the identity (signed, money in positive). */
    signedOutstanding: signed >= 0 ? outstanding : -outstanding,
  };
};
const statementItemOut = (r: StatementOnlyItem) => {
  const signed = Number(r.signed_amount);
  const outstanding = round2(Number(r.outstanding));
  return {
    transactionId: Number(r.transaction_id), date: r.date, description: r.description,
    direction: signed >= 0 ? ("in" as const) : ("out" as const),
    lineAmount: round2(Math.abs(signed)), outstanding,
    signedOutstanding: signed >= 0 ? outstanding : -outstanding,
    reviewStatus: r.review_status, kind: r.kind,
  };
};

export const bankReconciliationsService = {
  /**
   * The reconciliation's terms for one bank as of a date. `statementBalance`
   * is the bank's closing balance at that date — typed by the person, or read
   * from an imported statement that states one.
   */
  async position(q: { bankAccountId?: unknown; asOf?: unknown; statementBalance?: unknown; bankStatementId?: unknown }) {
    const bankAccountId = await assertBankAccount(q.bankAccountId, { what: "to reconcile" });
    let asOf = isDate(q.asOf) ? q.asOf : null;
    let statementBalance: number | null = q.statementBalance != null && q.statementBalance !== "" ? Number(q.statementBalance) : null;
    let bankStatementId: number | null = null;

    if (q.bankStatementId != null && q.bankStatementId !== "") {
      const [s] = await db.select().from(bankStatementsTable).where(eq(bankStatementsTable.id, Number(q.bankStatementId))).limit(1);
      if (!s) throw new NotFoundError("Statement not found.");
      if (s.bankAccountId !== bankAccountId) refuse(422, "statement_other_bank", "That statement belongs to another bank account.");
      if (s.closingBalance == null) refuse(422, "statement_has_no_closing_balance", "That statement was imported without a closing balance. Type the closing balance from the bank's statement instead.");
      if (asOf && asOf !== s.periodTo) refuse(422, "statement_date_mismatch", `That statement closes on ${s.periodTo}, not ${asOf}.`);
      if (statementBalance != null && Math.abs(statementBalance - Number(s.closingBalance)) > TOLERANCE) {
        refuse(422, "statement_balance_mismatch", `That statement's closing balance is ${Number(s.closingBalance).toFixed(2)}, not ${statementBalance.toFixed(2)}.`);
      }
      asOf = s.periodTo;
      statementBalance = Number(s.closingBalance);
      bankStatementId = s.id;
    }
    if (!asOf) asOf = businessToday();
    if (statementBalance != null && !Number.isFinite(statementBalance)) refuse(422, "statement_balance_invalid", "The statement balance is a number.");

    const [ledgerBalance, ledgerOnlyRows, statementOnlyRows, latest] = await Promise.all([
      repo.ledgerBalance(bankAccountId, asOf), repo.ledgerOnly(bankAccountId, asOf), repo.statementOnly(bankAccountId, asOf),
      repo.latestActive(bankAccountId),
    ]);
    const ledgerOnly = ledgerOnlyRows.map(ledgerItemOut);
    const statementOnly = statementOnlyRows.map(statementItemOut);
    const ledgerOnlyTotal = round2(ledgerOnly.reduce((s, i) => s + i.signedOutstanding, 0));
    const statementOnlyTotal = round2(statementOnly.reduce((s, i) => s + i.signedOutstanding, 0));
    const expectedStatement = round2(ledgerBalance - ledgerOnlyTotal + statementOnlyTotal);
    const difference = statementBalance == null ? null : round2(statementBalance - expectedStatement);
    return {
      bankAccountId, asOf, bankStatementId,
      statementBalance: statementBalance == null ? null : round2(statementBalance),
      ledgerBalance: round2(ledgerBalance), ledgerOnlyTotal, statementOnlyTotal, expectedStatement,
      /** null when no statement balance was given — never a zero that reads as "balanced". */
      difference,
      balanced: difference != null && Math.abs(difference) < TOLERANCE,
      reconciledThrough: latest?.as_of ?? null,
      ledgerOnly, statementOnly,
    };
  },

  /** Record a completed reconciliation — only at a zero difference, only after the last one. */
  async complete(body: { bankAccountId?: unknown; asOf?: unknown; statementBalance?: unknown; bankStatementId?: unknown; notes?: unknown }, userId: number | null) {
    // Serialise with every reconciliation write in the company (the link and
    // match triggers take the same lock), so nothing moves between the
    // computation and the record.
    await repo.lockCompany();
    const p = await this.position(body);
    if (p.statementBalance == null) refuse(422, "statement_balance_required", "Give the bank's closing balance at this date (or choose a statement that states one).");
    if (p.reconciledThrough && p.asOf <= p.reconciledThrough) {
      refuse(409, "already_reconciled_through", `This bank is reconciled through ${p.reconciledThrough}. A new reconciliation must be dated after it — or reopen that one first.`);
    }
    if (!p.balanced) {
      refuse(409, "reconciliation_difference", `The statement balance and the books differ by ${p.difference!.toFixed(2)} at ${p.asOf}. Find the difference — a missing line, an unrecorded movement, a wrong link — before completing; there is no adjustment account.`, { difference: p.difference });
    }
    const [row] = await repo.insert({
      bankAccountId: p.bankAccountId, asOf: p.asOf, bankStatementId: p.bankStatementId,
      statementBalance: money2(p.statementBalance!), ledgerBalance: money2(p.ledgerBalance),
      ledgerOnlyTotal: money2(p.ledgerOnlyTotal), statementOnlyTotal: money2(p.statementOnlyTotal),
      difference: money2(0),
      snapshot: { ledgerOnly: p.ledgerOnly, statementOnly: p.statementOnly, expectedStatement: p.expectedStatement },
      notes: typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null,
      completedBy: userId,
    });
    await auditService.record({ action: "complete", entityType: "bank_reconciliation", entityId: String(row!.id), before: null,
      after: { bankAccountId: p.bankAccountId, asOf: p.asOf, statementBalance: p.statementBalance, ledgerBalance: p.ledgerBalance, ledgerOnly: p.ledgerOnly.length, statementOnly: p.statementOnly.length } });
    return this.get(row!.id);
  },

  /** Reopen the LATEST completed reconciliation of its bank, with a reason. */
  async reopen(id: number, body: { reason?: unknown }, userId: number | null) {
    await repo.lockCompany();
    const r = await this.get(id);
    if (r.reopening) refuse(409, "already_reopened", "This reconciliation is already reopened.");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) refuse(422, "reason_required", "Say why this reconciliation is being reopened.", { field: "reason" });
    const latest = await repo.latestActive(r.bankAccountId);
    if (latest && latest.id !== id) {
      refuse(409, "not_latest", `A later reconciliation (through ${latest.as_of}) stands on this one. Reopen that one first.`);
    }
    await repo.insertReopening({ reconciliationId: id, reason, reopenedBy: userId });
    await auditService.record({ action: "reopen", entityType: "bank_reconciliation", entityId: String(id), before: null, after: { reason } });
    return this.get(id);
  },

  async list(q: { bankAccountId?: number } = {}) {
    return { reconciliations: (await repo.list(q.bankAccountId)).map(out) };
  },

  async get(id: number) {
    const found = (await repo.list()).find((r) => Number(r.id) === id);
    if (!found) throw new NotFoundError("Reconciliation not found.");
    return out(found);
  },

  /**
   * Cash position per bank: the ledger balance (the ONE definition — the same
   * view as every report), the latest statement's closing balance and the
   * ledger at that statement's date beside it, what is still unreconciled,
   * and how far the bank is reconciled. 🔴 The difference is reported only
   * where a statement states a balance; otherwise NOT KNOWN, never zero.
   */
  async cashPosition() {
    const today = businessToday();
    const rows = await repo.cashPosition(today);
    const banks = rows.map((r) => {
      const statementClosing = r.statement_closing == null ? null : Number(r.statement_closing);
      const ledgerAtStatement = r.ledger_at_statement == null ? null : Number(r.ledger_at_statement);
      return {
        bankAccountId: Number(r.id), name: r.name, bankName: r.bank_name, currency: r.currency, isActive: r.is_active,
        ledgerBalance: round2(Number(r.ledger_balance)),
        latestStatement: r.statement_id == null ? null : {
          id: Number(r.statement_id), periodTo: r.statement_to!, closingBalance: round2(statementClosing!),
          ledgerAtThatDate: round2(ledgerAtStatement!),
          /** Statement minus ledger at the statement's date — BEFORE reconciling items; the reconciliation explains it. */
          grossDifference: round2(statementClosing! - ledgerAtStatement!),
        },
        unreconciledLines: Number(r.unreconciled_lines), partialLines: Number(r.partial_lines),
        outstandingIn: round2(Number(r.outstanding_in)), outstandingOut: round2(Number(r.outstanding_out)),
        reconciledThrough: r.reconciled_through,
      };
    });
    return {
      asOf: today, banks,
      // A total only across one currency; the product's banks are SAR (M-currency guard at create).
      totalLedgerBalance: round2(banks.filter((b) => b.isActive && b.currency === "SAR").reduce((s, b) => s + b.ledgerBalance, 0)),
    };
  },

  /**
   * The banking exceptions a person should look at, each with where to go:
   *  · statement continuity breaks (12A): a gap, an overlap, a balance that does not carry;
   *  · statement lines unreconciled for more than 30 days, and partial ones;
   *  · Transfer clearing not netting to zero (an own-account leg with no partner);
   *  · recorded transfers with fewer than both legs reconciled after 30 days;
   *  · ledger cash lines older than 30 days that no statement line answers.
   * 🔴 Each list is capped at 200 and carries its TRUE total beside it.
   */
  async exceptions() {
    const today = businessToday();
    const stale = shift(today, -STALE_DAYS);
    const { items } = await bankStatementsService.list();
    const continuity = items
      .filter((s) => s.continuity === "gap" || s.continuity === "overlap" || s.continuity === "balance_break")
      .map((s) => ({ statementId: s.id, bankAccountId: s.bankAccountId, periodFrom: s.periodFrom, periodTo: s.periodTo, continuity: s.continuity, detail: s.continuityDetail }));
    const x = await repo.exceptions(stale, EXCEPTION_CAP);
    const clearingBalance = round2(x.clearing.balance);
    return {
      asOf: today, staleAfterDays: STALE_DAYS, cap: EXCEPTION_CAP,
      continuity,
      lines: {
        total: x.lines.total,
        items: x.lines.rows.map((r) => ({
          transactionId: r.id, bankAccountId: r.bank_account_id, date: r.date, description: r.description,
          direction: r.type === "credit" ? ("in" as const) : ("out" as const), amount: Number(r.amount), reconciled: round2(Number(r.reconciled)),
          kind: Number(r.reconciled) > TOLERANCE ? ("partial" as const) : ("stale" as const),
        })),
      },
      transferClearing: { balance: clearingBalance, lines: x.clearing.lines, nets: Math.abs(clearingBalance) < TOLERANCE },
      transfersMissingLegs: x.transfers.map((r) => ({
        transferId: r.id, transferDate: r.transfer_date, amount: Number(r.amount), from: r.from_name, to: r.to_name, reconciledLegs: r.reconciled,
      })),
      ledgerLines: {
        total: x.ledger.total,
        items: x.ledger.rows.map((r) => ({
          journalLineId: r.line_id, journalEntryId: r.journal_entry_id, bankAccountId: r.bank_account_id, entryNumber: r.entry_number, date: r.date,
          amount: Number(r.amount), outstanding: round2(Number(r.outstanding)),
        })),
      },
    };
  },
};

const STALE_DAYS = 30;
const EXCEPTION_CAP = 200;

function shift(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const out = (r: Awaited<ReturnType<typeof repo.list>>[number]) => ({
  id: Number(r.id), bankAccountId: Number(r.bank_account_id), bankName: r.bank_name, asOf: r.as_of,
  bankStatementId: r.bank_statement_id == null ? null : Number(r.bank_statement_id),
  statementBalance: Number(r.statement_balance), ledgerBalance: Number(r.ledger_balance),
  ledgerOnlyTotal: Number(r.ledger_only_total), statementOnlyTotal: Number(r.statement_only_total), difference: Number(r.difference),
  snapshot: r.snapshot as Record<string, unknown>, notes: r.notes, completedBy: r.completed_by, createdAt: r.created_at,
  reopening: r.reopen_reason != null ? { reason: r.reopen_reason, reopenedAt: r.reopened_at! } : null,
});
