/**
 * 🔴 The Phase 18 walk, W1 (2026-11-17): an INSTANT the server serves (ISO, UTC) is shown as the business day and the
 * clock in Asia/Riyadh — the one business zone (`@workspace/shared` businessDate.ts) — never as the UTC clock. The
 * security and audit trails sliced the ISO string, so a 14:20 sign-in read "11:20", and near midnight the DAY was the
 * UTC day too.
 *
 * And a count is written in the app's digits (Latin, N-11) whatever the browser's locale: a bare `toLocaleString()`
 * printed "١٦" to an Arabic browser beside Latin figures.
 */
import { BUSINESS_TIME_ZONE, businessDate } from "@workspace/shared";

export function businessInstant(iso: string, opts: { seconds?: boolean } = {}): { date: string; time: string } {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { date: iso.slice(0, 10), time: "" };
  const time = at.toLocaleTimeString("en-GB", {
    timeZone: BUSINESS_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    ...(opts.seconds ? { second: "2-digit" as const } : {}),
    hourCycle: "h23",
  });
  return { date: businessDate(at), time };
}

export const fmtCount = (n: number): string => n.toLocaleString("en-US");

/**
 * Walk W7: "N days" in Arabic with the number's agreement — 1 يوم واحد · 2 يومين · 3–10 أيام (the plural) ·
 * 11 and up يوماً — and a round hundred يوم. The heading read "خلال 7 يوماً".
 */
export function daysAr(n: number): string {
  if (n === 1) return "يوم واحد";
  if (n === 2) return "يومين";
  const r = n % 100;
  if (r >= 3 && r <= 10) return `${n} أيام`;
  if (n >= 100 && r <= 2) return `${n} يوم`;
  return `${n} يوماً`;
}
