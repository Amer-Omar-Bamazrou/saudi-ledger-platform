/**
 * 🔴 GOSI CONTRIBUTIONS — ONE EFFECTIVE-DATED TABLE (Phase 18, owner decision
 * 2026-10-26 night, item 2; HIGH). It replaces the single `GOSI_RATES`
 * constant, which applied the 1421H-law rates to every Saudi employee on
 * basic salary alone, with no ceiling (register §11.19, GO-01..GO-04).
 *
 * A rate or rule change edits THIS file and nothing else (the 2026-09-03
 * constants sweep). Every entry names its sources. A period no entry covers has
 * NO rate: `gosiRatesFor` returns null and the payroll run is refused, never
 * computed at a guessed rate.
 *
 * The 2024-law pension steps (Royal Decree M/273 item 3(1)): 9% each side from
 * July 2024, 9.5% from July 2025 (owner, 2026-10-26 late), then 10%, 10.5% and
 * 11%. Each step takes effect on 1 July (Saudi Press Agency, 30 June 2025, as
 * the owner directed). A 2024-law period before July 2024, when the law took
 * effect, has no entry and is refused.
 *
 * The contribution rules beyond the rates (GO-10..GO-13, owner 2026-10-27;
 * register §11.26) sit ON the entries, each where its own law states it:
 *  - 1421H law (Registration and Contributions Regulation): the pension floor
 *    of a SAR 1,500 wage (Art. 19(1)); the 100% cap on late fines (Art. 30(1));
 *    the contributory wage fixed for the year (Art. 21(2)(a),(b)); the joining
 *    and leaving months charged by days of service (Art. 21(3), owner
 *    2026-10-27 morning), over the month's actual days — an INTERPRETATION, as
 *    Art. 21(3) names no divisor.
 *  - 2024 law (2024 Implementing Regulation): the joining and leaving months
 *    charged by days of service (Art. 20(2)), over the month's actual days
 *    (its Arts. 36(1) and 53(3)).
 *  - Both: in-kind housing in the contributory wage (1421H Art. 16(c); 2024
 *    Art. 17(c)), valued by INTERPRETATION (see `gosiInKindHousingValue`).
 *
 * What is NOT settled, by name (question G1, register §11.18 E and §11.26):
 *  - the 2024-law pension for July 2026 (G1: 19% or 20% in total), and the
 *    step timing;
 *  - the 1421H-law SANED split: 0.75% each side, per GOSI guidance, UNVERIFIED
 *    against the binding text (the totals 9.75% / 11.75% are settled);
 *  - under the 2024 law: a riyal floor (Law Art. 8(1) names "the minimum wage
 *    set by the competent authority", no figure), a cap or a holiday extension
 *    on the late fine, and a wage fixed for the year — none applied;
 *  - the in-kind housing valuation's time unit, and the Governor's exempt cases;
 *  - 1421H law: whether GOSI invoices the joining and leaving months by days
 *    (Art. 21(3), applied here) or as its Employer FAQ #11 says (the joining
 *    month in full; the leaving month only when service ends on its last day).
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
  /** GO-10: the PENSION share, both sides, is never less than that for this monthly wage (other branches stay on the actual wage). */
  pensionFloorWage?: number;
  /** GO-11: the late fine never exceeds 100% of the contribution it is charged on. */
  lateFineCappedAtContribution?: true;
  /** GO-12: the contributory wage is the one due in January, or in a joiner's first month, for the rest of the calendar year. */
  wageFixedForYear?: true;
  /** GO-12: the joining and leaving months are charged by days of service, divided by the month's actual days. */
  prorateJoiningAndLeavingMonths?: true;
}

const LAW_2024_SOURCES = [
  "Social Insurance Law under Royal Decree M/273 (in force 3 July 2024), item 3 (the pension steps)",
  "Council of Ministers Decision 1022",
  "Social Insurance Law Arts. 15, 29, 44 (contributions, as listed by the owner)",
  "Saudi Press Agency, 30 June 2025: the pension steps take effect on 1 July each year",
  "Research finding 3 (register §11.18 B), read from Umm Al-Qura",
  "2024 Implementing Regulation Art. 20(2): the joining and leaving months by days of service; Arts. 36(1), 53(3): over the month's actual days (Umm Al-Qura, 5 July 2024)",
] as const;
const LAW_2024_RULES = { prorateJoiningAndLeavingMonths: true } as const;

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
    sources: [
      "Saudi under the 1421H law: employer 11.75%, employee 9.75% in total (research finding 3, register §11.18 B)",
      "1421H Registration and Contributions Regulation (GOSI-published): Art. 19(1) the pension floor of a SAR 1,500 wage; Art. 30(1) late fines at most 100% of the contributions; Art. 21(2)(a),(b) the wage due in January (or a joiner's first month) for the year",
      "Royal Decree M/273 item 4: the 1421H law continues to apply to members with earlier uncompensated contribution periods",
      "1421H Registration and Contributions Regulation Art. 21(3): the joining and leaving months by days of service (owner, 2026-10-27 morning)",
    ],
    unverified: [
      "SANED 0.75% each side (and so pension 9% each side): GOSI guidance, not verified against the binding text (question G1)",
      "The proration divisor, the month's actual days: an INTERPRETATION matching the 2024 rule, as Art. 21(3) names none (owner, 2026-10-27 morning); GOSI's Employer FAQ #11 reads otherwise (question G1)",
    ],
    pensionFloorWage: 1_500,
    lateFineCappedAtContribution: true,
    wageFixedForYear: true,
    prorateJoiningAndLeavingMonths: true,
  },
  {
    regime: "law_2024",
    from: "2024-07",
    employee: { pension: 0.09, saned: 0.0075 },
    employer: { pension: 0.09, occupationalHazards: 0.02, saned: 0.0075 },
    sources: [...LAW_2024_SOURCES, "Pension 18% in total, 9% each side, from July 2024 (owner, 2026-10-26 late)"],
    ...LAW_2024_RULES,
  },
  {
    regime: "law_2024",
    from: "2025-07",
    employee: { pension: 0.095, saned: 0.0075 },
    employer: { pension: 0.095, occupationalHazards: 0.02, saned: 0.0075 },
    sources: [...LAW_2024_SOURCES, "Pension 19% in total, 9.5% each side, from July 2025 (owner, 2026-10-26 late)"],
    ...LAW_2024_RULES,
  },
  {
    regime: "law_2024",
    from: "2026-07",
    employee: { pension: 0.1, saned: 0.0075 },
    employer: { pension: 0.1, occupationalHazards: 0.02, saned: 0.0075 },
    sources: [...LAW_2024_SOURCES, "Stated for October 2026: employer 12.75%, employee 10.75% (research finding 3)"],
    ...LAW_2024_RULES,
  },
  {
    regime: "law_2024",
    from: "2027-07",
    employee: { pension: 0.105, saned: 0.0075 },
    employer: { pension: 0.105, occupationalHazards: 0.02, saned: 0.0075 },
    sources: [...LAW_2024_SOURCES, "Pension 21% in total, 10.5% each side, one year after the 20% step"],
    ...LAW_2024_RULES,
  },
  {
    regime: "law_2024",
    from: "2028-07",
    employee: { pension: 0.11, saned: 0.0075 },
    employer: { pension: 0.11, occupationalHazards: 0.02, saned: 0.0075 },
    sources: [...LAW_2024_SOURCES, "Pension 22% in total, 11% each side, the step after that"],
    ...LAW_2024_RULES,
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
 * 🔴 GO-13: the months of basic wage a year that in-kind housing counts for —
 * an INTERPRETATION (owner, 2026-10-27), not a stated rule. Both regulations
 * value it at «الراتب الأساس عن شهرين» (1421H Art. 16(c); 2024 Art. 17(c))
 * without a time unit; read as a year's value, it adds basic × 2 ÷ 12 a month.
 * Question G1 asks the specialist to confirm it.
 */
export const GOSI_IN_KIND_HOUSING_MONTHS_A_YEAR = 2;

/** GO-13: the monthly value in-kind housing adds to the contributory wage. Not rounded here: callers round through their money seam. */
export function gosiInKindHousingValue(basic: number): number {
  return (basic * GOSI_IN_KIND_HOUSING_MONTHS_A_YEAR) / 12;
}

/**
 * The contributory wage: basic pay plus the housing allowance — cash, and the
 * value of in-kind housing (1421H Regulation Art. 16; 2024 Regulation Art. 17)
 * — capped at SAR 45,000 (Law Art. 8(2)). Not rounded here: callers round
 * through their money seam.
 */
export function gosiContributoryWage(basic: number, housing: number, inKindHousing = 0): number {
  return Math.min(basic + housing + inKindHousing, GOSI_WAGE_CEILING);
}

/**
 * 🔴 GO-12: the days of service in a payroll period for an employee who joined
 * or left in it, and the month's actual days; null for a full month (neither
 * date in the period, or the dates covering every day of it). 2024 Regulation
 * Art. 20(2), over the month's actual days (Arts. 36(1), 53(3)); 1421H
 * Regulation Art. 21(3), over the same divisor by interpretation (it names none).
 * A leaving date before the joining date in the same month is not a span of
 * service, and is left to the full month.
 */
export function gosiServiceDays(period: string, joiningDate: string | null, endDate: string | null): { serviceDays: number; periodDays: number } | null {
  const [y, m] = period.split("-").map(Number);
  const periodDays = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const inPeriod = (d: string | null): d is string => !!d && d.slice(0, 7) === period;
  if (!inPeriod(joiningDate) && !inPeriod(endDate)) return null;
  const first = inPeriod(joiningDate) ? Number(joiningDate.slice(8, 10)) : 1;
  const last = inPeriod(endDate) ? Number(endDate.slice(8, 10)) : periodDays;
  const serviceDays = last - first + 1;
  if (serviceDays < 1 || serviceDays >= periodDays) return null;
  return { serviceDays, periodDays };
}

/**
 * One payroll line's contributions, UNROUNDED (callers round through their
 * money seam), from the rates, the monthly contributory wage and — where the
 * entry prorates — the days of service.
 *  - GO-10: where the entry has a pension floor and the wage is below it, the
 *    pension share (both sides) is charged on the floor; the other branches stay
 *    on the actual wage. `pensionFloorWage` says when it applied.
 *  - GO-12: a joining or leaving month is wage × rate × days ÷ the month's days,
 *    applied after the floor: the contribution for a SAR 1,500 wage over the
 *    same days (an interpretation; Art. 19(1) speaks of the monthly contribution).
 * With neither, the figure is exactly `wage × rate`, as before.
 */
export function gosiLineAmounts(input: {
  rates: GosiRates;
  wage: number;
  serviceDays?: number | null;
  periodDays?: number | null;
}): { employee: number; employer: number; pensionFloorWage: number | null } {
  const { rates, wage } = input;
  const e = rates.entry;
  const pensionFloorWage = e.pensionFloorWage !== undefined && wage < e.pensionFloorWage ? e.pensionFloorWage : null;
  const lift = pensionFloorWage === null ? 0 : pensionFloorWage - wage;
  let employee = wage * rates.employeeRate + lift * e.employee.pension;
  let employer = wage * rates.employerRate + lift * e.employer.pension;
  if (e.prorateJoiningAndLeavingMonths && input.serviceDays != null && input.periodDays) {
    employee = (employee * input.serviceDays) / input.periodDays;
    employer = (employer * input.serviceDays) / input.periodDays;
  }
  return { employee, employer, pensionFloorWage };
}

/** The due date of a period's contributions: the 15th of the following month (Law Art. 9(1); Regulation Art. 24). */
export function gosiDueDate(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 15)).toISOString().slice(0, 10);
}

/**
 * The late-fine ESTIMATE: 2% of the contribution due for each month or part of
 * a month after the due date (Law Art. 9(3)). Never posted.
 * 🔴 GO-11: `cappedPart` is the part of `due` whose fine may not exceed 100% of
 * it (the 1421H-law contributions: Registration and Contributions Regulation
 * Art. 30(1)). The rest is uncapped: the 2024 texts state no cap (question G1).
 * The cap can only bind after 50 months, so below that the figure is unchanged.
 */
export function gosiLateFineEstimate(due: number, dueDate: string, asOf: string, cappedPart = 0): { monthsLate: number; amount: number } {
  if (!(due > 0) || asOf <= dueDate) return { monthsLate: 0, amount: 0 };
  const [y1, m1, d1] = dueDate.split("-").map(Number);
  const [y2, m2, d2] = asOf.split("-").map(Number);
  const monthsLate = (y2! - y1!) * 12 + (m2! - m1!) + (d2! > d1! ? 1 : 0);
  // In halalas, so the estimate is exact to 2dp.
  const dueH = Math.round(due * 100);
  const fine = (h: number) => Math.round(h * 0.02 * monthsLate);
  if (monthsLate <= 50) return { monthsLate, amount: fine(dueH) / 100 };
  const capH = Math.min(Math.max(Math.round(cappedPart * 100), 0), dueH);
  return { monthsLate, amount: (capH + fine(dueH - capH)) / 100 };
}
