/**
 * F3-dual — Hijri display, and above all THE PROBE.
 *
 * The dangerous branch is not "ICU present" (this test runner has full ICU,
 * so that branch tests itself) — it is the runtime that ACCEPTS
 * `islamic-umalqura` and silently returns Gregorian. That branch is injected
 * here, per the B3 lesson: a stub's untested branch is the part that needed
 * testing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { __setHijriProbeForTests, formatHijri, hijriAvailable, probeHijri } from "./hijriDate";

afterEach(() => __setHijriProbeForTests(null));

describe("the probe", () => {
  it("passes on a full-ICU runtime against the M17.2 fact (1 Muharram 1447 = 26 Jun 2025)", () => {
    expect(probeHijri()).toBe(true);
  });

  it("🔴 REFUSES a runtime that silently substitutes Gregorian — the M17.2 failure mode, injected", () => {
    // What a small-ICU Intl actually returns for the probe date: the
    // GREGORIAN parts, formatted without complaint.
    const gregorianSubstitution = () => ({ day: "26", month: "Jun", year: "2025" });
    expect(probeHijri(gregorianSubstitution)).toBe(false);
  });

  it("refuses a formatter that throws, rather than letting the error escape", () => {
    expect(
      probeHijri(() => {
        throw new RangeError("unsupported calendar");
      }),
    ).toBe(false);
  });
});

describe("formatHijri", () => {
  it("known conversions, both languages, Latin digits", () => {
    expect(formatHijri("2025-06-26")).toBe("1 Muh. 1447");
    expect(formatHijri("2026-08-17")).toBe("4 Rab. I 1448");
    expect(formatHijri("2025-06-26", "ar")).toBe("1 محرم 1447");
    expect(formatHijri("2026-08-17", "ar")).toBe("4 ربيع الأول 1448");
  });

  it("FY 1447's last day — the year boundary the fiscal resolver reports", () => {
    expect(formatHijri("2026-06-15")).toBe("29 Dhuʻl-H. 1447");
  });

  it("returns null for junk rather than an invalid-date artifact", () => {
    expect(formatHijri("not-a-date")).toBeNull();
    expect(formatHijri("")).toBeNull();
  });

  it("🔴 returns null — never a wrong string — when the probe failed", () => {
    __setHijriProbeForTests(false);
    expect(formatHijri("2025-06-26")).toBeNull();
  });
});
