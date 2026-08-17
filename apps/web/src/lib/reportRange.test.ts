/**
 * M20.1 — the rolling fallback window (F11).
 *
 * The window a report opens with when no fiscal year is declared. The property
 * that matters: it must assert NOTHING about the tenant's year — no January
 * anywhere, whatever today's date is. A rolling window that happened to snap to
 * a year boundary would quietly become the old defect again.
 */
import { describe, expect, it } from "vitest";
import { lastMonth, lastQuarter, rollingLast12Months, thisMonth, thisQuarter } from "./reportRange";

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

/**
 * M20.2 — the calendar shortcuts (F12). The year-boundary cases are the ones
 * that matter: January's "last month" and Q1's "last quarter" must reach into
 * the PREVIOUS year, and every range must end on the true last day of its
 * month — a shortcut producing a wrong window is the M20.1 defect with a
 * button on it.
 */
describe("calendar shortcuts", () => {
  const aug = new Date("2026-08-17T12:00:00Z");

  it("this / last month", () => {
    expect(thisMonth(aug)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(lastMonth(aug)).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });

  it("🔴 January's last month is December of the PREVIOUS year", () => {
    expect(lastMonth(new Date("2026-01-05T00:00:00Z"))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("this / last quarter", () => {
    expect(thisQuarter(aug)).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(lastQuarter(aug)).toEqual({ from: "2026-04-01", to: "2026-06-30" });
  });

  it("🔴 Q1's last quarter is Oct–Dec of the PREVIOUS year", () => {
    expect(lastQuarter(new Date("2026-02-10T00:00:00Z"))).toEqual({ from: "2025-10-01", to: "2025-12-31" });
  });

  it("February's month-end respects leap years", () => {
    expect(thisMonth(new Date("2028-02-10T00:00:00Z")).to).toBe("2028-02-29");
    expect(thisMonth(new Date("2026-02-10T00:00:00Z")).to).toBe("2026-02-28");
  });

  it("a 31st 'now' does not bleed the quarter boundary", () => {
    expect(thisQuarter(new Date("2026-12-31T23:59:59Z"))).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(lastQuarter(new Date("2026-12-31T23:59:59Z"))).toEqual({ from: "2026-07-01", to: "2026-09-30" });
  });
});
