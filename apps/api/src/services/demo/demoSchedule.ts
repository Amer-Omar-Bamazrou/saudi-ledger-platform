/**
 * When the next demo reset falls due — the decision, separated from the act.
 *
 * Pure, and in its own module with no imports, so the rule can be tested
 * without loading the reset service (which pulls in the whole invoicing stack
 * through the seed). The rule is the part worth pinning: the ACT is destructive
 * and obvious, the SCHEDULE is where a plausible-looking mistake hides.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param last  the last SUCCESSFUL reset, or null if there has never been one.
 *
 * 🔴 Success, not "the job ran". A failed run leaves `last` where it was, so the
 * reset stays due and is retried — the alternative (counting attempts) turns a
 * permanently-failing reset into a permanently-satisfied schedule, while the
 * banner goes on promising a wipe that stopped happening.
 *
 * 🔴 And a demo that has never reset is due one full interval from NOW, not
 * immediately: wiping at first boot would destroy the seed someone had just
 * created to look at, before anyone had seen it.
 */
export function nextResetAt(last: Date | null, intervalDays: number, now: Date): Date {
  return new Date((last ?? now).getTime() + intervalDays * DAY_MS);
}
