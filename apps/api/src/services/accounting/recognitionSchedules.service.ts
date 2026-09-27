/**
 * ACCRUALS AND PREPAYMENTS (Phase 11 A2/A3, 2026-09-22).
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §2, §3.
 *
 * One engine, two directions. What each period recognises is identical
 * arithmetic — `Dr expense / Cr <balance account>` — and the two kinds differ
 * only in which balance-sheet account that is and how the balance got there.
 *
 * 🔴 IAS 37.11 DECIDES THE ACCOUNT, AND IT IS CHECKED HERE. An accrual's
 * balance account must be a LIABILITY and a prepayment's must be an ASSET. The
 * column stores the account rather than deriving it from `kind`, so a tenant
 * can point a schedule at its own chart — which means the TYPE has to be
 * verified at this boundary, because a prepayment sitting on a liability is
 * not a prepayment and no later reader could tell.
 *
 * 🔴 AN ACCRUAL MUST NEVER POST TO AP. AP is the invoiced trade payable,
 * reconciled to supplier statements, aged, and settled by supplier payments.
 * An accrual has no invoice; putting it in AP would create a payable that no
 * statement can match and no payment can settle. Refused by name.
 */
import { and, eq } from "drizzle-orm";
import {
  db, recognitionSchedulesTable, recognitionScheduleRowsTable, categoriesTable,
  type RecognitionSchedule, type RecognitionScheduleRow,
} from "@workspace/db";
import { SYSTEM_ACCOUNTS } from "@workspace/db";
import { BusinessRuleError, NotFoundError } from "../../lib/errors.js";
import { round2, spreadOverPeriods } from "../../lib/money.js";
import { businessToday } from "@workspace/shared";
import { auditService } from "../audit.service.js";
import { postJournalEntry } from "./glPosting.js";
import { periodOf, shiftPeriod, lastDayOf } from "../assets/depreciationSchedule.js";

const refuse = (code: string, error: string, field?: string): never => {
  throw new BusinessRuleError(422, { code, error, ...(field ? { field } : {}) });
};

/** The balance-sheet account each kind requires, by TYPE — the IAS 37.11 consequence. */
const REQUIRED_BALANCE_TYPE: Record<string, string> = { accrual: "liability", prepayment: "asset" };

export const recognitionSchedulesService = {
  /**
   * Create a schedule as a DRAFT. Nothing posts: a draft moves zero in every
   * report, the zero-movement standard every approvable entity in this product
   * replicates.
   */
  async create(body: Record<string, unknown>, userId: number | null) {
    const kind = String(body.kind ?? "");
    if (!["accrual", "prepayment"].includes(kind)) {
      refuse("recognition_kind_unknown", "A recognition schedule is either an 'accrual' (incurred, not yet invoiced — IAS 37.11) or a 'prepayment' (paid before the benefit).", "kind");
    }
    const totalAmount = round2(Number(body.totalAmount));
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      refuse("recognition_amount_invalid", "A schedule recognises a positive amount.", "totalAmount");
    }
    const periods = Math.trunc(Number(body.periods));
    if (!Number.isInteger(periods) || periods < 1) {
      refuse("recognition_periods_invalid", "A schedule runs over at least one whole period.", "periods");
    }
    const startPeriod = String(body.startPeriod ?? "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(startPeriod)) {
      refuse("recognition_start_period_invalid", "The start period is a month, as YYYY-MM.", "startPeriod");
    }
    const description = String(body.description ?? "").trim();
    if (!description) refuse("recognition_description_required", "Say what is being recognised — the description is what a reader sees in the schedule and on every entry it posts.", "description");

    const expenseAccountId = Number(body.expenseAccountId);
    const balanceAccountId = Number(body.balanceAccountId);
    const [expense] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, expenseAccountId)).limit(1);
    const [balance] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, balanceAccountId)).limit(1);
    if (!expense) refuse("expense_account_unknown", "The expense account does not exist in this company's chart.", "expenseAccountId");
    if (!balance) refuse("balance_account_unknown", "The balance-sheet account does not exist in this company's chart.", "balanceAccountId");
    if (expense!.type !== "expense") {
      refuse("expense_account_not_expense", `Recognition debits an EXPENSE account; “${expense!.name}” is ${expense!.type}.`, "expenseAccountId");
    }
    const needed = REQUIRED_BALANCE_TYPE[kind]!;
    if (balance!.type !== needed) {
      refuse(
        "balance_account_type_mismatch",
        kind === "accrual"
          ? `An accrual credits a LIABILITY — what has been received but not yet invoiced (IAS 37.11). “${balance!.name}” is ${balance!.type}.`
          : `A prepayment releases an ASSET — value paid for and not yet consumed. “${balance!.name}” is ${balance!.type}.`,
        "balanceAccountId",
      );
    }
    // 🔴 The one account an accrual may never use.
    if (kind === "accrual" && balance!.systemCode === SYSTEM_ACCOUNTS.AP) {
      refuse(
        "accrual_may_not_use_ap",
        "An accrual cannot be credited to Accounts Payable. AP is the INVOICED trade payable (IAS 37.11): it is reconciled to supplier statements, aged in AP ageing and settled by supplier payments. An accrual has no invoice, so it belongs in Accrued liabilities — a payable in AP that no statement can match and no payment can settle is worse than no accrual at all.",
        "balanceAccountId",
      );
    }

    const reference = String(body.reference ?? "").trim() || `REC-${Date.now()}`;
    const [row] = await db.insert(recognitionSchedulesTable).values({
      reference, kind, description,
      descriptionAr: (body.descriptionAr as string) ?? null,
      vendorId: body.vendorId == null ? null : Number(body.vendorId),
      expenseAccountId, balanceAccountId,
      totalAmount: String(totalAmount),
      periods, startPeriod,
      status: "draft",
      notes: (body.notes as string) ?? null,
      createdBy: userId,
    }).returning();

    await auditService.created("recognition_schedule", row!.id, row);
    return this.getById(row!.id);
  },

  /**
   * Activate: generate the stored schedule and, for a schedule that must raise
   * its own balance, post the opening entry.
   *
   * 🔴 The rows are generated ONCE, here, and frozen as they post. Deriving
   * them on every read would let a later edit to `periods` silently restate
   * months that already reached the GL.
   */
  async activate(id: number, body: { openingDate?: unknown } = {}, userId: number | null) {
    const schedule = await this.findOrThrow(id);
    if (schedule.status !== "draft") {
      throw new BusinessRuleError(409, { code: "recognition_not_draft", error: `This schedule is ${schedule.status}; only a draft can be activated.` });
    }
    const total = Number(schedule.totalAmount);
    const addends = spreadOverPeriods(total, schedule.periods);

    const rows = addends.map((amount, i) => ({
      scheduleId: schedule.id,
      period: shiftPeriod(schedule.startPeriod, i),
      sequence: i + 1,
      amount: String(amount),
    }));
    await db.insert(recognitionScheduleRowsTable).values(rows);

    /**
     * 🔴 THE OPENING ENTRY EXISTS FOR THE ACCRUAL ONLY, and this is the part
     * that is easy to get backwards.
     *
     * An ACCRUAL's liability is raised by the recognition itself: each period
     * posts Dr expense / Cr accrued liabilities, so there is nothing to raise
     * up front. A PREPAYMENT's asset already exists before the schedule does —
     * the cash left, or the bill posted it — so the schedule RELEASES a
     * balance somebody else put there. Posting an opening entry for a
     * prepayment here would create the asset a second time.
     */
    const [updated] = await db.update(recognitionSchedulesTable)
      .set({ status: "active" })
      .where(eq(recognitionSchedulesTable.id, id)).returning();

    await auditService.updated("recognition_schedule", id, schedule, updated);
    void body;
    void userId;
    return this.getById(id);
  },

  /**
   * Recognise ONE period. `Dr expense / Cr balance` for both kinds — the
   * direction is the same; what differs is which account the credit lands on
   * and who raised it.
   */
  async recognise(id: number, body: { period?: unknown }, userId: number | null) {
    const schedule = await this.findOrThrow(id);
    if (schedule.status !== "active") {
      throw new BusinessRuleError(409, { code: "recognition_not_active", error: `This schedule is ${schedule.status}; only an active schedule recognises.` });
    }
    const rows = await this.rowsOf(id);
    const wanted = typeof body.period === "string" && body.period ? body.period : rows.find((r) => r.journalEntryId == null)?.period;
    if (!wanted) {
      throw new BusinessRuleError(409, { code: "recognition_complete", error: "Every period of this schedule has been recognised." });
    }
    const row = rows.find((r) => r.period === wanted);
    if (!row) {
      throw new BusinessRuleError(409, { code: "recognition_period_not_scheduled", error: `${wanted} is not a period of this schedule (${rows[0]?.period} … ${rows.at(-1)?.period}).`, field: "period" });
    }
    if (row.journalEntryId != null) {
      throw new BusinessRuleError(409, { code: "recognition_already_posted", error: `${wanted} has already been recognised on entry ${row.journalEntryId}.` });
    }
    // 🔴 IN ORDER. A schedule recognised out of order leaves a hole that reads
    // exactly like a period nobody has reached yet.
    const firstOpen = rows.find((r) => r.journalEntryId == null)!;
    if (firstOpen.period !== wanted) {
      throw new BusinessRuleError(409, { code: "recognition_out_of_order", error: `Recognise ${firstOpen.period} first — a schedule is recognised in order, or the gap reads like a period nobody has reached yet.` });
    }

    const amount = Number(row.amount);
    const [expense] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, schedule.expenseAccountId)).limit(1);
    const [balance] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, schedule.balanceAccountId)).limit(1);

    /**
     * 🔴 The date is the LAST DAY of the period being recognised — the month
     * the expense belongs to, not the day somebody ran the recognition. A
     * closed month therefore fails closed through `postJournalEntry`'s own
     * `checkPeriodOpen`, LOUDLY, rather than silently landing in today.
     */
    const date = lastDayOf(row.period);
    const entry = await postJournalEntry({
      entryNumber: `${schedule.reference}-${row.period}`,
      date,
      description: `${schedule.kind === "accrual" ? "Accrual" : "Prepayment release"}: ${schedule.description} (${row.period})`,
      reference: schedule.reference,
      lines: [
        { accountId: schedule.expenseAccountId, accountName: expense!.name, description: schedule.description, debitAmount: amount, creditAmount: 0 },
        { accountId: schedule.balanceAccountId, accountName: balance!.name, description: schedule.description, debitAmount: 0, creditAmount: amount },
      ],
    });

    await db.update(recognitionScheduleRowsTable)
      .set({ journalEntryId: entry.id, postedAt: new Date() })
      .where(eq(recognitionScheduleRowsTable.id, row.id));

    // Completed when nothing is left unposted — DERIVED from the rows, never a
    // counter somebody has to remember to increment.
    const after = await this.rowsOf(id);
    if (after.every((r) => r.journalEntryId != null)) {
      await db.update(recognitionSchedulesTable).set({ status: "completed" }).where(eq(recognitionSchedulesTable.id, id));
    }

    await auditService.record({ action: "recognise", entityType: "recognition_schedule", entityId: String(id), before: row, after: { ...row, journalEntryId: entry.id } });
    void userId;
    return { scheduleId: id, period: row.period, amount, journalEntryId: entry.id, date };
  },

  /**
   * Cancel what has NOT been recognised. The posted periods stay: they are in
   * the books, and a cancellation is a decision about the FUTURE.
   *
   * 🔴 It does not reverse anything. Reversing a posted recognition is
   * `journalEntries.reverse` — a separate, deliberate act with its own reason
   * and its own period check. Folding the two together would let "stop this
   * schedule" quietly rewrite closed months.
   */
  async cancel(id: number, body: { reason?: unknown }, userId: number | null) {
    const schedule = await this.findOrThrow(id);
    if (schedule.status === "cancelled") {
      throw new BusinessRuleError(409, { code: "recognition_already_cancelled", error: "This schedule is already cancelled." });
    }
    const reason = String(body.reason ?? "").trim();
    if (!reason) refuse("cancel_reason_required", "Say why the schedule is being stopped — the remaining periods will not be recognised and the record has to say why.", "reason");

    const rows = await this.rowsOf(id);
    const unposted = rows.filter((r) => r.journalEntryId == null);
    for (const r of unposted) {
      await db.delete(recognitionScheduleRowsTable).where(eq(recognitionScheduleRowsTable.id, r.id));
    }
    const [updated] = await db.update(recognitionSchedulesTable)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: reason })
      .where(eq(recognitionSchedulesTable.id, id)).returning();

    await auditService.updated("recognition_schedule", id, schedule, updated);
    void userId;
    return { id, cancelled: unposted.length, keptPosted: rows.length - unposted.length, reason };
  },

  async list(filter: { kind?: string; status?: string } = {}) {
    const rows = await db.select().from(recognitionSchedulesTable)
      .where(and(
        filter.kind ? eq(recognitionSchedulesTable.kind, filter.kind) : undefined,
        filter.status ? eq(recognitionSchedulesTable.status, filter.status) : undefined,
      ))
      .orderBy(recognitionSchedulesTable.id);
    const out = [];
    for (const r of rows) out.push(await this.view(r));
    return { items: out };
  },

  async getById(id: number) {
    const schedule = await this.findOrThrow(id);
    const rows = await this.rowsOf(id);
    return { ...(await this.view(schedule)), rows: rows.map(toRowView) };
  },

  async findOrThrow(id: number): Promise<RecognitionSchedule> {
    const [row] = await db.select().from(recognitionSchedulesTable).where(eq(recognitionSchedulesTable.id, id)).limit(1);
    if (!row) throw new NotFoundError("Recognition schedule not found.");
    return row;
  },

  rowsOf(id: number): Promise<RecognitionScheduleRow[]> {
    return db.select().from(recognitionScheduleRowsTable)
      .where(eq(recognitionScheduleRowsTable.scheduleId, id))
      .orderBy(recognitionScheduleRowsTable.sequence);
  },

  /** 🔴 Recognised and remaining are DERIVED from the posted rows, never stored. */
  async view(s: RecognitionSchedule) {
    const rows = await this.rowsOf(s.id);
    const recognised = round2(rows.filter((r) => r.journalEntryId != null).reduce((a, r) => a + Number(r.amount), 0));
    const total = Number(s.totalAmount);
    return {
      id: s.id, reference: s.reference, kind: s.kind, description: s.description, descriptionAr: s.descriptionAr,
      vendorId: s.vendorId, expenseAccountId: s.expenseAccountId, balanceAccountId: s.balanceAccountId,
      totalAmount: total, periods: s.periods, startPeriod: s.startPeriod, status: s.status,
      recognisedAmount: recognised,
      remainingAmount: round2(total - recognised),
      postedPeriods: rows.filter((r) => r.journalEntryId != null).length,
      plannedPeriods: rows.filter((r) => r.journalEntryId == null).length,
      nextPeriod: rows.find((r) => r.journalEntryId == null)?.period ?? null,
      notes: s.notes, cancelReason: s.cancelReason,
      createdAt: s.createdAt.toISOString(),
    };
  },

  /** The whole company's due recognitions for a period — the month-end act. */
  async runPeriod(body: { period?: unknown }, userId: number | null) {
    const period = typeof body.period === "string" && body.period ? body.period : periodOf(businessToday());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      refuse("recognition_period_invalid", "The period is a month, as YYYY-MM.", "period");
    }
    const actives = await db.select().from(recognitionSchedulesTable).where(eq(recognitionSchedulesTable.status, "active"));
    const posted: { scheduleId: number; reference: string; amount: number; journalEntryId: number }[] = [];
    const skipped: { scheduleId: number; reference: string; reason: string }[] = [];
    for (const s of actives) {
      const rows = await this.rowsOf(s.id);
      const row = rows.find((r) => r.period === period);
      // 🔴 Every skip is REPORTED with its reason. A run that silently did
      // nothing for a schedule is indistinguishable from one that had nothing
      // to do, and month end is exactly when that distinction matters.
      if (!row) { skipped.push({ scheduleId: s.id, reference: s.reference, reason: `no row for ${period}` }); continue; }
      if (row.journalEntryId != null) { skipped.push({ scheduleId: s.id, reference: s.reference, reason: "already recognised" }); continue; }
      try {
        const out = await this.recognise(s.id, { period }, userId);
        posted.push({ scheduleId: s.id, reference: s.reference, amount: out.amount, journalEntryId: out.journalEntryId });
      } catch (err) {
        skipped.push({ scheduleId: s.id, reference: s.reference, reason: (err as Error).message.slice(0, 200) });
      }
    }
    return { period, posted, skipped, postedTotal: round2(posted.reduce((a, p) => a + p.amount, 0)) };
  },
};

const toRowView = (r: RecognitionScheduleRow) => ({
  id: r.id, period: r.period, sequence: r.sequence, amount: Number(r.amount),
  journalEntryId: r.journalEntryId, postedAt: r.postedAt?.toISOString() ?? null,
});
