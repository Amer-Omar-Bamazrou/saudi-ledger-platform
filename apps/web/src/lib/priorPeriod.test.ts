/**
 * F7-cmp — prior-period derivation. The Hijri fiscal case is the reason the
 * module exists and the first thing pinned: FY 1447 (26 Jun 2025 – 15 Jun
 * 2026) must compare against FY 1446's REAL boundaries from the resolver,
 * not "the same dates one calendar year earlier", which is ~11 days off and
 * is no one's fiscal year.
 */
import { describe, expect, it } from "vitest";
import { derivePriorAsOf, derivePriorRange, fmtPctChange } from "./priorPeriod";
import type { FiscalPeriodLike } from "./fiscalLabel";

// Umm al-Qura boundaries as the resolver reports them, newest first.
const HIJRI_PERIODS: FiscalPeriodLike[] = [
  { label: 1448, calendar: "hijri", startDate: "2026-06-16", endDate: "2027-06-05" },
  { label: 1447, calendar: "hijri", startDate: "2025-06-26", endDate: "2026-06-15" },
  { label: 1446, calendar: "hijri", startDate: "2024-07-07", endDate: "2025-06-25" },
];

describe("derivePriorRange — fiscal windows", () => {
  it("🔴 a Hijri fiscal year compares against the RESOLVER's previous year, not calendar-minus-one", () => {
    const prior = derivePriorRange("2025-06-26", "2026-06-15", HIJRI_PERIODS, "yoy");
    expect(prior).toMatchObject({ from: "2024-07-07", to: "2025-06-25", kind: "fiscal" });
    // The wrong answer this test exists to forbid:
    expect(prior!.from).not.toBe("2024-06-26");
  });

  it("both modes mean the same thing for a fiscal window", () => {
    expect(derivePriorRange("2025-06-26", "2026-06-15", HIJRI_PERIODS, "prev")).toMatchObject({
      from: "2024-07-07",
      to: "2025-06-25",
    });
  });

  it("returns null — comparison unavailable — when the API knows no earlier period", () => {
    expect(derivePriorRange("2024-07-07", "2025-06-25", HIJRI_PERIODS, "yoy")).toBeNull();
  });

  it("matches by DATES, however the user arrived at them (the M20.2 equality principle)", () => {
    // Typing FY 1447's boundaries by hand is the same window as clicking the shortcut.
    const prior = derivePriorRange("2025-06-26", "2026-06-15", HIJRI_PERIODS, "yoy");
    expect(prior?.fiscalPeriod?.label).toBe(1446);
  });
});

describe("derivePriorRange — calendar windows", () => {
  it("month: yoy goes to the same month last year, prev to the previous month", () => {
    expect(derivePriorRange("2026-08-01", "2026-08-31", [], "yoy")).toMatchObject({ from: "2025-08-01", to: "2025-08-31", kind: "month" });
    expect(derivePriorRange("2026-01-01", "2026-01-31", [], "prev")).toMatchObject({ from: "2025-12-01", to: "2025-12-31", kind: "month" });
  });

  it("quarter: yoy is seasonal, prev is sequential — Q1's prev reaches the previous year", () => {
    expect(derivePriorRange("2026-07-01", "2026-09-30", [], "yoy")).toMatchObject({ from: "2025-07-01", to: "2025-09-30", kind: "quarter" });
    expect(derivePriorRange("2026-01-01", "2026-03-31", [], "prev")).toMatchObject({ from: "2025-10-01", to: "2025-12-31", kind: "quarter" });
  });

  it("calendar year: both modes give the previous calendar year", () => {
    expect(derivePriorRange("2026-01-01", "2026-12-31", [], "yoy")).toMatchObject({ from: "2025-01-01", to: "2025-12-31", kind: "year" });
  });

  it("month-end lengths differ across the shift and stay correct (Feb)", () => {
    expect(derivePriorRange("2028-02-01", "2028-02-29", [], "yoy")).toMatchObject({ from: "2027-02-01", to: "2027-02-28" });
  });
});

describe("derivePriorRange — custom windows", () => {
  it("yoy shifts both dates one calendar year, clamped (29 Feb → 28 Feb)", () => {
    expect(derivePriorRange("2028-02-29", "2028-03-15", [], "yoy")).toMatchObject({ from: "2027-02-28", to: "2027-03-15", kind: "custom" });
  });

  it("prev is the contiguous window of the same length ending the day before", () => {
    // 10 days: 2026-08-11 → 2026-08-20; prior = 2026-08-01 → 2026-08-10.
    expect(derivePriorRange("2026-08-11", "2026-08-20", [], "prev")).toMatchObject({ from: "2026-08-01", to: "2026-08-10", kind: "custom" });
  });

  it("the rolling default window (an arbitrary range) is custom, not misread as a year", () => {
    const prior = derivePriorRange("2025-09-01", "2026-08-17", [], "yoy");
    expect(prior).toMatchObject({ from: "2024-09-01", to: "2025-08-17", kind: "custom" });
  });
});

describe("derivePriorAsOf", () => {
  it("🔴 a fiscal year-end compares against the PRECEDING year-end from the resolver", () => {
    expect(derivePriorAsOf("2026-06-15", HIJRI_PERIODS, "yoy")).toMatchObject({ date: "2025-06-25", kind: "fiscal-end" });
  });

  it("a month-end stays a month-end — 31 Mar's previous is 28 Feb, never 1 Mar or 3 Mar", () => {
    expect(derivePriorAsOf("2026-03-31", [], "prev")).toMatchObject({ date: "2026-02-28", kind: "month-end" });
    expect(derivePriorAsOf("2026-03-31", [], "yoy")).toMatchObject({ date: "2025-03-31", kind: "month-end" });
  });

  it("an arbitrary date shifts by a year (yoy) or a month (prev), clamped", () => {
    expect(derivePriorAsOf("2026-08-17", [], "yoy")).toMatchObject({ date: "2025-08-17", kind: "custom" });
    expect(derivePriorAsOf("2026-08-17", [], "prev")).toMatchObject({ date: "2026-07-17", kind: "custom" });
  });

  it("null when the fiscal predecessor is unknown", () => {
    expect(derivePriorAsOf("2025-06-25", HIJRI_PERIODS, "yoy")).toBeNull();
  });
});

describe("fmtPctChange", () => {
  it("— against a zero base: an empty prior must not read as an answer", () => {
    expect(fmtPctChange(500, 0)).toBe("—");
  });

  it("signed percentages against a real base, including a negative base", () => {
    expect(fmtPctChange(115, 100)).toBe("+15.0%");
    expect(fmtPctChange(80, 100)).toBe("-20.0%");
    // A loss that deepened: -150 vs -100 is a further -50 against |base|.
    expect(fmtPctChange(-150, -100)).toBe("-50.0%");
  });
});
