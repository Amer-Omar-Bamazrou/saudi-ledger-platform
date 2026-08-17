/**
 * The rolling fallback window (M20.1, F11) — what a report opens with when no
 * fiscal year is declared.
 *
 * A pure module in lib, like `chartState`: the node test harness runs only
 * `src/lib/**`, and the property this computes is worth pinning — the window
 * must assert NOTHING about the tenant's year, whatever today's date is.
 *
 * First day of the month 11 months ago → today. Whole months plus the current
 * partial one, so the window is stable within a day and spans a year of
 * activity without claiming to BE anyone's year.
 */
export function rollingLast12Months(now: Date = new Date()): { from: string; to: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  return {
    from: start.toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
}
