/**
 * Fiscal-year resolution — M17.2.
 *
 * Answers the one question the platform could not answer before: **for THIS
 * company, what concrete date range is fiscal year X?**
 *
 * `companies.fiscal_year_start` has been stored since M11.6 and applied by no
 * report — the Company Settings page said so in as many words. It was stored
 * because a fiscal year is obviously needed eventually; it stayed unapplied
 * because nothing had a reason to resolve one. Zakat is that reason (owner
 * decision Q3: a Zakat base is a balance *as of a fiscal year end*, and the
 * Gregorian rate adjustment is a *day count between two fiscal boundaries*),
 * which is why Q3 calls fiscal-year support a prerequisite rather than a
 * companion.
 *
 * Pure functions only — no DB, no company loading. The service layer supplies
 * the company's two settings. That keeps every branch here testable without a
 * tenant, and it is why the Hijri cases can be pinned against published dates.
 */
import {
  dayNumberFromIso,
  fromHijri,
  toDayNumber,
  toHijri,
  toIsoDate,
} from "./hijriCalendar";

/**
 * Which calendar the company's fiscal year is expressed in.
 *
 * 🔴 This changes what `fiscalYearStart` MEANS. Under `gregorian` it is a
 * Gregorian month (1 = January); under `hijri` it is a Hijri month
 * (1 = Muharram). One column, two meanings, disambiguated by this field —
 * deliberately, because two columns would leave a stale value behind whenever
 * a company switched calendars, and a stale month is a wrong year boundary
 * that nothing would flag.
 */
export type FiscalCalendar = "gregorian" | "hijri";

export const FISCAL_CALENDARS: readonly FiscalCalendar[] = ["gregorian", "hijri"] as const;

export interface FiscalYearSettings {
  /** Month number 1–12, IN `calendar` (see the note on FiscalCalendar). */
  fiscalYearStart: number;
  calendar: FiscalCalendar;
}

export interface FiscalPeriod {
  /**
   * The year number the period is NAMED by — the year in which it STARTS, in
   * the company's own calendar.
   *
   * 🔴 A display convention, not a fact, and deliberately not load-bearing.
   * For a fiscal year that spans two calendar years there is no universal
   * labelling rule: some jurisdictions name it for the starting year, others
   * for the ending one. Rather than pick a convention and hide the ambiguity,
   * every consumer gets `startDate`, `endDate` AND `endYear`, and the UI shows
   * the range beside the label. If the owner later prefers end-year labels,
   * that is a display change with no data migration.
   */
  label: number;
  /** The calendar year the period ENDS in — so a consumer can label either way. */
  endYear: number;
  calendar: FiscalCalendar;
  /** Inclusive, `YYYY-MM-DD` (the storage format used across this codebase). */
  startDate: string;
  /** Inclusive. The day BEFORE the next fiscal year begins. */
  endDate: string;
  /**
   * Inclusive day count — 365/366 for Gregorian, 354/355 for Hijri.
   *
   * Computed, never assumed. It is the input to the Gregorian Zakat rate
   * adjustment (`2.5% × days ÷ 354`, Q3) — but that RATE is NOT computed here:
   * the divisor is unverified (design §4 / advisor Block C, question C3) and
   * M17.4 is held on it. Exposing the day count is honest; exposing a rate
   * derived from an unverified constant is the mistake this module exists
   * downstream of.
   */
  days: number;
}

export const DEFAULT_FISCAL_CALENDAR: FiscalCalendar = "gregorian";

export function isFiscalCalendar(value: unknown): value is FiscalCalendar {
  return typeof value === "string" && (FISCAL_CALENDARS as readonly string[]).includes(value);
}

function assertStartMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`fiscalYearStart must be a month number between 1 and 12, got ${month}`);
  }
}

const MS_DAY_DIVISOR = 86_400_000;

/** First day of Gregorian year/month, as a day number. */
function gregorianStart(year: number, month: number): number {
  return Math.floor(Date.UTC(year, month - 1, 1) / MS_DAY_DIVISOR);
}

/**
 * Resolve one fiscal year for a company.
 *
 * `label` is the year the period starts in, in the company's own calendar —
 * so for a Hijri company you pass an AH year (1447), not a Gregorian one.
 *
 * The end is computed as *the day before the next period begins*, never as
 * "start + 364" or "start + 12 months − 1 day". That matters in both calendars:
 * Gregorian leap years and Umm al-Qura's tabulated 29/30-day months both make
 * a fixed-length assumption wrong, and a fiscal year that is one day short is a
 * balance measured on the wrong date.
 */
export function resolveFiscalYear(settings: FiscalYearSettings, label: number): FiscalPeriod {
  assertStartMonth(settings.fiscalYearStart);

  if (settings.calendar === "gregorian") {
    const start = gregorianStart(label, settings.fiscalYearStart);
    const nextStart = gregorianStart(label + 1, settings.fiscalYearStart);
    const endDay = nextStart - 1;
    return {
      label,
      endYear: new Date(endDay * MS_DAY_DIVISOR).getUTCFullYear(),
      calendar: "gregorian",
      startDate: toIsoDate(start),
      endDate: toIsoDate(endDay),
      days: nextStart - start,
    };
  }

  const start = fromHijri(label, settings.fiscalYearStart, 1);
  const nextStart = fromHijri(label + 1, settings.fiscalYearStart, 1);
  if (start === null || nextStart === null) {
    throw new RangeError(
      `Hijri year ${label} (start month ${settings.fiscalYearStart}) is outside the ` +
        "Umm al-Qura tables available on this runtime.",
    );
  }
  const endDay = nextStart - 1;
  return {
    label,
    endYear: toHijri(endDay).year,
    calendar: "hijri",
    startDate: toIsoDate(start),
    endDate: toIsoDate(endDay),
    days: nextStart - start,
  };
}

/**
 * Which fiscal year does a given date fall in? Returns the period, so the
 * caller never has to re-derive the boundaries it is about to need.
 *
 * `asOf` is a `YYYY-MM-DD` string or a Date; it defaults to today. Passing it
 * explicitly is what makes this testable without freezing the clock.
 */
export function fiscalYearContaining(
  settings: FiscalYearSettings,
  asOf: string | Date = new Date(),
): FiscalPeriod {
  assertStartMonth(settings.fiscalYearStart);
  const day = typeof asOf === "string" ? dayNumberFromIso(asOf) : toDayNumber(asOf);

  if (settings.calendar === "gregorian") {
    const d = new Date(day * MS_DAY_DIVISOR);
    // Before the start month, the fiscal year began in the PREVIOUS calendar year.
    const label =
      d.getUTCMonth() + 1 >= settings.fiscalYearStart ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    return resolveFiscalYear(settings, label);
  }

  const h = toHijri(day);
  const label = h.month >= settings.fiscalYearStart ? h.year : h.year - 1;
  return resolveFiscalYear(settings, label);
}

/**
 * A window of fiscal years around the one containing `asOf` — what a period
 * picker needs. Newest first, because a user reaching for a fiscal year almost
 * always wants the current or the immediately previous one.
 */
export function recentFiscalYears(
  settings: FiscalYearSettings,
  opts: { asOf?: string | Date; back?: number; forward?: number } = {},
): FiscalPeriod[] {
  const { asOf = new Date(), back = 4, forward = 1 } = opts;
  const current = fiscalYearContaining(settings, asOf);
  const out: FiscalPeriod[] = [];
  for (let offset = forward; offset >= -back; offset--) {
    try {
      out.push(resolveFiscalYear(settings, current.label + offset));
    } catch {
      // Outside the Umm al-Qura tables — omit rather than fail the whole list.
      // A picker missing a year from 1890 is fine; a picker that 500s is not.
    }
  }
  return out;
}
