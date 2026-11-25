/**
 * 🔴 19B S6 — A SAVED REPORT'S PERIOD, AND ITS ONE RESOLVER.
 *
 * A saved report names its period (`last_month`) or fixes a window. The name is resolved to dates at EVERY run — in the
 * browser when a person opens it, on the server when a schedule runs it — and both call THIS function, so the two
 * cannot disagree about what "last month" is. The day it starts from is the business day (`businessDate.ts`,
 * Asia/Riyadh), never the machine's or UTC's.
 *
 * 🔴 CALENDAR periods, and named as such: a month, a quarter and a year here are the calendar's. They are not the
 * company's fiscal year and not its VAT period (three clocks — none stands in for another); a report that needs one of
 * those takes a fixed window.
 */
import { isCalendarDate } from "./businessDate";

export const REPORT_PERIOD_KINDS = ["fixed", "this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year"] as const;
export type ReportPeriodKind = (typeof REPORT_PERIOD_KINDS)[number];
export interface ReportPeriod { kind: ReportPeriodKind; from: string | null; to: string | null }
export interface ReportWindow { from: string; to: string }

export const REPORT_PERIOD_LABELS: Record<ReportPeriodKind, [en: string, ar: string]> = {
  fixed: ["Fixed dates", "تواريخ محددة"],
  this_month: ["This calendar month", "الشهر الميلادي الحالي"],
  last_month: ["Last calendar month", "الشهر الميلادي الماضي"],
  this_quarter: ["This calendar quarter", "الربع الميلادي الحالي"],
  last_quarter: ["Last calendar quarter", "الربع الميلادي الماضي"],
  this_year: ["This calendar year", "السنة الميلادية الحالية"],
  last_year: ["Last calendar year", "السنة الميلادية الماضية"],
};

export const isReportPeriodKind = (v: unknown): v is ReportPeriodKind => typeof v === "string" && (REPORT_PERIOD_KINDS as readonly string[]).includes(v);

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
/** Months `m0`…`m0 + n − 1` of year `y` (0-based month; overflow and underflow roll the year), first day to last. */
const months = (y: number, m0: number, n: number): ReportWindow => ({ from: iso(y, m0, 1), to: iso(y, m0 + n, 0) });

/**
 * The window a period means on business day `today` (`YYYY-MM-DD`). A fixed period is its own dates; a malformed one —
 * a missing or unreal date, or an end before its start — is `null`, never a guessed window.
 */
export function resolveReportPeriod(period: ReportPeriod, today: string): ReportWindow | null {
  if (period.kind === "fixed") {
    if (!period.from || !period.to || !isCalendarDate(period.from) || !isCalendarDate(period.to) || period.from > period.to) return null;
    return { from: period.from, to: period.to };
  }
  if (!isCalendarDate(today)) return null;
  const [y, m] = today.split("-").map(Number) as [number, number];
  const q0 = Math.floor((m - 1) / 3) * 3;
  switch (period.kind) {
    case "this_month": return months(y, m - 1, 1);
    case "last_month": return months(y, m - 2, 1);
    case "this_quarter": return months(y, q0, 3);
    case "last_quarter": return months(y, q0 - 3, 3);
    case "this_year": return months(y, 0, 12);
    case "last_year": return months(y - 1, 0, 12);
    default: return null;
  }
}
