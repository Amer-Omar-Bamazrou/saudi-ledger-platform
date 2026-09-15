import { describe, expect, it } from "vitest";
import { fmtDate } from "./api";

/**
 * 🔴 The one date formatter renders in the reader's language (2026-09-15).
 * No string literal was involved when it did not, so no source sweep could
 * see it — this test is what sees it.
 */
describe("fmtDate", () => {
  it("English: en-SA short month, Latin digits", () => {
    expect(fmtDate("2026-09-15", "en")).toMatch(/Sep 15, 2026|15 Sep 2026/);
  });
  it("🔴 Arabic: an Arabic month name, Latin digits, the GREGORIAN calendar (not the ICU default Islamic one)", () => {
    const out = fmtDate("2026-09-15", "ar");
    expect(out).toMatch(/سبتمبر|سبتمبر/);
    expect(out).toContain("2026");
    expect(out).not.toMatch(/[٠-٩]/);
    expect(out).not.toMatch(/1448|ربيع/);
  });
  it("the two languages differ — the parameter is not decorative", () => {
    expect(fmtDate("2026-09-15", "ar")).not.toBe(fmtDate("2026-09-15", "en"));
  });
});
