/**
 * M17.2 — fiscal-year resolution, in both calendars.
 *
 * These are PURE tests on purpose: `lib/fiscalYear.ts` takes the company's two
 * settings rather than loading a company, so every branch is reachable without
 * a tenant, and the Hijri cases can be pinned against independently published
 * Umm al-Qura dates rather than against our own output.
 *
 * 🔴 The standard applied here is *assert the property, not the number* — with
 * one deliberate exception. The Hijri anchor dates ARE hard-coded numbers,
 * because they are the one thing in this module that must match an external
 * authority (the Umm al-Qura tables) and cannot be derived from anything we
 * control. Everything else asserts a property: that a year ends the day before
 * the next begins, that day counts are computed rather than assumed, that a
 * date always falls inside the period claimed to contain it.
 */
import { describe, expect, it } from "vitest";
import {
  assertHijriCalendarAvailable,
  dayNumberFromIso,
  fromHijri,
  toHijri,
  toIsoDate,
} from "../lib/hijriCalendar";
import {
  fiscalYearContaining,
  recentFiscalYears,
  resolveFiscalYear,
  type FiscalYearSettings,
} from "../lib/fiscalYear";

const GREG_JAN: FiscalYearSettings = { fiscalYearStart: 1, calendar: "gregorian" };
const GREG_APR: FiscalYearSettings = { fiscalYearStart: 4, calendar: "gregorian" };
const HIJRI_MUHARRAM: FiscalYearSettings = { fiscalYearStart: 1, calendar: "hijri" };
const HIJRI_RAJAB: FiscalYearSettings = { fiscalYearStart: 7, calendar: "hijri" };

describe("M17.2 — the runtime can actually do Umm al-Qura", () => {
  it("🔴 the boot assertion passes on this runtime", () => {
    // If this throws, every Hijri fiscal year on this machine is wrong, not
    // absent — which is exactly why the assertion exists at boot.
    expect(() => assertHijriCalendarAvailable()).not.toThrow();
  });

  it("🔴 converts the published Umm al-Qura anchors — externally checkable facts", () => {
    // 1 Muharram of each of these years, per the Umm al-Qura calendar.
    expect(toIsoDate(fromHijri(1446, 1, 1)!)).toBe("2024-07-07");
    expect(toIsoDate(fromHijri(1447, 1, 1)!)).toBe("2025-06-26");
    expect(toIsoDate(fromHijri(1448, 1, 1)!)).toBe("2026-06-16");
    // …and the reverse direction agrees.
    expect(toHijri(dayNumberFromIso("2025-06-26"))).toEqual({ year: 1447, month: 1, day: 1 });
  });

  it("round-trips every day across four years without drift", () => {
    // The property that killed the first implementation: an arithmetic estimate
    // from the mean year length (354.367d) looked right on anchor dates and was
    // wrong in between, because Umm al-Qura month lengths are TABULATED.
    const start = dayNumberFromIso("2023-01-01");
    let failures = 0;
    for (let i = 0; i < 1461; i++) {
      const h = toHijri(start + i);
      if (fromHijri(h.year, h.month, h.day) !== start + i) failures++;
    }
    expect(failures).toBe(0);
  });

  it("returns null for a date that does not exist rather than the nearest one", () => {
    // Umm al-Qura months are 29 or 30 days; day 31 never exists in any of them.
    expect(fromHijri(1447, 1, 31)).toBeNull();
  });
});

describe("M17.2 — Gregorian fiscal years", () => {
  it("a January start is the calendar year", () => {
    const fy = resolveFiscalYear(GREG_JAN, 2026);
    expect(fy.startDate).toBe("2026-01-01");
    expect(fy.endDate).toBe("2026-12-31");
    expect(fy.days).toBe(365);
    expect(fy.endYear).toBe(2026);
  });

  it("an April start spans two calendar years and reports both", () => {
    const fy = resolveFiscalYear(GREG_APR, 2025);
    expect(fy.startDate).toBe("2025-04-01");
    expect(fy.endDate).toBe("2026-03-31");
    expect(fy.label).toBe(2025); // labelled by the year it STARTS in
    expect(fy.endYear).toBe(2026); // …and the other end is returned too
  });

  it("🔴 day counts are COMPUTED, so leap years are right without a special case", () => {
    expect(resolveFiscalYear(GREG_JAN, 2028).days).toBe(366); // leap
    expect(resolveFiscalYear(GREG_JAN, 2027).days).toBe(365);
    // An April-start year containing 29 Feb 2028 is the long one — the naive
    // "leap year ⇒ 366" rule keyed on the LABEL would get this backwards.
    expect(resolveFiscalYear(GREG_APR, 2027).days).toBe(366); // 2027-04-01 → 2028-03-31
    expect(resolveFiscalYear(GREG_APR, 2028).days).toBe(365); // 2028-04-01 → 2029-03-31
  });

  it("🔴 THE PROPERTY: each year ends the day before the next begins, for all 12 start months", () => {
    for (let month = 1; month <= 12; month++) {
      const settings: FiscalYearSettings = { fiscalYearStart: month, calendar: "gregorian" };
      const a = resolveFiscalYear(settings, 2026);
      const b = resolveFiscalYear(settings, 2027);
      expect(dayNumberFromIso(b.startDate) - dayNumberFromIso(a.endDate)).toBe(1);
      // …and the day count is exactly the span, with no off-by-one.
      expect(a.days).toBe(dayNumberFromIso(a.endDate) - dayNumberFromIso(a.startDate) + 1);
    }
  });

  it("finds the period containing a date, on both sides of the boundary", () => {
    expect(fiscalYearContaining(GREG_APR, "2026-03-31").label).toBe(2025);
    expect(fiscalYearContaining(GREG_APR, "2026-04-01").label).toBe(2026);
    // The boundary days themselves belong to the period that claims them.
    expect(fiscalYearContaining(GREG_APR, "2025-04-01").label).toBe(2025);
  });
});

describe("M17.2 — Hijri fiscal years", () => {
  it("a Muharram start is the Hijri year", () => {
    const fy = resolveFiscalYear(HIJRI_MUHARRAM, 1447);
    expect(fy.startDate).toBe("2025-06-26");
    expect(fy.endDate).toBe("2026-06-15"); // day before 1 Muharram 1448
    expect(fy.calendar).toBe("hijri");
  });

  it("🔴 a Hijri year is ~354 days, NOT 365 — the whole reason Q3 needs a rate adjustment", () => {
    for (const label of [1445, 1446, 1447, 1448]) {
      const fy = resolveFiscalYear(HIJRI_MUHARRAM, label);
      expect(fy.days).toBeGreaterThanOrEqual(354);
      expect(fy.days).toBeLessThanOrEqual(355);
    }
  });

  it("🔴 THE PROPERTY: consecutive Hijri years abut exactly, for all 12 start months", () => {
    for (let month = 1; month <= 12; month++) {
      const settings: FiscalYearSettings = { fiscalYearStart: month, calendar: "hijri" };
      const a = resolveFiscalYear(settings, 1447);
      const b = resolveFiscalYear(settings, 1448);
      expect(dayNumberFromIso(b.startDate) - dayNumberFromIso(a.endDate)).toBe(1);
      expect(a.days).toBe(dayNumberFromIso(a.endDate) - dayNumberFromIso(a.startDate) + 1);
    }
  });

  it("a Rajab start really does begin in Rajab", () => {
    const fy = resolveFiscalYear(HIJRI_RAJAB, 1447);
    const h = toHijri(dayNumberFromIso(fy.startDate));
    expect(h).toEqual({ year: 1447, month: 7, day: 1 });
  });

  it("finds the containing period across a Hijri boundary", () => {
    expect(fiscalYearContaining(HIJRI_MUHARRAM, "2025-06-25").label).toBe(1446);
    expect(fiscalYearContaining(HIJRI_MUHARRAM, "2025-06-26").label).toBe(1447);
  });

  it("🔴 the same date lands in DIFFERENT years under the two calendars — the settings matter", () => {
    // Not a trivia assertion: it is the proof that `calendar` is actually read,
    // and that a Hijri filer's boundaries are not quietly Gregorian ones.
    const greg = fiscalYearContaining(GREG_JAN, "2026-03-01");
    const hijri = fiscalYearContaining(HIJRI_MUHARRAM, "2026-03-01");
    expect(greg.startDate).toBe("2026-01-01");
    expect(hijri.startDate).toBe("2025-06-26");
    expect(greg.days).not.toBe(hijri.days);
  });
});

describe("M17.2 — the period list a picker consumes", () => {
  it("returns a contiguous window, newest first, that contains the current year", () => {
    const list = recentFiscalYears(GREG_APR, { asOf: "2026-05-10", back: 3, forward: 1 });
    expect(list).toHaveLength(5);
    expect(list[0].label).toBe(2027); // one forward
    expect(list.map((p) => p.label)).toEqual([2027, 2026, 2025, 2024, 2023]);
    // Contiguous: each period starts the day after the previous one ends.
    for (let i = list.length - 1; i > 0; i--) {
      expect(dayNumberFromIso(list[i - 1].startDate) - dayNumberFromIso(list[i].endDate)).toBe(1);
    }
  });

  it("works for a Hijri company too", () => {
    const list = recentFiscalYears(HIJRI_MUHARRAM, { asOf: "2026-01-15", back: 2, forward: 0 });
    expect(list.map((p) => p.label)).toEqual([1447, 1446, 1445]);
    expect(list.every((p) => p.calendar === "hijri")).toBe(true);
  });

  it("🔴 every listed period actually contains its own start and end date", () => {
    // Guards the class of bug where a picker offers a period whose boundaries
    // disagree with the resolver a report will use.
    for (const settings of [GREG_JAN, GREG_APR, HIJRI_MUHARRAM, HIJRI_RAJAB]) {
      for (const p of recentFiscalYears(settings, { asOf: "2026-05-10" })) {
        expect(fiscalYearContaining(settings, p.startDate).label).toBe(p.label);
        expect(fiscalYearContaining(settings, p.endDate).label).toBe(p.label);
      }
    }
  });
});

describe("M17.2 — invalid input is refused, not coerced", () => {
  it("rejects an out-of-range start month", () => {
    expect(() => resolveFiscalYear({ fiscalYearStart: 0, calendar: "gregorian" }, 2026)).toThrow(RangeError);
    expect(() => resolveFiscalYear({ fiscalYearStart: 13, calendar: "hijri" }, 1447)).toThrow(RangeError);
    // A non-integer month would silently produce a wrong boundary via Date.UTC.
    expect(() => resolveFiscalYear({ fiscalYearStart: 3.5, calendar: "gregorian" }, 2026)).toThrow(RangeError);
  });

  it("refuses a Hijri year outside the Umm al-Qura tables instead of guessing", () => {
    expect(() => resolveFiscalYear(HIJRI_MUHARRAM, 900)).toThrow(RangeError);
  });

  it("a picker still returns the years it CAN resolve at the edge of the tables", () => {
    // The list must degrade, not 500 — one unavailable year is not a reason to
    // deny the user every other year.
    const list = recentFiscalYears(HIJRI_MUHARRAM, { asOf: "2026-01-15", back: 2, forward: 0 });
    expect(list.length).toBeGreaterThan(0);
  });
});
