/**
 * THE DEPRECIATION SCHEDULE — pure arithmetic, no I/O (FA-A, 2026-09-22).
 * Decision record: docs/product/fixed-assets-decision-pack.md §6.
 *
 * Straight-line, monthly, full-month convention: the first period is the
 * month of `availableForUseDate` in full, the last is the month before the
 * life ends, `usefulLifeMonths` periods in total. A migrated asset continues
 * its original schedule: `openingPeriodsBooked` periods are already behind
 * it and `openingAccumulated` is already in the books, so the remaining
 * depreciable amount is spread over the remaining periods starting the month
 * AFTER the opening date.
 *
 * Rounding: ONE rounded addend per row (lib/money.ts, CLAUDE.md §4 N2), and
 * the LAST row absorbs the residue so Σ rows = the depreciable amount exactly
 * (Odoo 11 `_compute_board_amount`: the last line takes the residual). The
 * carrying amount after the last row is the residual value by construction.
 *
 * `declining_balance` and `units_of_production` are representable in the
 * schema and REFUSED here by name until built (pack §12).
 */
import { round2 } from "../../lib/money";
import { BusinessRuleError } from "../../lib/errors";

export type ScheduleInput = {
  cost: number;
  residualValue: number;
  usefulLifeMonths: number;
  depreciationMethod: string;
  /** YYYY-MM-DD — the month containing it is period 1 (IAS 16.55). */
  availableForUseDate: string;
  /** A migrated asset: what the previous system booked before the opening date. */
  openingAccumulated?: number;
  openingPeriodsBooked?: number;
  /** A migrated asset: the schedule resumes the month AFTER this date. */
  openingDate?: string | null;
};

export type ScheduleRow = { sequence: number; period: string; amount: number; accumulatedAfter: number; carryingAfter: number };

const PERIOD = /^(\d{4})-(\d{2})$/;

/** YYYY-MM of a YYYY-MM-DD. */
export function periodOf(date: string): string {
  return date.slice(0, 7);
}

/** The period `n` months after `period` (n may be negative). */
export function shiftPeriod(period: string, n: number): string {
  const m = PERIOD.exec(period);
  if (!m) throw new Error(`not a period: ${period}`);
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  const y = Math.floor(total / 12);
  const mo = (total % 12) + 1;
  return `${y}-${String(mo).padStart(2, "0")}`;
}

/** The last calendar day of a period, YYYY-MM-DD — the date a period's depreciation entry carries. */
export function lastDayOf(period: string): string {
  const m = PERIOD.exec(period);
  if (!m) throw new Error(`not a period: ${period}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${period}-${String(last).padStart(2, "0")}`;
}

export function assertMethodSupported(method: string): void {
  if (method !== "straight_line") {
    throw new BusinessRuleError(422, {
      code: "depreciation_method_unsupported",
      error: `Depreciation method ${method} is not computed yet — straight-line is the one method the schedule engine runs (fixed-assets pack §6, §12). The register admits the value so the asset can be recorded; its schedule cannot be generated until the method is built.`,
      field: "depreciationMethod",
    });
  }
}

/**
 * Generate the whole schedule. Returns the rows AFTER the opening position:
 * sequence numbers continue the original life (a migrated asset's first row
 * is `openingPeriodsBooked + 1`), so "which period of the life is this" stays
 * a fact of the row.
 */
export function generateStraightLineSchedule(input: ScheduleInput): ScheduleRow[] {
  assertMethodSupported(input.depreciationMethod);
  const cost = round2(input.cost);
  const residual = round2(input.residualValue);
  const life = Math.trunc(input.usefulLifeMonths);
  const booked = Math.trunc(input.openingPeriodsBooked ?? 0);
  const openingAccumulated = round2(input.openingAccumulated ?? 0);
  if (!(life > 0)) throw new BusinessRuleError(422, { code: "useful_life_invalid", error: "The useful life must be at least one month.", field: "usefulLifeMonths" });
  if (residual < 0 || residual > cost) throw new BusinessRuleError(422, { code: "residual_value_invalid", error: "The residual value must lie between zero and the cost (IAS 16.53).", field: "residualValue" });
  if (booked < 0 || booked > life) throw new BusinessRuleError(422, { code: "opening_periods_invalid", error: "The periods already booked cannot exceed the useful life.", field: "openingPeriodsBooked" });
  const depreciable = round2(cost - residual - openingAccumulated);
  if (depreciable < 0) throw new BusinessRuleError(422, { code: "opening_accumulated_invalid", error: "The opening accumulated depreciation exceeds the depreciable amount (cost − residual).", field: "openingAccumulatedDepreciation" });
  const remaining = life - booked;
  if (remaining === 0) return []; // fully depreciated on arrival — still on the balance sheet, no rows
  // period 1 is the month of the available-for-use date; a migrated asset resumes the month after the opening date
  const first = input.openingDate ? shiftPeriod(periodOf(input.openingDate), 1) : periodOf(input.availableForUseDate);
  const perPeriod = round2(depreciable / remaining);
  const rows: ScheduleRow[] = [];
  let accumulated = openingAccumulated;
  for (let i = 0; i < remaining; i++) {
    const isLast = i === remaining - 1;
    const amount = isLast ? round2(depreciable - round2(perPeriod * (remaining - 1))) : perPeriod;
    accumulated = round2(accumulated + amount);
    rows.push({
      sequence: booked + i + 1,
      period: shiftPeriod(first, i),
      amount,
      accumulatedAfter: accumulated,
      carryingAfter: round2(cost - accumulated),
    });
  }
  return rows;
}
