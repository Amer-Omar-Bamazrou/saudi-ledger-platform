/**
 * FA-F (2026-09-22) — the VAT capital-asset adjustment (IR Art. 52), as
 * arithmetic, and the Art. 51 proportional fraction it consumes.
 *
 * Record: docs/product/fixed-assets-decision-pack.md §7, §25.
 * Accountant FA-2: the annual adjustment IS computed in v1, partially exempt
 * tenants included.
 *
 * 🔴 Read from the pinned primary text
 * (`docs/zatca/specs/KSA_VAT_Implementing_Regulations_EN.txt`, the Eighth
 * Edition English translation — the Arabic prevails, so readings that turn on
 * wording are marked):
 *
 *   52(2) "…six (6) years in respect of moveable … and ten (10) years in
 *         respect of immovable Capital Assets …, starting from the date of
 *         purchase …. Should the life … be less than the otherwise
 *         corresponding adjustment period, the adjustment period shall instead
 *         be the life of the Capital Asset, with any part years counting as
 *         one year."
 *   52(4) "…calculate the amount of Input Tax potentially subject to
 *         adjustment using the fraction: Initial Input Tax deduction /
 *         adjustment period … and shall make an adjustment to the amount of
 *         the Input Tax deducted, based on the actual use of the Capital Asset
 *         during that year."
 *   52(5) "…the first twelve-month period shall commence from the start of the
 *         Tax Period in which the Capital Asset was acquired … The Taxable
 *         Person shall make the adjustment … in the Tax Return for the last
 *         Tax Period which falls in the twelve month-period…"
 *   52(6) "In cases where there is no change in the use … the Taxable Person
 *         is not required to adjust Input Tax … for that year."
 *   52(7) "…due to the sale or disposal …, the Taxable Person must adjust the
 *         Input Tax deduction for the remainder of the adjustment period … in
 *         the Tax Period in which it is sold. No adjustment … is needed if the
 *         Capital Asset is destroyed, stolen or before the end of its useful
 *         life earlier than accounted for."
 *   52(8) a withdrawal from the taxable activity is NOT an adjustment but a
 *         Nominal Supply (valued by FA-C at disposal).
 *   51(4) the default proportional fraction: numerator the value of Taxable
 *         Supplies in the LAST CALENDAR YEAR, denominator Taxable plus Exempt
 *         Supplies in that year.
 *   51(5) the fraction excludes "Supplies of Capital Assets by the Taxable
 *         Person" and supplies made from an establishment outside the Kingdom.
 *
 * 🔴 THREE CLOCKS, NEVER SUBSTITUTED FOR ONE ANOTHER. Art. 52's window runs
 * twelve months from the start of the TAX PERIOD of acquisition; Art. 51's
 * fraction runs on the CALENDAR year; the company's FISCAL year (which the
 * Art. 17 pool uses) runs on neither. Each is resolved from its own source and
 * every figure below states which window it belongs to.
 */
import { round2 } from "../../lib/money.js";

export type VatTaxPeriod = "monthly" | "quarterly";

/** Art. 52(2): 6 y movable, 10 y immovable, shortened to the accounting life with part years counting as one. */
export function adjustmentPeriodYears(vatClass: string, usefulLifeMonths: number): number | null {
  if (vatClass === "not_capital") return null;
  const statutory = vatClass === "immovable" ? 10 : 6;
  const lifeYears = Math.ceil(usefulLifeMonths / 12);
  return Math.max(1, Math.min(statutory, lifeYears));
}

/**
 * Art. 52(5): the start of the TAX PERIOD containing `acquisitionDate`.
 *
 * Monthly periods are calendar months; quarterly periods are the calendar
 * quarters Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec. 🔴 *Reasoned-not-verified*: the
 * Regulations set the LENGTH of a tax period (Art. 58) and not its alignment,
 * and every ZATCA filing calendar in use aligns them to the calendar year —
 * the same year Art. 51's fraction runs on. A company whose ZATCA periods were
 * aligned otherwise would need this to become a stored fact rather than a
 * convention; it is stated on the report so the reader can check it.
 */
export function taxPeriodStart(acquisitionDate: string, period: VatTaxPeriod): string {
  const [y, m] = acquisitionDate.split("-").map(Number) as [number, number, number];
  const month = period === "monthly" ? m : Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(month).padStart(2, "0")}-01`;
}

/** The last day of the month `months` after `isoFirstOfMonth`, exclusive-end arithmetic kept out of the callers. */
function addMonths(isoFirstOfMonth: string, months: number): string {
  const [y, m] = isoFirstOfMonth.split("-").map(Number) as [number, number, number];
  const total = (y * 12 + (m - 1)) + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
}
const dayBefore = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

export interface AdjustmentWindow {
  /** 1-based, as Art. 52(5) counts them. */
  index: number;
  startDate: string;
  endDate: string;
  /** Art. 52(5): the return that carries the adjustment — the LAST tax period falling in the window. */
  returnPeriodStart: string;
  returnPeriodEnd: string;
}

/** Every twelve-month window of the adjustment period, with the return each one's adjustment belongs to. */
export function adjustmentWindows(acquisitionDate: string, period: VatTaxPeriod, years: number): AdjustmentWindow[] {
  const first = taxPeriodStart(acquisitionDate, period);
  const periodMonths = period === "monthly" ? 1 : 3;
  const out: AdjustmentWindow[] = [];
  for (let i = 0; i < years; i++) {
    const start = addMonths(first, i * 12);
    const nextStart = addMonths(first, (i + 1) * 12);
    // The last tax period wholly inside the window ends on its last day.
    const returnStart = addMonths(nextStart, -periodMonths);
    out.push({ index: i + 1, startDate: start, endDate: dayBefore(nextStart), returnPeriodStart: returnStart, returnPeriodEnd: dayBefore(nextStart) });
  }
  return out;
}

/**
 * Art. 51(4)–(5): the default proportional deduction, as a percentage.
 *
 * `null` when the denominator is zero — a year with no taxable and no exempt
 * supplies has no fraction, and 🔴 returning 0 there would read as "wholly
 * exempt", which is the opposite of what an empty year means. The caller must
 * handle the absence; it is never silently a number.
 */
export function proportionalDeductionPct(taxableSupplies: number, exemptSupplies: number): number | null {
  const denominator = round2(taxableSupplies + exemptSupplies);
  if (denominator <= 0) return null;
  return round2((taxableSupplies / denominator) * 100);
}

export interface AdjustmentYearInput {
  window: AdjustmentWindow;
  /** Art. 52(4): initial input tax deducted ÷ adjustment period. */
  potentiallyAdjustable: number;
  initialRecoveryPct: number;
  /** The actual taxable use in the window, or null when neither declared nor derivable. */
  actualUsePct: number | null;
  actualUseSource: "declared" | "proportional" | "unavailable";
}

export interface AdjustmentYearResult extends AdjustmentYearInput {
  /** Positive: more input tax is recoverable. Negative: input tax is repaid. */
  adjustment: number;
  /** Art. 52(6) — no change of use, so no adjustment is required for the year. */
  noChangeOfUse: boolean;
}

/**
 * One twelve-month window. Art. 52(4) with Art. 52(6) on top of it.
 *
 * 🔴 `noChangeOfUse` is reported SEPARATELY from an adjustment of zero. They
 * are arithmetically identical and legally different: 52(6) says the taxpayer
 * "is not required to adjust", which is a reason, while a computed zero is a
 * result. A working paper that showed only the zero could not evidence either.
 */
export function computeAdjustmentYear(input: AdjustmentYearInput): AdjustmentYearResult {
  if (input.actualUsePct === null) {
    return { ...input, adjustment: 0, noChangeOfUse: false };
  }
  const noChangeOfUse = Math.abs(input.actualUsePct - input.initialRecoveryPct) < 0.005;
  const adjustment = noChangeOfUse ? 0 : round2((input.potentiallyAdjustable * (input.actualUsePct - input.initialRecoveryPct)) / 100);
  return { ...input, adjustment, noChangeOfUse };
}

export type DisposalAdjustmentKind = "sold" | "scrapped" | "destroyed" | "stolen" | "withdrawn";

export interface DisposalAdjustmentResult {
  /** How many whole windows of the adjustment period were still to run after the one containing the disposal. */
  remainingPeriods: number;
  /** The use the asset is treated as having for the remainder. */
  useAfterChangePct: number | null;
  adjustment: number;
  /** Which limb of Art. 52 applies, in words, so the figure can be defended. */
  rule: string;
}

/**
 * Art. 52(7)/(8) at disposal.
 *
 * A SALE as a taxable supply is a permanent change to 100 % taxable use for the
 * remainder, so a partially recovered asset recovers the rest of its input tax
 * over the windows that were still to run. Art. 52(7) excludes destruction,
 * theft and an early end of life in terms; Art. 52(8) replaces the adjustment
 * with a nominal supply for a withdrawal (valued by FA-C at the disposal).
 *
 * 🔴 A restricted motor vehicle sold out of scope (Art. 50(3)) reaches this
 * with an initial recovery of 0 %, and its `potentiallyAdjustable` is therefore
 * 0 — the figure falls out rather than being special-cased, which is why the
 * caller passes the amount rather than the asset.
 */
export function computeDisposalAdjustment(args: {
  kind: DisposalAdjustmentKind;
  /** The window the disposal date falls in, 1-based; 0 when it falls outside the adjustment period entirely. */
  windowIndexOfDisposal: number;
  adjustmentPeriodYears: number;
  potentiallyAdjustable: number;
  initialRecoveryPct: number;
  /** True when the sale was a taxable supply (an out-of-scope restricted-vehicle sale is not). */
  saleIsTaxableSupply: boolean;
}): DisposalAdjustmentResult {
  const remainingPeriods = Math.max(0, args.adjustmentPeriodYears - Math.max(args.windowIndexOfDisposal, 0));

  // 🔴 Destruction, theft and an early end of life are ONE limb of Art. 52(7)
  // and reach the same figure, but a working paper has to say which of them
  // happened — an adjustment of nil is only evidence if it carries its cause.
  if (args.kind === "destroyed" || args.kind === "stolen") {
    return { remainingPeriods, useAfterChangePct: null, adjustment: 0, rule: `Art. 52(7): no adjustment is needed for the remainder where the asset is destroyed or stolen — here, ${args.kind}.` };
  }
  if (args.kind === "scrapped") {
    return { remainingPeriods, useAfterChangePct: null, adjustment: 0, rule: "Art. 52(7): no adjustment is needed where the asset ends its life earlier than accounted for." };
  }
  if (args.kind === "withdrawn") {
    return { remainingPeriods, useAfterChangePct: null, adjustment: 0, rule: "Art. 52(8): a withdrawal from the taxable activity is not an adjustment — it is a Nominal Supply, valued by the Art. 52(8) formula at the disposal." };
  }
  if (!args.saleIsTaxableSupply) {
    return { remainingPeriods, useAfterChangePct: null, adjustment: 0, rule: "Art. 50(3): the sale of a restricted motor vehicle bought without deduction is not made in the course of the economic activity, so no input tax was deducted and there is nothing to adjust." };
  }
  if (remainingPeriods === 0) {
    return { remainingPeriods: 0, useAfterChangePct: 100, adjustment: 0, rule: "Art. 52(7): the adjustment period had already run its course before the sale." };
  }
  const adjustment = round2((remainingPeriods * args.potentiallyAdjustable * (100 - args.initialRecoveryPct)) / 100);
  return {
    remainingPeriods,
    useAfterChangePct: 100,
    adjustment,
    rule: adjustment === 0
      ? "Art. 52(7): the sale is a taxable supply and the input tax was already recovered in full, so the remainder needs no adjustment."
      : `Art. 52(7): the sale is a taxable supply, so the remaining ${remainingPeriods} period(s) are treated as 100 % taxable use and the unrecovered share is adjusted in the tax period of sale.`,
  };
}
