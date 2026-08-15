/**
 * Umm al-Qura (Hijri) ↔ Gregorian conversion — M17.2.
 *
 * ── Why there is no dependency here ────────────────────────────────────────
 * Node ships full ICU, which already contains the Umm al-Qura tables:
 * `Intl.DateTimeFormat('en-u-ca-islamic-umalqura')` converts Gregorian → Hijri
 * exactly. A library would only re-tabulate what the runtime already knows, and
 * would then drift from it.
 *
 * ── 🔴 Umm al-Qura is not "the Islamic calendar" ───────────────────────────
 * ICU exposes FOUR islamic calendars — `islamic`, `islamic-civil`,
 * `islamic-rgsa` and `islamic-tbla` — and they disagree by one to two days.
 * `islamic-umalqura` is the SAUDI CIVIL calendar: the one a Saudi company's
 * fiscal year and a ZATCA filing are expressed in. The others are not
 * interchangeable with it, and picking the wrong one produces year boundaries
 * that are wrong by a day or two — which silently moves a Zakat base, because
 * a base is a balance measured *on a date*. Do not "simplify" this constant.
 *
 * ── 🔴 ICU is a property of the RUNTIME, not of this code ──────────────────
 * A Node built with small-icu resolves the locale but silently falls back to
 * the Gregorian calendar, so `toHijri` would return the Gregorian year and
 * every conversion would be confidently wrong rather than absent.
 * `assertHijriCalendarAvailable()` is called at boot for exactly that reason —
 * the same fail-closed posture `loadEnv` takes with the mailer and alerter.
 */

const MS_PER_DAY = 86_400_000;

/** The Saudi civil calendar. See the header — the variants are NOT equivalent. */
const UMM_AL_QURA_LOCALE = "en-u-ca-islamic-umalqura";

/** Widest range the resolver will search. Umm al-Qura tables cover ~1300–1600 AH. */
const SEARCH_MIN_DAY = Math.floor(Date.UTC(1900, 0, 1) / MS_PER_DAY);
const SEARCH_MAX_DAY = Math.floor(Date.UTC(2200, 0, 1) / MS_PER_DAY);

export interface HijriDate {
  /** Hijri year (AH). */
  year: number;
  /** 1 = Muharram … 12 = Dhu al-Hijjah. */
  month: number;
  /** 1–29/30. */
  day: number;
}

let formatter: Intl.DateTimeFormat | null = null;
function getFormatter(): Intl.DateTimeFormat {
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(UMM_AL_QURA_LOCALE, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      timeZone: "UTC",
    });
  }
  return formatter;
}

/** Whole UTC days since the epoch. The internal currency of this module. */
export function toDayNumber(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

export function fromDayNumber(dayNumber: number): Date {
  return new Date(dayNumber * MS_PER_DAY);
}

/** `YYYY-MM-DD` (the storage format used throughout this codebase). */
export function toIsoDate(dayNumber: number): string {
  return fromDayNumber(dayNumber).toISOString().slice(0, 10);
}

export function dayNumberFromIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/** Gregorian → Umm al-Qura Hijri. */
export function toHijri(dayNumber: number): HijriDate {
  const parts = Object.fromEntries(
    getFormatter()
      .formatToParts(fromDayNumber(dayNumber))
      .map((p) => [p.type, p.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function compare(a: HijriDate, b: HijriDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * Umm al-Qura Hijri → Gregorian, as a day number. Returns null if the date does
 * not exist (e.g. day 30 of a 29-day month, or a year outside the ICU tables).
 *
 * 🔴 BINARY SEARCH, deliberately — not an arithmetic estimate.
 *
 * The obvious implementation guesses from the mean year length (354.367 days)
 * and walks to the answer. That was tried first and was wrong: Umm al-Qura
 * month lengths are TABULATED, not formulaic, so the error is not a smooth
 * function anyone can iterate away, and a "close enough" break condition lands
 * a day or two off in exactly the cases that matter (month boundaries — which
 * is all a fiscal year is made of).
 *
 * The Hijri date is monotonic in the day number, so binary search over the
 * table is EXACT by construction and needs no tolerance. It costs ~19 ICU
 * formats per call; a fiscal-year resolution needs two.
 */
export function fromHijri(year: number, month: number, day: number): number | null {
  const target: HijriDate = { year, month, day };
  let lo = SEARCH_MIN_DAY;
  let hi = SEARCH_MAX_DAY;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (compare(toHijri(mid), target) < 0) lo = mid + 1;
    else hi = mid;
  }
  return compare(toHijri(lo), target) === 0 ? lo : null;
}

/**
 * 🔴 Fail fast at boot if the runtime cannot do Umm al-Qura.
 *
 * Two checks, because they fail differently: the first catches a small-icu
 * build (the calendar is simply absent), the second catches a runtime that
 * ACCEPTS the locale and silently substitutes Gregorian — which is the
 * dangerous one, since every conversion would then return a plausible wrong
 * answer instead of throwing.
 *
 * The probe date is a fixed, independently checkable fact: 1 Muharram 1447 AH
 * is 26 June 2025 in the Umm al-Qura calendar.
 */
export function assertHijriCalendarAvailable(): void {
  const supported =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("calendar").includes("islamic-umalqura")
      : true; // older runtime: fall through to the behavioural probe below

  if (!supported) {
    throw new Error(
      "This Node build does not provide the Umm al-Qura calendar (islamic-umalqura). " +
        "Hijri fiscal years cannot be computed. Use a full-ICU Node build " +
        "(node --icu=full / the official binaries), or set NODE_ICU_DATA.",
    );
  }

  const probe = toHijri(dayNumberFromIso("2025-06-26"));
  if (probe.year !== 1447 || probe.month !== 1 || probe.day !== 1) {
    throw new Error(
      `Umm al-Qura conversion is wrong on this runtime: 2025-06-26 resolved to ` +
        `${probe.year}-${probe.month}-${probe.day} AH, expected 1447-1-1. ` +
        "This usually means ICU silently fell back to the Gregorian calendar.",
    );
  }
}
