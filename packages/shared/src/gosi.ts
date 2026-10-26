/**
 * 🔴 GOSI CONTRIBUTIONS — ONE EFFECTIVE-DATED TABLE (Phase 18, owner decision
 * 2026-10-26 night, item 2; HIGH). It replaces the single `GOSI_RATES`
 * constant, which applied the 1421H-law rates to every Saudi employee on
 * basic salary alone, with no ceiling (register §11.19, GO-01..GO-04).
 *
 * A rate change edits THIS file and nothing else (the 2026-09-03 constants
 * sweep). Every entry names its sources. A period no entry covers has NO rate:
 * `gosiRatesFor` returns null and the payroll run is refused, never computed
 * at a guessed rate.
 *
 * What is NOT settled, by name (question G1, register §11.18 E):
 *  - the 2024-law pension for periods before July 2026 (G1: 19% or 20% for
 *    July 2026). Steps take effect on 1 July each year (Saudi Press Agency,
 *    30 June 2025, as the owner directed). Royal Decree M/273 item 3, read
 *    literally, says "one year later" and "after that" without a calendar day;
 *    that literal reading is part of G1. 2024-law periods before 2026-07 are
 *    therefore absent;
 *  - the 1421H-law SANED split: 0.75% each side, per GOSI guidance, UNVERIFIED
 *    against the binding text (the totals 9.75% / 11.75% are settled);
 *  - a riyal floor for the contributory wage under the 2024 law (none applied);
 *  - a cap or a holiday extension on the late fine (none applied).
 */

/** The regime a payroll line is computed under. `non_saudi` follows from nationality. */
export type GosiRegime = "law_1421h" | "law_2024" | "non_saudi";
/** The flag an employer sets on a Saudi employee, from contribution history (never from the hire date). */
export const GOSI_EMPLOYEE_REGIMES = ["law_1421h", "law_2024"] as const;
export type GosiEmployeeRegime = (typeof GOSI_EMPLOYEE_REGIMES)[number];

/** The contributory-wage ceiling, SAR (Social Insurance Law Art. 8(2)). */
export const GOSI_WAGE_CEILING = 45_000;

export interface GosiRateEntry {
  regime: GosiRegime;
  /** The first payroll period (`YYYY-MM`) the entry applies to; the next entry for the regime ends it. */
  from: string;
  employee: { pension: number; saned: number };
  employer: { pension: number; occupationalHazards: number; saned: number };
  sources: readonly string[];
  /** Parts of the entry not verified against the binding text. */
  unverified?: readonly string[];
}

const LAW_2024_SOURCES = [
  "Social Insurance Law under Royal Decree M/273 (in force 3 July 2024), item 3 (the pension steps)",
  "Council of Ministers Decision 1022",
  "Social Insurance Law Arts. 15, 29, 44 (contributions, as listed by the owner)",
  "Saudi Press Agency, 30 June 2025: the pension steps take effect on 1 July each year",
  "Research finding 3 (register §11.18 B), read from Umm Al-Qura",
] as const;

export const GOSI_SCHEDULE: readonly GosiRateEntry[] = [
  {
    regime: "non_saudi",
    from: "0000-01",
    employee: { pension: 0, saned: 0 },
    employer: { pension: 0, occupationalHazards: 0.02, saned: 0 },
    sources: ["Occupational hazards 2%, employer only: research finding 3 (register §11.18 B)"],
  },
  {
    regime: "law_1421h",
    from: "0000-01",
    employee: { pension: 0.09, saned: 0.0075 },
    employer: { pension: 0.09, occupationalHazards: 0.02, saned: 0.0075 },
    sources: ["Saudi under the 1421H law: employer 11.75%, employee 9.75% in total (research finding 3, register §11.18 B)"],
    unverified: ["SANED 0.75% each side (and so pension 9% each side): GOSI guidance, not verified against the binding text (question G1)"],
  },
  {
    regime: "law_2024",
    from: "2026-07",
    employee: { pension: 0.1, saned: 0.0075 },
    employer: { pension: 0.1, occupationalHazards: 0.02, saned: 0.0075 },
    sources: [...LAW_2024_SOURCES, "Stated for October 2026: employer 12.75%, employee 10.75% (research finding 3)"],
  },
  {
    regime: "law_2024",
    from: "2027-07",
    employee: { pension: 0.105, saned: 0.0075 },
    employer: { pension: 0.105, occupationalHazards: 0.02, saned: 0.0075 },
    sources: [...LAW_2024_SOURCES, "Pension 21% in total, 10.5% each side, one year after the 20% step"],
  },
  {
    regime: "law_2024",
    from: "2028-07",
    employee: { pension: 0.11, saned: 0.0075 },
    employer: { pension: 0.11, occupationalHazards: 0.02, saned: 0.0075 },
    sources: [...LAW_2024_SOURCES, "Pension 22% in total, 11% each side, the step after that"],
  },
];

export interface GosiRates {
  regime: GosiRegime;
  /** The employee's share, as a fraction of the contributory wage. */
  employeeRate: number;
  /** The employer's share, as a fraction of the contributory wage. */
  employerRate: number;
  entry: GosiRateEntry;
}

/** The rates for a regime in a payroll period (`YYYY-MM`), or null when no entry covers it. */
export function gosiRatesFor(regime: GosiRegime, period: string): GosiRates | null {
  let found: GosiRateEntry | null = null;
  for (const e of GOSI_SCHEDULE) {
    if (e.regime === regime && e.from <= period && (!found || e.from > found.from)) found = e;
  }
  if (!found) return null;
  // Summed in basis points so 0.1 + 0.0075 is exactly 0.1075, not 0.10750000000000001.
  const bp = (n: number) => Math.round(n * 10_000);
  const employeeRate = (bp(found.employee.pension) + bp(found.employee.saned)) / 10_000;
  const employerRate = (bp(found.employer.pension) + bp(found.employer.occupationalHazards) + bp(found.employer.saned)) / 10_000;
  return { regime, employeeRate, employerRate, entry: found };
}

/**
 * The contributory wage: basic pay plus housing allowance (Implementing
 * Regulation Art. 17), capped at SAR 45,000 (Law Art. 8(2)). No floor is
 * applied (question G1). Not rounded here: callers round through their money seam.
 */
export function gosiContributoryWage(basic: number, housing: number): number {
  return Math.min(basic + housing, GOSI_WAGE_CEILING);
}

/** The due date of a period's contributions: the 15th of the following month (Law Art. 9(1); Regulation Art. 24). */
export function gosiDueDate(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 15)).toISOString().slice(0, 10);
}

/**
 * The late-fine ESTIMATE: 2% of the contribution due for each month or part of
 * a month after the due date (Law Art. 9(3)). Uncapped: the 2024 texts state no
 * cap and no holiday extension (question G1). Never posted.
 */
export function gosiLateFineEstimate(due: number, dueDate: string, asOf: string): { monthsLate: number; amount: number } {
  if (!(due > 0) || asOf <= dueDate) return { monthsLate: 0, amount: 0 };
  const [y1, m1, d1] = dueDate.split("-").map(Number);
  const [y2, m2, d2] = asOf.split("-").map(Number);
  const monthsLate = (y2! - y1!) * 12 + (m2! - m1!) + (d2! > d1! ? 1 : 0);
  // In halalas, so the estimate is exact to 2dp.
  const amount = Math.round(Math.round(due * 100) * 0.02 * monthsLate) / 100;
  return { monthsLate, amount };
}
