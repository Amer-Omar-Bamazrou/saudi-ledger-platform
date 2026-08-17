/**
 * M20.3 — the fiscal-period label. The design's own example is the fixture:
 * FY 1447 AH runs 26 Jun 2025 – 15 Jun 2026 (Umm al-Qura), and the label must
 * read "FY 1447 (Jun 2025 – Jun 2026)" — the AH year placed by its Gregorian
 * span, formatted from the API payload with NO client-side calendar math.
 */
import { describe, expect, it } from "vitest";
import { fiscalPeriodLabel } from "./fiscalLabel";

describe("fiscalPeriodLabel", () => {
  it("the design's Hijri example, verbatim", () => {
    expect(
      fiscalPeriodLabel({ label: 1447, calendar: "hijri", startDate: "2025-06-26", endDate: "2026-06-15" }),
    ).toBe("FY 1447 (Jun 2025 – Jun 2026)");
  });

  it("a same-year Gregorian period drops the duplicated year", () => {
    expect(
      fiscalPeriodLabel({ label: 2026, calendar: "gregorian", startDate: "2026-01-01", endDate: "2026-12-31" }),
    ).toBe("FY 2026 (Jan – Dec 2026)");
  });

  it("an April Gregorian year keeps both years — the case the whole of M20 exists for", () => {
    expect(
      fiscalPeriodLabel({ label: 2025, calendar: "gregorian", startDate: "2025-04-01", endDate: "2026-03-31" }),
    ).toBe("FY 2025 (Apr 2025 – Mar 2026)");
  });

  it("Arabic mirrors the structure with Gregorian month names", () => {
    expect(
      fiscalPeriodLabel({ label: 1447, calendar: "hijri", startDate: "2025-06-26", endDate: "2026-06-15" }, "ar"),
    ).toBe("السنة المالية 1447 (يونيو 2025 – يونيو 2026)");
  });
});
