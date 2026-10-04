/**
 * THE ZAKAT BASE — pure arithmetic of the Implementing Regulations for Zakat
 * Collection (MoF Decision 1007, 19/08/1445H, as amended by 1248), read in
 * Arabic (docs/product/phase-16-17-tax-treasury-decision-pack.md §3.4).
 *
 * No database, no clock: every input is passed in, every step is returned
 * with its article, so the working paper SHOWS the computation rather than
 * asserting it. All amounts are integer HALALAS.
 *
 *   Art. 21   base = Art. 23 additions − Art. 26 deductions, subject to 27/28
 *   Art. 23   (1) equity · (2) Art. 29 liabilities within the deducted assets · (3) adjusted − book NP
 *   Art. 24   provisions as equity (end-of-service / leave are non-current liabilities)
 *   Art. 25   liability placement: (1) exclude ∝ undeducted non-current assets; (2) add ∝ deducted
 *             current assets; (4) total liabilities added ≤ total deductions
 *   Art. 29(2)(b)  current liabilities above current assets are added
 *   Art. 27   the minimum (an alternative base on the results of the activity)
 *   Art. 28   the maximum (equity and equivalents + the adjusted − book difference)
 *   Art. 15   2.5 % for a Hijri year; (2.5 % ÷ 354) × days otherwise (owner Q3; C3 divisor OPEN)
 */
import type { ZakatClass } from "@workspace/db";

export type ZakatLine = { accountId: number | null; key: string; name: string; nameAr: string; zakatClass: ZakatClass | "equity_computed"; amountH: number };

export interface ZakatInputs {
  /** Every balance-sheet account with a balance at the year-end, classified; equity accounts and the computed result rows as `equity`/`equity_computed`. Amounts: assets debit-positive, liabilities and equity credit-positive. */
  lines: ZakatLine[];
  /** The balance sheet's total assets at the year-end — Σ asset lines must equal it (invariant Z1). */
  totalAssetsH: number;
  /** Book net profit for the fiscal year (credit-positive), before this computation's own accrual. */
  bookNetProfitH: number;
  adjustments: { target: "adjusted_net_profit" | "zakat_base"; effect: "increase" | "decrease"; amountH: number }[];
  calendar: "gregorian" | "hijri";
  /** Days of the fiscal year (end − start + 1). */
  fiscalYearDays: number;
}

export interface ZakatStep { key: string; article: string; amountH: number }

export interface ZakatResult {
  equityH: number; provisionsH: number;
  nonCurrentAssetsH: number; nonCurrentDeductedH: number; nonCurrentNotDeductedH: number;
  currentAssetsH: number; currentDeductedH: number; currentNotDeductedH: number;
  nonCurrentLiabilitiesH: number; currentLiabilitiesH: number;
  deductionsH: number;
  nclExcluded: { accountId: number | null; name: string; nameAr: string; assetH: number; excludedH: number }[];
  nclExcludedH: number;
  clAddedForDeducted: { accountId: number | null; name: string; nameAr: string; assetH: number; addedH: number }[];
  clAddedForDeductedH: number;
  clExcessOverCaH: number;
  liabilitiesAddedBeforeCapH: number;
  liabilitiesAddedH: number;
  bookNetProfitH: number;
  adjustedNetProfitH: number;
  netProfitAdjustmentsH: number;
  baseAdjustmentsH: number;
  differenceH: number;
  baseByMethodH: number;
  undeductedAssetsH: number;
  minimumRule: "not_applied" | "27(2)" | "27(3)" | "27(4)";
  baseAfterMinimumH: number;
  maximumH: number;
  maximumApplied: boolean;
  /** 🔴 The floor exceeded the ceiling — shown, never silently resolved (Z-4). */
  floorAboveCeiling: boolean;
  zakatBaseH: number;
  rate: { numerator: number; denominator: number; display: string; basis: string };
  zakatH: number;
  steps: ZakatStep[];
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** round-half-up of a positive rational a/b (BigInt — a halala base × 25 × 366 exceeds 2^53). */
function roundDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("roundDiv: non-positive divisor");
  if (a < 0n) return -roundDiv(-a, b);
  return (2n * a + b) / (2n * b);
}
/** x × num / den, rounded half-up to a halala. */
const prorate = (x: number, num: number, den: number) => Number(roundDiv(BigInt(x) * BigInt(num), BigInt(den)));

export function computeZakat(i: ZakatInputs): ZakatResult {
  const by = (c: ZakatLine["zakatClass"]) => i.lines.filter((l) => l.zakatClass === c);
  const equityH = sum(by("equity").map((l) => l.amountH)) + sum(by("equity_computed").map((l) => l.amountH));
  const provisionsH = sum(by("provision_as_equity").map((l) => l.amountH));
  const ncD = by("noncurrent_asset_deducted"), ncN = by("noncurrent_asset_not_deducted");
  const cD = by("current_asset_deducted"), cN = by("current_asset_not_deducted");
  const nonCurrentDeductedH = sum(ncD.map((l) => l.amountH));
  const nonCurrentNotDeductedH = sum(ncN.map((l) => l.amountH));
  const currentDeductedH = sum(cD.map((l) => l.amountH));
  const currentNotDeductedH = sum(cN.map((l) => l.amountH));
  const nonCurrentAssetsH = nonCurrentDeductedH + nonCurrentNotDeductedH;
  const currentAssetsH = currentDeductedH + currentNotDeductedH;
  const nonCurrentLiabilitiesH = sum(by("noncurrent_liability").map((l) => l.amountH));
  const currentLiabilitiesH = sum(by("current_liability").map((l) => l.amountH));

  // Art. 26 — the deductions, at the net values shown (Art. 48(1)(b))
  const deductionsH = nonCurrentDeductedH + currentDeductedH;

  // Art. 25(1) — for each NON-current asset NOT deducted, exclude its proportion of the non-current liabilities, capped at the asset
  const nclExcluded = ncN.filter((l) => l.amountH > 0 && nonCurrentAssetsH > 0 && nonCurrentLiabilitiesH > 0).map((l) => {
    const share = prorate(l.amountH, nonCurrentLiabilitiesH, nonCurrentAssetsH);
    return { accountId: l.accountId, name: l.name, nameAr: l.nameAr, assetH: l.amountH, excludedH: Math.min(l.amountH, Math.max(0, share)) };
  });
  const nclExcludedH = sum(nclExcluded.map((x) => x.excludedH));

  // Art. 25(2), 29(2)(a) — for each CURRENT asset deducted, add its proportion of the current liabilities, capped at the asset
  const clAddedForDeducted = cD.filter((l) => l.amountH > 0 && currentAssetsH > 0 && currentLiabilitiesH > 0).map((l) => {
    const share = prorate(l.amountH, currentLiabilitiesH, currentAssetsH);
    return { accountId: l.accountId, name: l.name, nameAr: l.nameAr, assetH: l.amountH, addedH: Math.min(l.amountH, Math.max(0, share)) };
  });
  const clAddedForDeductedH = sum(clAddedForDeducted.map((x) => x.addedH));

  // Art. 29(2)(b) — current liabilities exceeding current assets: the excess is added
  const clExcessOverCaH = Math.max(0, currentLiabilitiesH - currentAssetsH);

  // Art. 23(2), 25(4) — liabilities are added only within the deducted assets (and never below zero)
  const liabilitiesAddedBeforeCapH = Math.max(0, nonCurrentLiabilitiesH - nclExcludedH) + clAddedForDeductedH + clExcessOverCaH;
  const liabilitiesAddedH = Math.max(0, Math.min(deductionsH, liabilitiesAddedBeforeCapH));

  // Art. 23(3) — the difference between adjusted and book net profit (after Zakat and tax: this computation's own charge is excluded from both — Z-3)
  const signed = (a: ZakatInputs["adjustments"][number]) => (a.effect === "increase" ? a.amountH : -a.amountH);
  const netProfitAdjustmentsH = sum(i.adjustments.filter((a) => a.target === "adjusted_net_profit").map(signed));
  const baseAdjustmentsH = sum(i.adjustments.filter((a) => a.target === "zakat_base").map(signed));
  const adjustedNetProfitH = i.bookNetProfitH + netProfitAdjustmentsH;
  const differenceH = adjustedNetProfitH - i.bookNetProfitH;

  // Art. 21 — the base by the method (with any declared direct base adjustment, each carrying its article)
  const baseByMethodH = equityH + provisionsH + liabilitiesAddedH + differenceH - deductionsH + baseAdjustmentsH;

  // Art. 27 — the minimum base. "Undeducted assets" (Art. 1): total assets less the Art. 26 deductions.
  const undeductedAssetsH = i.totalAssetsH - deductionsH;
  let minimumRule: ZakatResult["minimumRule"] = "not_applied";
  let baseAfterMinimumH = baseByMethodH;
  if (adjustedNetProfitH > 0) {
    if (baseByMethodH < adjustedNetProfitH) {
      minimumRule = "27(2)";
      baseAfterMinimumH = Math.min(adjustedNetProfitH, undeductedAssetsH + differenceH);
    }
  } else if (baseByMethodH < 0) {
    minimumRule = "27(3)";
    baseAfterMinimumH = 0;
  } else {
    minimumRule = "27(4)";
    baseAfterMinimumH = baseByMethodH;
  }

  // Art. 28 — the maximum: equity and equivalents (equity, provisions as equity) + the difference
  const maximumH = equityH + provisionsH + differenceH;
  const maximumApplied = baseAfterMinimumH > maximumH;
  const floorAboveCeiling = minimumRule === "27(2)" && baseAfterMinimumH > maximumH;
  const zakatBaseH = Math.max(0, maximumApplied ? maximumH : baseAfterMinimumH);

  // Art. 15 — the rate. A Hijri zakat year: 2.5 %. Otherwise (2.5 % ÷ 354) × the year's actual days (owner Q3; C3 OPEN).
  const rate = i.calendar === "hijri"
    ? { numerator: 25, denominator: 1000, display: "2.5%", basis: "Art. 15(1): 2.5 % of the base for a Hijri year" }
    : { numerator: 25 * i.fiscalYearDays, denominator: 1000 * 354, display: `2.5% × ${i.fiscalYearDays} ÷ 354 = ${((2.5 * i.fiscalYearDays) / 354).toFixed(6)}%`, basis: "Art. 15(2): (2.5 % ÷ days of the Hijri year) × days of the payer's year — the divisor 354 per owner decision Q3 (C3 OPEN)" };
  const zakatH = zakatBaseH > 0 ? prorate(zakatBaseH, rate.numerator, rate.denominator) : 0;

  const steps: ZakatStep[] = [
    { key: "equity", article: "23(1)", amountH: equityH },
    { key: "provisions", article: "24", amountH: provisionsH },
    { key: "liabilities_added", article: "23(2), 25, 29", amountH: liabilitiesAddedH },
    { key: "difference", article: "23(3)", amountH: differenceH },
    { key: "deductions", article: "26", amountH: -deductionsH },
    ...(baseAdjustmentsH !== 0 ? [{ key: "base_adjustments", article: "declared", amountH: baseAdjustmentsH }] : []),
    { key: "base_by_method", article: "21", amountH: baseByMethodH },
    { key: "base_after_minimum", article: minimumRule === "not_applied" ? "27 (not applied)" : minimumRule, amountH: baseAfterMinimumH },
    { key: "maximum", article: "28", amountH: maximumH },
    { key: "zakat_base", article: maximumApplied ? "28" : "21/27", amountH: zakatBaseH },
    { key: "zakat", article: "15", amountH: zakatH },
  ];

  return {
    equityH, provisionsH, nonCurrentAssetsH, nonCurrentDeductedH, nonCurrentNotDeductedH,
    currentAssetsH, currentDeductedH, currentNotDeductedH, nonCurrentLiabilitiesH, currentLiabilitiesH,
    deductionsH, nclExcluded, nclExcludedH, clAddedForDeducted, clAddedForDeductedH, clExcessOverCaH,
    liabilitiesAddedBeforeCapH, liabilitiesAddedH, bookNetProfitH: i.bookNetProfitH, adjustedNetProfitH, netProfitAdjustmentsH, baseAdjustmentsH, differenceH,
    baseByMethodH, undeductedAssetsH, minimumRule, baseAfterMinimumH, maximumH, maximumApplied, floorAboveCeiling,
    zakatBaseH, rate, zakatH, steps,
  };
}
