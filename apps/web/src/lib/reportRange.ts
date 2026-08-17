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

/** An inclusive ISO date range — what every shortcut resolves to. */
export interface DateRange {
  from: string;
  to: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Whole calendar months, `Date.UTC(y, m0+count, 0)` being the last day of the run. */
const monthSpan = (year: number, month0: number, count: number): DateRange => ({
  from: iso(new Date(Date.UTC(year, month0, 1))),
  to: iso(new Date(Date.UTC(year, month0 + count, 0))),
});

/**
 * The month/quarter shortcuts (M20.2, F12) — CALENDAR periods, deliberately.
 *
 * Not fiscal quarters: the month/quarter rhythm F4's research surfaced is the
 * filing rhythm, and KSA VAT periods are calendar months/quarters regardless of
 * the tenant's fiscal year. Calendar is also the only definition that exists
 * for an UNDECLARED tenant — a "fiscal quarter" shortcut would need the same
 * silent January assumption M20.0 removed. The tenant's fiscal year appears in
 * the two FISCAL shortcuts, whose boundaries come from the resolver via the
 * API and are never recomputed here.
 */
export function thisMonth(now: Date = new Date()): DateRange {
  return monthSpan(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

export function lastMonth(now: Date = new Date()): DateRange {
  return monthSpan(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
}

export function thisQuarter(now: Date = new Date()): DateRange {
  const q0 = Math.floor(now.getUTCMonth() / 3) * 3;
  return monthSpan(now.getUTCFullYear(), q0, 3);
}

export function lastQuarter(now: Date = new Date()): DateRange {
  const q0 = Math.floor(now.getUTCMonth() / 3) * 3;
  return monthSpan(now.getUTCFullYear(), q0 - 3, 3);
}
