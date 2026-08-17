/**
 * Prior-period derivation (F7-cmp) — the M20.2 principle applied to
 * comparison: the prior window is derived from what the current window's
 * dates ARE, never from which control set them.
 *
 * 🔴 THE HIJRI CASE IS WHY THIS FILE EXISTS. A Hijri fiscal year is ~354
 * days; "the same dates one calendar year earlier" lands ~11 days off the
 * previous fiscal year — a window that is NO ONE's fiscal year, silently.
 * So a window that equals a resolver fiscal period compares against the
 * RESOLVER's preceding period (exact boundaries from the API, both
 * calendars), and this module does zero calendar conversion of its own.
 * Calendar months and quarters shift exactly BECAUSE M20.2 made the
 * month/quarter shortcuts calendar-based for every tenant. Anything else is
 * a custom window: it shifts by one calendar year (owner-approved), and the
 * page labels the resulting window explicitly so nothing is asserted
 * silently.
 */
import type { FiscalPeriodLike } from "./fiscalLabel";

export type CompareMode = "yoy" | "prev"; // Same period last year | Previous period

export interface PriorRange {
  from: string;
  to: string;
  kind: "fiscal" | "month" | "quarter" | "year" | "custom";
  /** Set when kind is "fiscal" — the resolver period, for M20.3 labelling. */
  fiscalPeriod?: FiscalPeriodLike;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s}T12:00:00Z`);
const firstOf = (y: number, m0: number) => iso(new Date(Date.UTC(y, m0, 1)));
const lastOf = (y: number, m0: number) => iso(new Date(Date.UTC(y, m0 + 1, 0)));

/** Same day N months earlier, clamped to the target month's end (31 Mar → 28/29 Feb). */
function shiftMonthsClamped(s: string, months: number): string {
  const d = utc(s);
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();
  const day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m0 + months + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(y, m0 + months, Math.min(day, lastDay))));
}

function classify(from: string, to: string): "month" | "quarter" | "year" | "custom" {
  const f = utc(from);
  const t = utc(to);
  if (f.getUTCDate() !== 1) return "custom";
  const fy = f.getUTCFullYear();
  const fm = f.getUTCMonth();
  if (to === lastOf(fy, fm)) return "month";
  if (fm % 3 === 0 && to === lastOf(fy, fm + 2)) return "quarter";
  if (fm === 0 && to === lastOf(fy, 11)) return "year";
  return "custom";
}

/** The resolver period a window IS, if any — however the user arrived at those dates. */
function matchFiscal(from: string, to: string, periods: FiscalPeriodLike[]): FiscalPeriodLike | undefined {
  return periods.find((p) => p.startDate === from && p.endDate === to);
}

/** The period immediately before `p` in a newest-first window of periods. */
function precedingFiscal(p: FiscalPeriodLike, periods: FiscalPeriodLike[]): FiscalPeriodLike | undefined {
  return periods.find((q) => q.endDate < p.startDate);
}

/**
 * Derive the comparison window, or `null` when there is nothing honest to
 * compare against (a fiscal window whose predecessor the API does not know).
 * For a fiscal window both modes mean the same thing: the preceding fiscal
 * year — "one Gregorian year before FY 1447" is not a question anyone asks.
 */
export function derivePriorRange(
  from: string,
  to: string,
  periods: FiscalPeriodLike[],
  mode: CompareMode,
): PriorRange | null {
  const fiscal = matchFiscal(from, to, periods);
  if (fiscal) {
    const prev = precedingFiscal(fiscal, periods);
    if (!prev) return null;
    return { from: prev.startDate, to: prev.endDate, kind: "fiscal", fiscalPeriod: prev };
  }

  const kind = classify(from, to);
  const f = utc(from);
  const y = f.getUTCFullYear();
  const m0 = f.getUTCMonth();

  if (kind === "month") {
    const back = mode === "yoy" ? 12 : 1;
    return { from: firstOf(y, m0 - back), to: lastOf(y, m0 - back), kind };
  }
  if (kind === "quarter") {
    const back = mode === "yoy" ? 12 : 3;
    return { from: firstOf(y, m0 - back), to: lastOf(y, m0 - back + 2), kind };
  }
  if (kind === "year") {
    return { from: firstOf(y - 1, 0), to: lastOf(y - 1, 11), kind };
  }

  // Custom window.
  if (mode === "yoy") {
    return { from: shiftMonthsClamped(from, -12), to: shiftMonthsClamped(to, -12), kind: "custom" };
  }
  // "Previous period": the contiguous window of the same length ending the
  // day before this one starts.
  const t = utc(to);
  const lengthDays = Math.round((t.getTime() - f.getTime()) / 86_400_000) + 1;
  const prevTo = new Date(f.getTime() - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - (lengthDays - 1) * 86_400_000);
  return { from: iso(prevFrom), to: iso(prevTo), kind: "custom" };
}

export interface PriorAsOf {
  date: string;
  kind: "fiscal-end" | "month-end" | "custom";
  fiscalPeriod?: FiscalPeriodLike;
}

/**
 * The balance sheet's prior snapshot date. Same derivation posture: an as-of
 * that IS a fiscal year-end compares against the preceding year-end from the
 * resolver; a month-end stays a month-end (31 Mar → 28/29 Feb under "prev",
 * never 1 Mar); anything else shifts by a year or a month, clamped.
 */
export function derivePriorAsOf(
  asOf: string,
  periods: FiscalPeriodLike[],
  mode: CompareMode,
): PriorAsOf | null {
  const fiscal = periods.find((p) => p.endDate === asOf);
  if (fiscal) {
    const prev = precedingFiscal(fiscal, periods);
    if (!prev) return null;
    return { date: prev.endDate, kind: "fiscal-end", fiscalPeriod: prev };
  }

  const d = utc(asOf);
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();
  const isMonthEnd = asOf === lastOf(y, m0);

  if (isMonthEnd) {
    const back = mode === "yoy" ? 12 : 1;
    return { date: lastOf(y, m0 - back), kind: "month-end" };
  }
  return { date: shiftMonthsClamped(asOf, mode === "yoy" ? -12 : -1), kind: "custom" };
}

/**
 * Percentage change as a display string — "—" when the base is zero, never
 * ∞, NaN, or a fabricated 100% (an empty prior must not read as an answer).
 */
export function fmtPctChange(current: number, prior: number): string {
  if (prior === 0) return "—";
  const pct = ((current - prior) / Math.abs(prior)) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}
