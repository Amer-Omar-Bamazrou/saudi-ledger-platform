/** Walk W1/W7 — an instant in Riyadh time, a count in Latin digits, a day count in Arabic agreement. */
import { describe, expect, it } from "vitest";
import { businessInstant, daysAr, fmtCount } from "./businessTime";

describe("businessInstant — the business day and clock of an instant, in Asia/Riyadh", () => {
  it("🔴 the walk's own sign-in: served 11:20 UTC, it is 14:20 in Riyadh", () => {
    expect(businessInstant("2026-11-17T11:20:50.578Z")).toEqual({ date: "2026-11-17", time: "14:20" });
  });
  it("🔴 near midnight the DAY moves too: 22:30 UTC on the 16th is 01:30 on the 17th", () => {
    expect(businessInstant("2026-11-16T22:30:00.000Z")).toEqual({ date: "2026-11-17", time: "01:30" });
  });
  it("seconds when asked; midnight is 00, never 24", () => {
    expect(businessInstant("2026-11-17T11:29:51.000Z", { seconds: true }).time).toBe("14:29:51");
    expect(businessInstant("2026-11-16T21:00:00.000Z").time).toBe("00:00");
  });
  it("an unreadable instant keeps its own text, never a wrong time", () => {
    expect(businessInstant("not a time")).toEqual({ date: "not a time".slice(0, 10), time: "" });
  });
});

describe("fmtCount — the app's digits", () => {
  it("🔴 Latin digits with grouping, whatever the browser's locale", () => {
    expect(fmtCount(16)).toBe("16");
    expect(fmtCount(1350)).toBe("1,350");
    expect(fmtCount(1350)).not.toMatch(/[٠-٩]/);
  });
});

describe("daysAr — a day count with Arabic agreement", () => {
  it("🔴 the walk's 7 reads أيام, not يوماً", () => {
    expect(daysAr(7)).toBe("7 أيام");
  });
  it("one, two, 3–10, 11 and up, and a round hundred", () => {
    expect(daysAr(1)).toBe("يوم واحد");
    expect(daysAr(2)).toBe("يومين");
    expect(daysAr(3)).toBe("3 أيام");
    expect(daysAr(10)).toBe("10 أيام");
    expect(daysAr(11)).toBe("11 يوماً");
    expect(daysAr(30)).toBe("30 يوماً");
    expect(daysAr(100)).toBe("100 يوم");
    expect(daysAr(103)).toBe("103 أيام");
    expect(daysAr(365)).toBe("365 يوماً");
  });
});
