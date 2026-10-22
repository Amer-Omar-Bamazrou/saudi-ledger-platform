/**
 * 🔴 G18 (calendar half) — the ONE definition of a real calendar day, and the
 * posting seam's refusal, without a database.
 *
 * `isCalendarDate` (`@workspace/shared`, beside the business-date seam) is the
 * single definition every posting guard asks; the api's `assertDateString` is
 * held to it here, so the two cannot drift (two definitions of one fact with
 * no forcing function diverge invisibly). The seam (`postJournalEntry`) must
 * refuse a non-day BEFORE its first query: no tenant transaction exists in this
 * file, so any query would fail with a different error than the one asserted.
 *
 * The HTTP proof, per endpoint, is `g18-calendar-invalid-dates.test.ts`.
 * DB-free.
 */
import { describe, expect, it } from "vitest";
import { isCalendarDate } from "@workspace/shared";
import { assertDateString } from "../lib/writeGuards";
import { postJournalEntry } from "../services/accounting/glPosting";

const REAL_DAYS = ["2026-01-01", "2026-02-28", "2026-04-30", "2026-12-31", "2028-02-29", "2000-02-29"];
const NOT_DAYS: unknown[] = [
  "2026-02-29", "1900-02-29", "2026-02-30", "2026-02-31", "2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31",
  "2026-13-01", "2026-00-10", "2026-01-00", "2026-01-32",
  "", " 2026-02-01", "2026-2-1", "2026-02-01T00:00:00Z", "banana",
  null, undefined, 20260201, new Date(Date.UTC(2026, 1, 1)),
];

describe("G18 — isCalendarDate is the one definition of a real day", () => {
  it("accepts real days, leap days included", () => {
    expect(REAL_DAYS.filter((d) => !isCalendarDate(d))).toEqual([]);
  });

  it("🔴 refuses a day that does not exist, a malformed string, and anything not a string", () => {
    expect(NOT_DAYS.filter((d) => isCalendarDate(d))).toEqual([]);
  });

  it("🔴 the api's assertDateString refuses EXACTLY what isCalendarDate refuses (no second definition)", () => {
    const refuses = (v: unknown) => { try { assertDateString(v, "date"); return false; } catch { return true; } };
    const disagreements = [...REAL_DAYS, ...NOT_DAYS].filter((v) => refuses(v) === isCalendarDate(v));
    expect(disagreements).toEqual([]);
  });
});

describe("G18 — the posting seam refuses a non-day for every caller, before any query", () => {
  const entry = (date: string) => ({
    entryNumber: "G18-UNIT",
    date,
    description: "G18 seam unit",
    lines: [
      { accountId: 1, accountName: "A", debitAmount: 10, creditAmount: 0 },
      { accountId: 2, accountName: "B", debitAmount: 0, creditAmount: 10 },
    ],
  });

  for (const date of ["2026-02-31", "2026-04-31", "2026-02-29"]) {
    it(`🔴 ${date} → 422 date_invalid, naming the date (nothing read, nothing written)`, async () => {
      const err = await postJournalEntry(entry(date)).then(
        () => null,
        (e: unknown) => e as { statusCode?: number; payload?: { code?: string; field?: string; error?: string } },
      );
      expect(err?.statusCode).toBe(422);
      expect(err?.payload?.code).toBe("date_invalid");
      expect(err?.payload?.field).toBe("date");
      expect(err?.payload?.error).toContain(date);
    });
  }
});
