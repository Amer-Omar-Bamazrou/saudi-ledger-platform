/**
 * 🔴 19B S6 (control 19B-S6A) — a saved report's period: ONE resolver (`@workspace/shared`), used by the browser and by the server, and
 * one list of period names that the database's own check agrees with.
 *
 *  - Each named period is the CALENDAR's, worked out from the business day it is given: the month and quarter ends are
 *    real (a 28-, 29-, 30- and 31-day month), and January's "last month" and "last quarter" are in the year before.
 *  - A fixed period is its own dates; a missing or unreal date, or an end before its start, resolves to nothing — never
 *    a guessed window.
 *  - The names the resolver knows are exactly the names the table accepts (two definitions of one fact, held together).
 */
import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { REPORT_PERIOD_KINDS, REPORT_PERIOD_LABELS, resolveReportPeriod, type ReportPeriodKind } from "@workspace/shared";

const named = (kind: ReportPeriodKind, today: string) => resolveReportPeriod({ kind, from: null, to: null }, today);
const url = process.env.DATABASE_URL;
const itDb = !!url && !url.includes("placeholder") ? it : it.skip;

describe("19B S6 — the report period resolver", () => {
  it("🔴 every named period, from a mid-year day", () => {
    const today = "2026-11-26";
    expect(Object.fromEntries(REPORT_PERIOD_KINDS.filter((k) => k !== "fixed").map((k) => [k, named(k, today)]))).toEqual({
      this_month: { from: "2026-11-01", to: "2026-11-30" },
      last_month: { from: "2026-10-01", to: "2026-10-31" },
      this_quarter: { from: "2026-10-01", to: "2026-12-31" },
      last_quarter: { from: "2026-07-01", to: "2026-09-30" },
      this_year: { from: "2026-01-01", to: "2026-12-31" },
      last_year: { from: "2025-01-01", to: "2025-12-31" },
    });
  });

  it("🔴 the edges: January reaches back a year; February ends on its real last day; the first and last day of a month agree", () => {
    expect(named("last_month", "2027-01-15")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(named("last_quarter", "2027-02-01")).toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(named("this_quarter", "2027-03-31")).toEqual({ from: "2027-01-01", to: "2027-03-31" });
    expect(named("this_month", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" }); // a leap year
    expect(named("last_month", "2027-03-31")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
    expect(named("this_month", "2026-11-01")).toEqual(named("this_month", "2026-11-30"));
    expect(named("this_month", "2026-12-01")).not.toEqual(named("this_month", "2026-11-30")); // and the next day moves it
  });

  it("🔴 a fixed period is its own dates; a malformed one resolves to nothing", () => {
    const fixed = (from: string | null, to: string | null) => resolveReportPeriod({ kind: "fixed", from, to }, "2026-11-26");
    expect(fixed("2026-01-05", "2026-01-05")).toEqual({ from: "2026-01-05", to: "2026-01-05" });
    expect([fixed(null, "2026-01-05"), fixed("2026-01-05", null), fixed("2026-02-30", "2026-03-01"), fixed("2026-03-02", "2026-03-01"), fixed("26-1-5", "2026-03-01")]).toEqual([null, null, null, null, null]);
    expect(named("this_month", "not a day")).toBeNull();
  });

  it("every period has its words in both languages", () => {
    for (const k of REPORT_PERIOD_KINDS) expect(REPORT_PERIOD_LABELS[k].every((w) => w.length > 0), k).toBe(true);
  });

  itDb("🔴 the table accepts exactly the names the resolver knows", async () => {
    const { rows } = await pool.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'report_definitions_period_chk'`);
    const inDb = [...String(rows[0].def).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(inDb).toEqual([...REPORT_PERIOD_KINDS].sort());
  });
});
