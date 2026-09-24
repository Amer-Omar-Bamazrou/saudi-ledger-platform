/**
 * PHASE 12A — BANK STATEMENTS: WHAT THE BANK SENT, AS A RECORD (2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §3.
 *
 * A statement upload is ALL OR NOTHING. Every row is validated before the
 * first one is written, because a statement's balances only mean something
 * about the WHOLE file: import half of it and the stated closing balance
 * describes lines the books do not have.
 *
 * Three refusals, each a PRODUCT DECISION stricter than both reference
 * implementations (pack §2.3):
 *
 *   statement_does_not_balance  opening + Σ credits − Σ debits ≠ closing, over
 *                               EVERY line in the file. Odoo computes the same
 *                               test as a flag (`is_complete`) and imports
 *                               anyway; a file that contradicts itself is a
 *                               truncated export, and importing it would make
 *                               the next reconciliation fail for a reason
 *                               nobody could see at import time.
 *   statement_already_imported  the same file (SHA-256) for the same bank.
 *                               ERPNext has no guard at all. Idempotent in
 *                               effect: nothing is written, and the refusal
 *                               names the statement the file already made.
 *   statement_rows_invalid      any row that could not be imported — named,
 *                               all of them, with nothing written.
 *
 * And one thing deliberately NOT refused: CONTINUITY with the previous
 * statement (a gap, an overlap, an opening that is not the last closing). It
 * is REPORTED on every read. A missing statement is a fact the user must see
 * and fix by importing it — refusing the next one would only hide it.
 * (Odoo reaches the same place: `is_valid` is a flag, not a constraint.)
 */
import { BusinessRuleError, NotFoundError } from "../../lib/errors.js";
import { round2 } from "../../lib/money.js";
import { assertDateString } from "../../lib/writeGuards.js";
import { bankStatementsRepository } from "../../repositories/bankStatements.repository.js";
import type { BankStatement } from "@workspace/db";

const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): never => {
  throw new BusinessRuleError(status, { code, error, ...extra });
};

function pgError(err: unknown): { code?: string; constraint?: string } {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return e?.code ? e : (e?.cause ?? {});
}

export interface StatementInput {
  fileName?: string | null;
  fileSha256?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  openingBalance?: number | null;
  closingBalance?: number | null;
}

export interface StatementRow {
  date: unknown;
  description?: unknown;
  amount: unknown;
  type: unknown;
  currency?: unknown;
}

export type Continuity = "first" | "continuous" | "gap" | "overlap" | "balance_break" | "unknown";

/** The day after a YYYY-MM-DD date, as YYYY-MM-DD. */
function nextDay(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

const num = (v: unknown) => (v == null ? null : Number(v));

export function toStatementOut(s: BankStatement, importedCount: number, continuity: Continuity = "first", continuityDetail: string | null = null) {
  return {
    id: s.id, bankAccountId: s.bankAccountId,
    periodFrom: s.periodFrom, periodTo: s.periodTo,
    openingBalance: num(s.openingBalance), closingBalance: num(s.closingBalance),
    source: s.source as "file_upload" | "manual_entry",
    fileName: s.fileName, fileSha256: s.fileSha256,
    lineCount: s.lineCount,
    fileCreditTotal: Number(s.fileCreditTotal), fileDebitTotal: Number(s.fileDebitTotal),
    importedCount: Number(importedCount),
    continuity, continuityDetail,
    createdAt: s.createdAt.toISOString(),
  };
}

/**
 * How `curr` follows `prev` for the same bank. Dates first (a missing or
 * overlapping period is the more basic fact), then balances.
 */
export function continuityOf(prev: BankStatement | null, curr: BankStatement): { continuity: Continuity; detail: string | null } {
  if (!prev) return { continuity: "first", detail: null };
  const expected = nextDay(prev.periodTo);
  if (curr.periodFrom > expected) {
    return { continuity: "gap", detail: `No statement covers ${expected} to the day before ${curr.periodFrom}.` };
  }
  if (curr.periodFrom < expected) {
    return { continuity: "overlap", detail: `This statement starts ${curr.periodFrom}, inside the previous one (to ${prev.periodTo}).` };
  }
  if (prev.closingBalance == null || curr.openingBalance == null) {
    return { continuity: "unknown", detail: "One of the two statements states no balance, so the hand-over cannot be checked." };
  }
  const diff = round2(Number(curr.openingBalance) - Number(prev.closingBalance));
  if (Math.abs(diff) >= 0.005) {
    return { continuity: "balance_break", detail: `Opens at ${Number(curr.openingBalance).toFixed(2)}; the previous statement closed at ${Number(prev.closingBalance).toFixed(2)} (difference ${diff.toFixed(2)}).` };
  }
  return { continuity: "continuous", detail: null };
}

/**
 * Validate a statement against EVERY row it carries, before anything is
 * written. Returns the values to insert; throws a 4xx naming every problem.
 */
async function prepareStatement(bankAccountId: number, input: StatementInput, rows: StatementRow[]) {
    const problems: string[] = [];
    let credit = 0, debit = 0;
    const dates: string[] = [];
    rows.forEach((r, i) => {
      const label = `Row ${i + 1}${r.description ? ` ("${String(r.description).trim().slice(0, 40)}")` : ""}`;
      const date = typeof r.date === "string" ? r.date : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { problems.push(`${label}: the date is not YYYY-MM-DD.`); return; }
      if (!String(r.description ?? "").trim()) problems.push(`${label}: the description is empty.`);
      const amount = Number(r.amount);
      if (!Number.isFinite(amount) || amount <= 0) problems.push(`${label}: the amount must be a positive number (the direction is the type).`);
      if (r.type !== "debit" && r.type !== "credit") problems.push(`${label}: the type must be debit or credit.`);
      const currency = String(r.currency ?? "SAR").toUpperCase();
      if (currency !== "SAR") problems.push(`${label}: the amount is in ${currency}; statements are imported in SAR only.`);
      dates.push(date);
      if (Number.isFinite(amount) && amount > 0) {
        if (r.type === "credit") credit = round2(credit + amount);
        if (r.type === "debit") debit = round2(debit + amount);
      }
    });

    const sortedDates = [...dates].sort();
    const periodFrom = input.periodFrom ? assertDateString(input.periodFrom, "statement.periodFrom") : sortedDates[0];
    const periodTo = input.periodTo ? assertDateString(input.periodTo, "statement.periodTo") : sortedDates[sortedDates.length - 1];
    if (!periodFrom || !periodTo) {
      refuse(422, "statement_period_required", "A statement with no lines must state the period it covers (periodFrom and periodTo).", { field: "statement.periodFrom" });
    }
    if (periodFrom! > periodTo!) refuse(422, "statement_period_inverted", `The statement period starts (${periodFrom}) after it ends (${periodTo}).`, { field: "statement.periodFrom" });
    for (const d of dates) {
      if (d < periodFrom! || d > periodTo!) problems.push(`A line dated ${d} is outside the statement period ${periodFrom} to ${periodTo}.`);
    }
    if (problems.length > 0) {
      refuse(422, "statement_rows_invalid", `The statement was not imported — ${problems.length} line(s) could not be. A statement is imported whole or not at all, because its balances describe every line.`, { problems });
    }

    const hasOpening = input.openingBalance != null;
    const hasClosing = input.closingBalance != null;
    if (hasOpening !== hasClosing) {
      refuse(422, "statement_balances_incomplete", "State both the opening and the closing balance, or neither — one alone cannot be checked.", { field: hasOpening ? "statement.closingBalance" : "statement.openingBalance" });
    }
    let opening: number | null = null, closing: number | null = null;
    if (hasOpening) {
      opening = round2(Number(input.openingBalance));
      closing = round2(Number(input.closingBalance));
      if (!Number.isFinite(opening) || !Number.isFinite(closing)) refuse(422, "statement_balance_invalid", "The statement balances must be numbers.");
      const expected = round2(opening + credit - debit);
      if (Math.abs(expected - closing) >= 0.005) {
        refuse(422, "statement_does_not_balance",
          `The file does not agree with its own balances: it opens at ${opening.toFixed(2)}, its lines add ${credit.toFixed(2)} and take ${debit.toFixed(2)}, which closes at ${expected.toFixed(2)} — not the stated ${closing.toFixed(2)} (difference ${round2(closing - expected).toFixed(2)}). The export is usually incomplete; nothing was imported.`,
          { opening, credits: credit, debits: debit, expectedClosing: expected, statedClosing: closing, difference: round2(closing - expected) });
      }
    }

    const sha = input.fileSha256 ? String(input.fileSha256).trim().toLowerCase() : null;
    if (sha && !/^[0-9a-f]{64}$/.test(sha)) refuse(422, "statement_sha_invalid", "fileSha256 must be the file's SHA-256 as 64 hex characters.", { field: "statement.fileSha256" });
    if (sha) {
      const [prior] = await bankStatementsRepository.findByFile(bankAccountId, sha);
      if (prior) {
        refuse(409, "statement_already_imported",
          `This file was already imported for this bank as statement #${prior.id} (${prior.periodFrom} to ${prior.periodTo}). Nothing was imported again.`,
          { statementId: prior.id });
      }
    }

    return {
      bankAccountId, periodFrom: periodFrom!, periodTo: periodTo!,
      openingBalance: opening == null ? null : opening.toFixed(2),
      closingBalance: closing == null ? null : closing.toFixed(2),
      source: sha ? "file_upload" : "manual_entry",
      fileName: input.fileName?.trim() || null,
      fileSha256: sha,
      lineCount: rows.length,
      fileCreditTotal: credit.toFixed(2),
      fileDebitTotal: debit.toFixed(2),
    };
}

export type PreparedStatement = Awaited<ReturnType<typeof prepareStatement>>;

export const bankStatementsService = {
  prepare: prepareStatement,

  /** Write the prepared statement. The UNIQUE index is the backstop for two concurrent uploads of one file. */
  async record(values: PreparedStatement, userId: number | null): Promise<BankStatement> {
    try {
      const [row] = await bankStatementsRepository.insert({ ...values, createdBy: userId });
      return row!;
    } catch (err) {
      if (pgError(err).code === "23505") {
        refuse(409, "statement_already_imported", "This file was imported for this bank by another request a moment ago. Nothing was imported again.");
      }
      throw err;
    }
  },

  /** Statements, oldest first per bank, each with its continuity. */
  async list(bankAccountId?: number) {
    const rows = await bankStatementsRepository.list(bankAccountId);
    let prev: BankStatement | null = null;
    const items = rows.map(({ s, importedCount }) => {
      const p: BankStatement | null = prev && prev.bankAccountId === s.bankAccountId ? prev : null;
      const c = continuityOf(p, s);
      prev = s;
      return toStatementOut(s, importedCount, c.continuity, c.detail);
    });
    return { items };
  },

  async get(id: number) {
    const [row] = await bankStatementsRepository.findById(id);
    if (!row) throw new NotFoundError("Statement not found.");
    const all = await this.list(row.s.bankAccountId);
    return all.items.find((s) => s.id === id)!;
  },
};
