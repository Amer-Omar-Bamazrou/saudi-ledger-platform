/**
 * PHASE 12C — BANK-TO-BANK TRANSFERS (2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §5.
 * Schema and the full reasoning: packages/db/src/schema/bankTransfers.ts.
 *
 * One transfer is ONE entry with two cash lines (Dr destination leaf, Cr
 * source leaf). Its statement legs are RECONCILED to those lines, never
 * accepted to post. No P&L, no VAT, no clearing account on this path: the
 * money never left the business, and both sides are known when it is
 * recorded.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { db, bankTransfersTable, bankTransferReversalsTable, bankAccountsTable } from "@workspace/db";
import { BusinessRuleError, NotFoundError } from "../../lib/errors.js";
import { round2 } from "../../lib/money.js";
import { businessToday } from "@workspace/shared";
import { auditService } from "../audit.service.js";
import { postJournalEntry } from "./glPosting.js";
import { checkPeriodOpen } from "./periodLock.js";
import { assertBankAccount } from "./bankIdentity.js";
import { journalEntriesService } from "../journalEntries.service.js";
import { MATCH_DATE_WINDOW_DAYS } from "./matchingPolicy.js";

/**
 * How near in date a prior transfer (or clearing leg) must be to count as a
 * possible duplicate — the matching policy's window, not a second definition
 * (acceptance uses the same one to recognise a recorded transfer's leg).
 */
export const TRANSFER_DUPLICATE_WINDOW_DAYS = MATCH_DATE_WINDOW_DAYS;

const refuse = (code: string, error: string, field?: string, status = 422, extra: Record<string, unknown> = {}): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}), ...extra });
};

/** N1: the query layer names the company too, not only RLS. */
const scoped = (alias: string) => sql.raw(`${alias}.company_id::text = current_setting('app.current_company_id', true)`);

const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export interface PossibleDuplicate {
  kind: "bank_transfer" | "clearing_leg";
  id: number;
  date: string;
  amount: number;
  bankAccountId: number;
  description: string;
}

type TransferRow = {
  id: number; from_bank_account_id: number; to_bank_account_id: number; from_name: string; to_name: string;
  amount: string; transfer_date: string; reference: string | null; memo: string | null; journal_entry_id: number;
  entry_number: string; duplicate_confirmation_reason: string | null; created_at: string;
  reversal_reason: string | null; reversal_entry_id: number | null; reversed_at: string | null; reconciled_lines: number; total: number;
};

/** The one read of a transfer — with its banks, entry, reversal and how many of its cash lines are reconciled. */
async function readTransfers(tail: SQL) {
  const { rows } = await db.execute<TransferRow>(sql`
    SELECT bt.id, bt.from_bank_account_id, bt.to_bank_account_id, fa.name AS from_name, ta.name AS to_name,
           bt.amount::text AS amount, bt.transfer_date::text AS transfer_date, bt.reference, bt.memo,
           bt.journal_entry_id, e.entry_number, bt.duplicate_confirmation_reason, bt.created_at::text AS created_at,
           r.reason AS reversal_reason, r.reversal_journal_entry_id AS reversal_entry_id, r.created_at::text AS reversed_at,
           (SELECT count(DISTINCT x.line_id)::int FROM bank_line_reconciliation x
              JOIN journal_entry_lines l ON l.id = x.line_id WHERE l.journal_entry_id = bt.journal_entry_id) AS reconciled_lines,
           count(*) OVER ()::int AS total
      FROM bank_transfers bt
      JOIN bank_accounts fa ON fa.id = bt.from_bank_account_id
      JOIN bank_accounts ta ON ta.id = bt.to_bank_account_id
      JOIN journal_entries e ON e.id = bt.journal_entry_id
      LEFT JOIN bank_transfer_reversals r ON r.transfer_id = bt.id
     WHERE ${scoped("bt")}
    ${tail}`);
  return rows;
}

const toTransfer = (r: TransferRow) => ({
  id: Number(r.id),
  fromBankAccountId: Number(r.from_bank_account_id), fromBankName: r.from_name,
  toBankAccountId: Number(r.to_bank_account_id), toBankName: r.to_name,
  amount: Number(r.amount), transferDate: r.transfer_date, reference: r.reference, memo: r.memo,
  journalEntryId: Number(r.journal_entry_id), entryNumber: r.entry_number,
  duplicateConfirmationReason: r.duplicate_confirmation_reason, createdAt: r.created_at,
  reconciledLines: Number(r.reconciled_lines),
  reversal: r.reversal_entry_id != null ? { reason: r.reversal_reason!, reversalJournalEntryId: Number(r.reversal_entry_id), reversedAt: r.reversed_at! } : null,
});

export const bankTransfersService = {
  /**
   * What this transfer might already be: a transfer recorded between the same
   * two banks for the same amount near the date, or a statement leg already
   * accepted as an own-account transfer (which posted the cash through
   * Transfer clearing) on either bank.
   */
  async possibleDuplicates(fromId: number, toId: number, amount: number, date: string): Promise<PossibleDuplicate[]> {
    const w = TRANSFER_DUPLICATE_WINDOW_DAYS;
    const { rows } = await db.execute<{ kind: PossibleDuplicate["kind"]; id: number; date: string; amount: string; bank_account_id: number; description: string }>(sql`
      SELECT 'bank_transfer'::text AS kind, bt.id, bt.transfer_date::text AS date, bt.amount::text AS amount,
             bt.from_bank_account_id AS bank_account_id, coalesce(bt.reference, 'Transfer #' || bt.id) AS description
        FROM bank_transfers bt
       WHERE ${scoped("bt")} AND bt.from_bank_account_id = ${fromId} AND bt.to_bank_account_id = ${toId}
         AND bt.amount = ${amount}
         AND abs(bt.transfer_date - ${date}::date) <= ${w}
         AND NOT EXISTS (SELECT 1 FROM bank_transfer_reversals r WHERE r.transfer_id = bt.id)
      UNION ALL
      SELECT 'clearing_leg', t.id, t.date::date::text, abs(t.amount::numeric)::text, t.bank_account_id, t.description
        FROM transactions t
       WHERE ${scoped("t")} AND t.kind = 'transfer' AND t.transfer_direction = 'own_account'
         AND t.review_status = 'accepted' AND t.journal_entry_id IS NOT NULL
         AND ((t.bank_account_id = ${fromId} AND t.type = 'debit') OR (t.bank_account_id = ${toId} AND t.type = 'credit'))
         AND abs(t.amount::numeric) = ${amount}
         AND abs(t.date::date - ${date}::date) <= ${w}
       ORDER BY 3, 2`);
    return rows.map((r) => ({ kind: r.kind, id: Number(r.id), date: r.date, amount: Number(r.amount), bankAccountId: Number(r.bank_account_id), description: r.description }));
  },

  async create(body: Record<string, unknown>, userId: number | null) {
    const idempotencyKey = text(body.idempotencyKey);
    if (idempotencyKey) {
      const [prior] = await db.select().from(bankTransfersTable).where(eq(bankTransfersTable.idempotencyKey, idempotencyKey)).limit(1);
      if (prior) return this.getById(prior.id);
    }

    const fromId = await assertBankAccount(body.fromBankAccountId, { field: "fromBankAccountId", what: "the money left" });
    const toId = await assertBankAccount(body.toBankAccountId, { field: "toBankAccountId", what: "the money arrived in" });
    if (fromId === toId) refuse("transfer_same_bank", "A transfer moves money between two DIFFERENT bank accounts.", "toBankAccountId");

    const amount = round2(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) refuse("amount_invalid", "A transfer moves a positive amount.", "amount");

    const date = text(body.transferDate) ?? businessToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) refuse("transfer_date_invalid", "The transfer date is a YYYY-MM-DD date.", "transferDate");
    // Checked before anything is written; never re-dated into an open month.
    await checkPeriodOpen(date);

    // 🔴 ONE movement is never recorded twice. A near-identical transfer, or a
    // statement leg already posted through clearing, is refused unless the
    // person confirms it is a DIFFERENT movement and says why.
    // Serialised per bank pair, so two identical requests cannot both pass the
    // duplicate check (the idempotency key covers retries; this covers clicks).
    const [lo, hi] = fromId < toId ? [fromId, toId] : [toId, fromId];
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`bank-transfer:${lo}:${hi}`}))`);
    const duplicates = await this.possibleDuplicates(fromId, toId, amount, date);
    const confirmation = text(body.duplicateConfirmationReason);
    if (duplicates.length > 0 && !(body.confirmDuplicate === true && confirmation)) {
      refuse(
        "possible_duplicate_transfer",
        "This looks like a transfer that is already in the books. If it is a different movement, confirm it and say why.",
        "confirmDuplicate", 409, { duplicates },
      );
    }

    const [from] = await db.select({ name: bankAccountsTable.name }).from(bankAccountsTable).where(eq(bankAccountsTable.id, fromId)).limit(1);
    const [to] = await db.select({ name: bankAccountsTable.name }).from(bankAccountsTable).where(eq(bankAccountsTable.id, toId)).limit(1);
    const reference = text(body.reference);
    const description = `Transfer ${from!.name} → ${to!.name}`;
    const entry = await postJournalEntry({
      entryNumber: `BTR-${fromId}-${toId}-${Date.now()}`,
      date,
      description,
      reference: reference ?? undefined,
      lines: [
        { bankAccountId: toId, description: `Transfer in from ${from!.name}`, debitAmount: amount, creditAmount: 0 },
        { bankAccountId: fromId, description: `Transfer out to ${to!.name}`, debitAmount: 0, creditAmount: amount },
      ],
    });

    const [row] = await db.insert(bankTransfersTable).values({
      fromBankAccountId: fromId, toBankAccountId: toId, amount: String(amount), transferDate: date,
      reference, memo: text(body.memo), journalEntryId: entry.id,
      duplicateConfirmationReason: duplicates.length > 0 ? confirmation : null,
      idempotencyKey, createdBy: userId,
    }).returning();

    await auditService.record({
      entityType: "bank_transfer", entityId: String(row!.id), action: "create", before: null,
      after: { fromBankAccountId: fromId, toBankAccountId: toId, amount, transferDate: date, journalEntryId: entry.id, duplicatesConfirmed: duplicates.length },
    });
    return this.getById(row!.id);
  },

  /**
   * Reverse a transfer: the mirror posts in an OPEN period (journalEntriesService
   * .reverse — the one reversal writer), and a superseding row records why.
   * 🔴 Refused while either cash line is reconciled to a statement line: undo
   * the reconciliation first (the trigger on journal_entries is the boundary;
   * this check only makes the refusal readable).
   */
  async reverse(id: number, body: { reason?: unknown; date?: unknown }, userId: number | null) {
    const t = await this.getById(id);
    if (t.reversal) refuse("transfer_already_reversed", "This transfer is already reversed.", undefined, 409);
    const reason = text(body.reason);
    if (!reason) refuse("reason_required", "Say why this transfer is being reversed.", "reason");
    if (t.reconciledLines > 0) {
      refuse("transfer_reconciled", "A statement line is reconciled to this transfer. Undo that reconciliation before reversing it.", undefined, 409);
    }
    const { reversalId } = await journalEntriesService.reverse(t.journalEntryId, { reason, date: body.date }, { document: "bank_transfer" });
    await db.insert(bankTransferReversalsTable).values({
      transferId: id, reversalJournalEntryId: reversalId, reason: reason!, createdBy: userId,
    });
    await auditService.record({ entityType: "bank_transfer", entityId: String(id), action: "reverse", before: null, after: { reason, reversalJournalEntryId: reversalId } });
    return this.getById(id);
  },

  async list(q: { bankAccountId?: number; limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const offset = Math.max(q.offset ?? 0, 0);
    const bank = q.bankAccountId ? sql`AND (bt.from_bank_account_id = ${q.bankAccountId} OR bt.to_bank_account_id = ${q.bankAccountId})` : sql``;
    const rows = await readTransfers(sql`${bank} ORDER BY bt.transfer_date DESC, bt.id DESC LIMIT ${limit} OFFSET ${offset}`);
    return { transfers: rows.map(toTransfer), total: rows[0]?.total ?? 0, limit, offset };
  },

  async getById(id: number) {
    const [r] = await readTransfers(sql`AND bt.id = ${id}`);
    if (!r) throw new NotFoundError("Transfer not found");
    return toTransfer(r);
  },
};

