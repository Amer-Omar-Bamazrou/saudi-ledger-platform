/**
 * M20.1 — the rolling fallback window (F11).
 *
 * The window a report opens with when no fiscal year is declared. The property
 * that matters: it must assert NOTHING about the tenant's year — no January
 * anywhere, whatever today's date is. A rolling window that happened to snap to
 * a year boundary would quietly become the old defect again.
 */
import { describe, expect, it } from "vitest";
import { rollingLast12Months } from "./reportRange";

describe("rollingLast12Months", () => {
  it("spans the current partial month plus the 11 before it", () => {
    const r = rollingLast12Months(new Date("2026-08-16T12:00:00Z"));
    expect(r).toEqual({ from: "2025-09-01", to: "2026-08-16" });
  });

  it("🔴 in January it does NOT collapse to a calendar year", () => {
    // The nearest miss to the old defect: a January 'now' must reach back into
    // the previous year, not start at Jan 1 — that would be the hardcoded
    // default reborn for one month of every year.
    const r = rollingLast12Months(new Date("2026-01-05T00:00:00Z"));
    expect(r.from).toBe("2025-02-01");
    expect(r.to).toBe("2026-01-05");
  });

  it("crosses a year boundary without arithmetic drift", () => {
    // Date.UTC normalises negative months; pin it anyway — a wrong month here
    // is a wrong window on every report at once.
    const r = rollingLast12Months(new Date("2026-03-31T23:59:59Z"));
    expect(r.from).toBe("2025-04-01");
  });

  it("31st-of-month 'now' does not skip or double a month", () => {
    const r = rollingLast12Months(new Date("2026-07-31T00:00:00Z"));
    expect(r.from).toBe("2025-08-01");
    expect(r.to).toBe("2026-07-31");
  });
});
