/**
 * Fiscal-period labels (M20.3, F3 first half) — "FY 1447 (Jun 2025 – Jun 2026)".
 *
 * `label` is the year the period STARTS in, in the company's OWN calendar (AH
 * for hijri) — the API says so, and the parenthetical Gregorian range is what
 * makes that number readable to anyone: a Hijri year label without its
 * Gregorian span is a fact only one reader can place. The boundaries come from
 * the resolver via the API and are never recomputed here — client-side Hijri
 * arithmetic is exactly the silent-substitution hazard M17.2's boot assertion
 * exists to catch on the server, and the label needs none of it: everything
 * this formats is already in the payload.
 *
 * Pure and in lib so the year-boundary cases are pinned by tests. Month names
 * are our own table, not `Intl` — twelve strings beat a formatter whose locale
 * data we cannot assert on.
 */
export interface FiscalPeriodLike {
  /** Year the period starts in, in the company's own calendar (AH for hijri). */
  label: number;
  calendar: "gregorian" | "hijri";
  /** Inclusive, YYYY-MM-DD — Gregorian, the platform's storage format. */
  startDate: string;
  endDate: string;
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

function monthYear(isoDate: string, lang: "en" | "ar"): { month: string; year: string } {
  const months = lang === "ar" ? MONTHS_AR : MONTHS_EN;
  return { month: months[Number(isoDate.slice(5, 7)) - 1], year: isoDate.slice(0, 4) };
}

/**
 * "FY 1447 (Jun 2025 – Jun 2026)" / "FY 2026 (Jan – Dec 2026)" — the year is
 * dropped from the start when both ends share it, per the design's example
 * style. Arabic mirrors the structure with the same Latin digits the rest of
 * the app uses.
 */
export function fiscalPeriodLabel(p: FiscalPeriodLike, lang: "en" | "ar" = "en"): string {
  const start = monthYear(p.startDate, lang);
  const end = monthYear(p.endDate, lang);
  const span =
    start.year === end.year
      ? `${start.month} – ${end.month} ${end.year}`
      : `${start.month} ${start.year} – ${end.month} ${end.year}`;
  const fy = lang === "ar" ? `السنة المالية ${p.label}` : `FY ${p.label}`;
  return `${fy} (${span})`;
}
