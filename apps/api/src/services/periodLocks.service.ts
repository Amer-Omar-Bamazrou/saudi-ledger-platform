/**
 * Period locks service — close and reopen accounting months.
 *
 * 🔴 T1e (Phase 18; PER-1, PER-2, G57, DR-30 — owner 2026-10-24):
 *  - a close and a reopen take the month's exclusive guard first, so each is
 *    serialised with postings into that month (the database's PER-1 trigger
 *    takes it shared at every posting);
 *  - a reopen needs a REASON, keeps the lock row (who, when, why) and appends
 *    to the history; a re-close clears the reopen and closes the same row;
 *  - the migration's opening month is never reopened by an admin while its
 *    batch stands (G57), and no month of a fiscal year whose statements are
 *    authorised is reopened (DR-30). The migration's OWN reversal reopens its
 *    lock through `reopenForMigrationReversal`, recorded the same way.
 *  - a period is a real month (2026-13 used to pass).
 */
import { BadRequestError, BusinessRuleError, ConflictError } from "../lib/errors";
import { auditService } from "./audit.service";
import { periodLocksRepository } from "../repositories/periodLocks.repository";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
type LockRow = Awaited<ReturnType<typeof periodLocksRepository.findByPeriod>>[number];
const out = (l: LockRow) => ({ ...l, lockedAt: l.lockedAt.toISOString(), reopenedAt: l.reopenedAt ? l.reopenedAt.toISOString() : null });

function assertMonth(period: unknown): asserts period is string {
  if (typeof period !== "string" || !MONTH.test(period)) {
    throw new BadRequestError("period must be a real month in YYYY-MM format (e.g. 2026-06)");
  }
}

export const periodLocksService = {
  async list() {
    return (await periodLocksRepository.list()).map(out);
  },

  async lock(input: { period?: string; notes?: string | null; userId?: number | null }) {
    const { period, notes, userId } = input;
    assertMonth(period);
    await periodLocksRepository.guard(period);
    const [existing] = await periodLocksRepository.findByPeriod(period);
    if (existing && existing.reopenedAt == null) throw new ConflictError(`Period ${period} is already locked.`);

    let lock: LockRow;
    if (existing) {
      // A re-close: the same row, closed again; the reopen it clears stays in the history.
      [lock] = await periodLocksRepository.update(existing.id, {
        lockedAt: new Date(), lockedBy: userId ?? null, notes: notes ?? null,
        reopenedAt: null, reopenedBy: null, reopenReason: null,
      });
      await auditService.updated("period_lock", lock.id, existing, lock);
    } else {
      [lock] = await periodLocksRepository.insert({ period, lockedBy: userId ?? null, notes: notes ?? null });
      await auditService.created("period_lock", lock.id, lock);
    }
    await periodLocksRepository.appendEvent({ period, event: "close", reason: null, actor: userId ?? null });
    return out(lock);
  },

  /**
   * Reopen a closed month. Reopening a month that is not closed is a no-op
   * (undefined), as before — but the reason is required either way.
   */
  async reopen(period: string, body: { reason?: unknown }, userId: number | null) {
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      throw new BusinessRuleError(422, {
        code: "reopen_reason_required",
        field: "reason",
        error: "Say why the month is being reopened. Reopening makes its figures editable again, so the reason is kept in the month's history. Nothing was reopened.",
      });
    }
    assertMonth(period);
    await periodLocksRepository.guard(period);
    const [lock] = await periodLocksRepository.findByPeriod(period);
    if (!lock || lock.reopenedAt != null) return undefined;

    if (await periodLocksRepository.migrationBatchOf(lock.id)) {
      throw new BusinessRuleError(422, {
        code: "opening_month_never_reopened",
        error: `${period} is the opening month of a committed migration. Its balances are the migration's cut-off position, so it is never reopened. To change them, reverse the migration from the Migration page. Nothing was reopened.`,
      });
    }
    const auth = await periodLocksRepository.authorisationCovering(`${period}-01`);
    if (auth) {
      throw new BusinessRuleError(422, {
        code: "statements_authorised",
        error: `${period} belongs to the fiscal year ${auth.fiscalYearStart} – ${auth.fiscalYearEnd}, whose financial statements were authorised for issue on ${auth.authorisedOn} (${auth.authorisedBy}). A month of that year is not reopened; correct it in an open month instead. Nothing was reopened.`,
      });
    }
    const [after] = await periodLocksRepository.update(lock.id, { reopenedAt: new Date(), reopenedBy: userId, reopenReason: reason });
    await periodLocksRepository.appendEvent({ period, event: "reopen", reason, actor: userId });
    await auditService.updated("period_lock", lock.id, lock, after);
    return out(after);
  },

  /** The migration's own reversal takes its opening-month lock off — recorded as a reopen, never deleted. */
  async reopenForMigrationReversal(lockId: number, period: string, batchId: number, userId: number | null) {
    await periodLocksRepository.guard(period);
    const [lock] = await periodLocksRepository.findByPeriod(period);
    if (!lock || lock.id !== lockId || lock.reopenedAt != null) return;
    const reason = `Migration batch ${batchId} reversed`;
    const [after] = await periodLocksRepository.update(lock.id, { reopenedAt: new Date(), reopenedBy: userId, reopenReason: reason });
    await periodLocksRepository.appendEvent({ period, event: "reopen", reason, actor: userId });
    await auditService.updated("period_lock", lock.id, lock, after);
  },

  async history(period: string) {
    assertMonth(period);
    return (await periodLocksRepository.events(period)).map((e) => ({ ...e, at: e.at.toISOString() }));
  },
};
