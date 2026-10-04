/**
 * INCOME TAX OF A RESIDENT CAPITAL COMPANY ON ITS NON-SAUDI SHARE — pure
 * arithmetic of the Income Tax Law (Royal Decree M/1, 15/1/1425H) as in force
 * (docs/product/phase-16-17-tax-treasury-decision-pack.md §4). All amounts in
 * integer HALALAS; every step returned with its article.
 *
 *   profit before Zakat and income tax                          (the ledger, the fiscal year)
 *   + book depreciation, ∓ book disposal result                  Art. 17 replaces book depreciation
 *   − Art. 17 pool deduction (+ elections taken)                 Art. 17(d), (h), (i)
 *   + Art. 17(g) excess of disposals · + Art. 18 repairs over the 4 % cap
 *   ± declared adjustments (each with its article)               Arts 12–15; IR Arts 9–10
 *   = taxable income
 *   − losses carried forward, at most 25 % of the year's income  Art. 21; IR Art. 11
 *   × the non-Saudi share                                        Arts 2(a), 6(a)
 *   × 20 %                                                       Art. 7(a)
 *
 * 🔴 Current tax only. Deferred tax (IAS 12 / IFRS for SMEs s.29) is NOT
 * computed — a stated limitation, never an implied zero.
 */
export interface IncomeTaxInputs {
  profitBeforeTaxesH: number;
  bookDepreciationH: number;
  /** The book result on disposals (credit-positive: a gain is positive). */
  bookDisposalResultH: number;
  poolDeductionH: number;
  poolExcessIncomeH: number;
  repairsOverCapH: number;
  adjustments: { effect: "increase" | "decrease"; amountH: number }[];
  lossCarryforwardAvailableH: number;
  /** The non-Saudi share in basis points of a percent: 25.50 % → 2550; 100 % → 10000. */
  foreignShareBp: number;
}

export interface IncomeTaxResult {
  profitBeforeTaxesH: number;
  bookDepreciationAddBackH: number;
  bookDisposalReversalH: number;
  poolDeductionH: number;
  poolExcessIncomeH: number;
  repairsOverCapH: number;
  declaredAdjustmentsH: number;
  taxableIncomeH: number;
  lossCapH: number;
  lossUsedH: number;
  taxableIncomeAfterLossesH: number;
  foreignShareBp: number;
  taxableShareH: number;
  rate: { numerator: number; denominator: number; display: string };
  incomeTaxH: number;
  /** A year with a tax loss: the loss attributable to the share, carried forward (Art. 21) — informational. */
  lossOfTheYearH: number;
  steps: { key: string; article: string; amountH: number }[];
}

function roundDiv(a: bigint, b: bigint): bigint {
  if (a < 0n) return -roundDiv(-a, b);
  return (2n * a + b) / (2n * b);
}

export function computeIncomeTax(i: IncomeTaxInputs): IncomeTaxResult {
  if (!Number.isInteger(i.foreignShareBp) || i.foreignShareBp < 0 || i.foreignShareBp > 10000) throw new Error("foreignShareBp out of range");
  const declaredAdjustmentsH = i.adjustments.reduce((s, a) => s + (a.effect === "increase" ? a.amountH : -a.amountH), 0);
  const bookDepreciationAddBackH = i.bookDepreciationH;
  const bookDisposalReversalH = -i.bookDisposalResultH;
  const taxableIncomeH = i.profitBeforeTaxesH + bookDepreciationAddBackH + bookDisposalReversalH
    - i.poolDeductionH + i.poolExcessIncomeH + i.repairsOverCapH + declaredAdjustmentsH;

  // Art. 21 / IR Art. 11(1): at most 25 % of the year's profit — rounded DOWN, so the cap is never exceeded (product).
  const lossCapH = taxableIncomeH > 0 ? Math.floor(taxableIncomeH / 4) : 0;
  const lossUsedH = Math.max(0, Math.min(i.lossCarryforwardAvailableH, lossCapH));
  const taxableIncomeAfterLossesH = taxableIncomeH - lossUsedH;

  // Arts 2(a), 6(a): the base is the non-Saudi partners' share of the taxable income
  const taxableShareH = taxableIncomeAfterLossesH > 0 ? Number(roundDiv(BigInt(taxableIncomeAfterLossesH) * BigInt(i.foreignShareBp), 10000n)) : 0;
  const rate = { numerator: 20, denominator: 100, display: "20%" };
  const incomeTaxH = taxableShareH > 0 ? Number(roundDiv(BigInt(taxableShareH) * 20n, 100n)) : 0;
  const lossOfTheYearH = taxableIncomeH < 0 ? Number(roundDiv(BigInt(-taxableIncomeH) * BigInt(i.foreignShareBp), 10000n)) : 0;

  return {
    profitBeforeTaxesH: i.profitBeforeTaxesH, bookDepreciationAddBackH, bookDisposalReversalH,
    poolDeductionH: i.poolDeductionH, poolExcessIncomeH: i.poolExcessIncomeH, repairsOverCapH: i.repairsOverCapH,
    declaredAdjustmentsH, taxableIncomeH, lossCapH, lossUsedH, taxableIncomeAfterLossesH,
    foreignShareBp: i.foreignShareBp, taxableShareH, rate, incomeTaxH, lossOfTheYearH,
    steps: [
      { key: "profit_before_taxes", article: "ledger", amountH: i.profitBeforeTaxesH },
      { key: "book_depreciation", article: "17", amountH: bookDepreciationAddBackH },
      { key: "book_disposals", article: "17", amountH: bookDisposalReversalH },
      { key: "pool_deduction", article: "17(d),(h),(i)", amountH: -i.poolDeductionH },
      { key: "pool_excess", article: "17(g)", amountH: i.poolExcessIncomeH },
      { key: "repairs_over_cap", article: "18", amountH: i.repairsOverCapH },
      { key: "declared_adjustments", article: "12–15", amountH: declaredAdjustmentsH },
      { key: "taxable_income", article: "—", amountH: taxableIncomeH },
      { key: "losses_used", article: "21", amountH: -lossUsedH },
      { key: "taxable_share", article: "2(a), 6(a)", amountH: taxableShareH },
      { key: "income_tax", article: "7(a)", amountH: incomeTaxH },
    ],
  };
}
