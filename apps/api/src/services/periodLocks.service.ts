/** Period locks service — lock/unlock accounting periods. Behavior preserved from pre-M6. */
import { BadRequestError, ConflictError } from "../lib/errors";
import { periodLocksRepository } from "../repositories/periodLocks.repository";

export const periodLocksService = {
  async list() {
    const locks = await periodLocksRepository.list();
    return locks.map((l) => ({ ...l, lockedAt: l.lockedAt.toISOString() }));
  },

  async lock(input: { period?: string; notes?: string | null; userId?: number | null }) {
    const { period, notes, userId } = input;
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      throw new BadRequestError("period must be in YYYY-MM format (e.g. 2026-06)");
    }
    const [existing] = await periodLocksRepository.findByPeriod(period);
    if (existing) throw new ConflictError(`Period ${period} is already locked.`);

    const [lock] = await periodLocksRepository.insert({
      period,
      lockedBy: userId ?? null,
      notes: notes ?? null,
    });
    return { ...lock, lockedAt: lock.lockedAt.toISOString() };
  },

  async unlock(period: string) {
    await periodLocksRepository.removeByPeriod(period);
  },
};
