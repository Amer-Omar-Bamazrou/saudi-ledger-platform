/**
 * 🔴 THE BUSINESS CALENDAR DAY — ONE SEAM (2026-09-16, the pre-pilot sanity walk).
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 * Every "today" in the product was `new Date().toISOString().slice(0, 10)`:
 * the UTC calendar day. Riyadh is UTC+3, so between 00:00 and 03:00 local
 * every business date the product decided for the user was YESTERDAY. Seen
 * live at 02:40 Riyadh on 2026-09-16: the invoice form defaulted to
 * 2026-09-15 (a wrong legal issue date on a tax invoice), and a journal
 * entry dated 2026-09-16 was reversed with a reversal dated 2026-09-15 — a
 * reversal before the entry it reverses. Every suite and every walk ran in
 * daytime, so none could see it (findings file, "THE NIGHT WINDOW").
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * A business date (an invoice issue date, a journal entry date, a payment
 * date, a reversal date, a document's dated-today default) is the calendar
 * day in the BUSINESS TIME ZONE, never the UTC day and never the machine's
 * zone. Timestamps (`created_at`, `posted_at`, `issued_at`) stay instants;
 * this seam is only for the DAY a business event belongs to.
 *
 * Both apps import it from here so the server and the browser can never
 * disagree on what day it is — the browser's own clock zone is irrelevant.
 * The one zone is a constant today (the platform is Saudi-only; GCC zones
 * are all fixed-offset, no DST). If a per-company zone is ever added, it is
 * added HERE as a parameter, not as a second definition elsewhere.
 *
 * `tests/business-date-seam.test.ts` (api) fails on any new inline
 * `new Date().toISOString()…` in either app, so the defect cannot be
 * re-introduced one form at a time.
 */

export const BUSINESS_TIME_ZONE = "Asia/Riyadh";

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The calendar day (`YYYY-MM-DD`) that the instant `at` falls on in the business time zone. */
export function businessDate(at: Date): string {
  const parts = formatter.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Today's business calendar day. The ONLY correct source of a "dated today" default. */
export function businessToday(): string {
  return businessDate(new Date());
}

/** `days` calendar days before/after a business date, as a business date (no zone drift: pure day arithmetic). */
export function businessDateShift(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * 🔴 Probe an externally checkable fact at load (CLAUDE.md §3): a runtime
 * whose ICU lacks the zone would not throw on `Intl` alone in every engine —
 * it could silently answer in UTC, which is exactly the defect. 22:00 UTC on
 * 1 Jan is 01:00 on 2 Jan in Riyadh; if this seam says otherwise, nothing
 * built on it can be trusted, so refuse to load.
 */
const probe = businessDate(new Date(Date.UTC(2026, 0, 1, 22, 0, 0)));
if (probe !== "2026-01-02") {
  throw new Error(`businessDate: the ${BUSINESS_TIME_ZONE} calendar is not honoured by this runtime (got ${probe} for 2026-01-01T22:00Z; expected 2026-01-02)`);
}
