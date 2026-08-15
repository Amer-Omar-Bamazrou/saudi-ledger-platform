/**
 * Finance Hub — "can I pay what I owe?" (M18.3, design Q1).
 *
 * Computed SERVER-SIDE, in one place, because these are the figures the hub
 * turns into a sentence — and a sentence is harder to sanity-check than a
 * number. "You can cover your short-term debts 1.8× over" removes the reader's
 * ability to notice that the inputs were wrong, so the bar for the inputs is
 * higher here than for a report, not lower (design §2).
 *
 * ── 🔴 WHAT IS AND IS NOT VERIFIED (design §5.2) ───────────────────────────
 * The FORMULAS are standard accounting definitions — current ratio = current
 * assets / current liabilities, quick ratio = quick assets / current
 * liabilities, working capital = the difference. No KSA authority defines them
 * differently, so none of this needed an advisor.
 *
 * The CURRENT/NON-CURRENT BOUNDARY is IAS 1's twelve-month test under IFRS as
 * adopted in Saudi Arabia. It is followed and cited, not invented — the
 * classification itself lives on the chart of accounts (M18.1).
 *
 * The THRESHOLDS below are RULES OF THUMB. No standard sets them; they vary by
 * industry and business model. They are returned as `observation` severities
 * and must never be rendered as compliance — no "FAIL", no language implying a
 * rule has been broken. A wrong Zakat figure gets filed; a wrong liquidity
 * sentence gets believed.
 */
import { reportsService } from "./reports.service";
import { transactionsService } from "./transactions.service";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Below this a rule of thumb starts to mean something. NOT a compliance line. */
const RULE_OF_THUMB_RATIO = 1;

export interface LiquidityBlocker {
  code: "suspense_balance" | "unclassified_accounts";
  /** How much money the problem covers, so the user can judge its size. */
  amount: number;
  count?: number;
}

export const financeHubService = {
  /**
   * The hub's headline block.
   *
   * 🔴 `claimable` is the important field. When the platform cannot stand
   * behind the ratios, it says so INSTEAD of publishing them — it does not
   * publish them with a caveat underneath. Two conditions block the claim:
   *
   *   suspense_balance       Money the platform could not identify. It sits in
   *                          SUSPENSE, typed `asset`, so it would otherwise
   *                          count toward "money you can pay with" — and a
   *                          MESSIER import would produce a BETTER-looking
   *                          ratio. Worse, a suspense debit that is really an
   *                          expense overstates assets AND equity, so the error
   *                          runs optimistic, in the one direction that matters
   *                          when the question is "can I pay what I owe?".
   *                          ANY non-zero balance blocks (owner decision): a
   *                          threshold would be a number we cannot justify, and
   *                          a control surface should surface.
   *
   *   unclassified_accounts  A balance-sheet account with no liquidity class
   *                          belongs to no bucket, so the ratios silently
   *                          exclude it. That is exactly what a control surface
   *                          exists to report rather than absorb.
   *
   * The figures are still returned when blocked — the hub shows the breakdown
   * and names the problem. It is the *claim* that is withheld, not the data.
   */
  async liquidity(asOf?: string) {
    const bs = await reportsService.balanceSheet(asOf);

    const currentAssets = round2(bs.assets.current.total);
    const quickAssets = round2(bs.assets.quickTotal);
    const currentLiabilities = round2(bs.liabilities.current.total);
    const workingCapital = round2(currentAssets - currentLiabilities);

    /**
     * 🔴 NULL, not Infinity, and not 0. With no current liabilities the ratio
     * is undefined — the honest answer is "you have no short-term obligations",
     * which the UI says in words. Returning 0 would read as catastrophic and
     * Infinity would render as garbage; both are worse than declining.
     */
    const ratio = (numerator: number) =>
      currentLiabilities > 0 ? round2(numerator / currentLiabilities) : null;

    const blockers: LiquidityBlocker[] = [];
    const suspenseBalance = round2(bs.assets.suspenseBalance);
    if (Math.abs(suspenseBalance) >= 0.01) {
      blockers.push({ code: "suspense_balance", amount: suspenseBalance });
    }
    const unclassifiedAmount = round2(
      bs.assets.unclassified.total + bs.liabilities.unclassified.total,
    );
    const unclassifiedCount =
      bs.assets.unclassified.items.length + bs.liabilities.unclassified.items.length;
    if (unclassifiedCount > 0) {
      blockers.push({
        code: "unclassified_accounts",
        amount: unclassifiedAmount,
        count: unclassifiedCount,
      });
    }

    const currentRatio = ratio(currentAssets);
    const quickRatio = ratio(quickAssets);

    /**
     * Observations, not verdicts. Severity is `watch` at most — deliberately
     * no "fail" level exists in this type, so a future UI cannot render one.
     */
    const observations: Array<{ code: string; severity: "watch"; ratio: number }> = [];
    if (blockers.length === 0) {
      if (quickRatio !== null && quickRatio < RULE_OF_THUMB_RATIO) {
        observations.push({ code: "quick_ratio_below_one", severity: "watch", ratio: quickRatio });
      }
      if (currentRatio !== null && currentRatio < RULE_OF_THUMB_RATIO) {
        observations.push({ code: "current_ratio_below_one", severity: "watch", ratio: currentRatio });
      }
    }

    return {
      asOf: bs.asOf,
      currentAssets,
      quickAssets,
      currentLiabilities,
      workingCapital,
      currentRatio,
      quickRatio,
      /** False ⇒ the UI must NOT state the plain-language claim. */
      claimable: blockers.length === 0,
      blockers,
      observations,
    };
  },

  /**
   * "Are my books current?" — the second hub block.
   *
   * Q7: mirror the SIGNAL, not the page. The unreviewed count links to
   * `/review`, which stays in Banking; the hub never becomes a second place to
   * do the work.
   */
  async booksStatus() {
    const pending = await transactionsService.pendingReview();
    return {
      unreviewedCount: pending.length,
      needsAttentionCount: pending.filter((p) => p.needsAttention).length,
    };
  },
};
