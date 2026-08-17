/**
 * Client-side Hijri (Umm al-Qura) date DISPLAY (F3-dual).
 *
 * 🔴 THE PROBE IS THE POINT. A small-ICU runtime accepts
 * `islamic-umalqura` and silently returns GREGORIAN dates — no error, no
 * missing output, just a plausible wrong answer (M17.2's finding; the API
 * refuses to BOOT on such a runtime). The browser cannot refuse to boot, so
 * it refuses to render instead: before any Hijri string is produced, this
 * module checks one externally verifiable fact — 1 Muharram 1447 AH =
 * 26 June 2025 — and if the runtime disagrees, every formatter here returns
 * `null` and callers fall back to Gregorian-only. Saying less over saying
 * wrong, the same posture as M20.1's failed-fetch notice.
 *
 * Display only. Date INPUTS stay Gregorian (F3), storage stays Gregorian,
 * and fiscal-year BOUNDARIES still come exclusively from the server's
 * resolver — this module never decides where a year starts, only how a day
 * already known is written in the other calendar.
 */

const PROBE_ISO = "2025-06-26"; // 1 Muharram 1447 AH — the M17.2 boot-assertion fact

type PartsFormatter = (iso: string, locale: string) => { day?: string; month?: string; year?: string };

const intlParts: PartsFormatter = (iso, locale) => {
  const parts = new Intl.DateTimeFormat(`${locale}-u-ca-islamic-umalqura-nu-latn`, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(new Date(`${iso}T12:00:00Z`)); // noon UTC — a date, not an instant; no TZ can shift it a day
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return { day: get("day"), month: get("month"), year: get("year") };
};

let probeResult: boolean | null = null;

/** Run the probe against a given formatter — separated so tests can exercise the REFUSING branch. */
export function probeHijri(format: PartsFormatter = intlParts): boolean {
  try {
    const p = format(PROBE_ISO, "en");
    // Day 1, year 1447, a month that reads as Muharram. A Gregorian
    // substitution would say 26 Jun 2025 and fail all three.
    return p.day === "1" && p.year === "1447" && !!p.month && p.month.startsWith("Muh");
  } catch {
    return false;
  }
}

/** Memoized probe — one Intl round-trip per session. */
export function hijriAvailable(): boolean {
  if (probeResult === null) probeResult = probeHijri();
  return probeResult;
}

/** Test hook — clear (or force) the memoized probe. */
export function __setHijriProbeForTests(value: boolean | null): void {
  probeResult = value;
}

/**
 * "4 Rab. I 1448" / "4 ربيع الأول 1448" — or `null` when the runtime failed
 * the probe or the input is not a date. Latin digits in both languages, like
 * the rest of the app.
 */
export function formatHijri(iso: string, lang: "en" | "ar" = "en"): string | null {
  if (!hijriAvailable()) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  try {
    const p = intlParts(iso.slice(0, 10), lang);
    if (!p.day || !p.month || !p.year) return null;
    return `${p.day} ${p.month} ${p.year}`;
  } catch {
    return null;
  }
}
