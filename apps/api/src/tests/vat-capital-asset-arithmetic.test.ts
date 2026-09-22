/**
 * FA-F — the VAT IR Art. 52 adjustment, as arithmetic (2026-09-22).
 * Record: docs/product/fixed-assets-decision-pack.md §7, §25.
 *
 * Pure, so the whole regime can be exercised without a register, a company or
 * a clock. The cases that matter most are the ones where the right answer and
 * the lazy answer coincide — a fully taxable tenant adjusts nothing, and so
 * does an engine that computes nothing — so each of those asserts the REASON
 * beside the figure, and a neighbouring case where the figure MOVES.
 */
import { describe, expect, it } from "vitest";
import {
  adjustmentPeriodYears, adjustmentWindows, computeAdjustmentYear, computeDisposalAdjustment,
  proportionalDeductionPct, taxPeriodStart,
} from "../services/assets/vatCapitalAsset";

describe("FA-F — VAT IR Art. 52, as arithmetic", () => {
  it("🔴 52(2) — 6 years movable, 10 immovable, SHORTENED to the accounting life with part years counting as one", () => {
    expect(adjustmentPeriodYears("movable", 120)).toBe(6);      // a 10-year machine: capped at the statutory 6
    expect(adjustmentPeriodYears("immovable", 300)).toBe(10);   // a 25-year building: capped at 10
    expect(adjustmentPeriodYears("movable", 48)).toBe(4);       // a 4-year laptop: its own life is shorter
    expect(adjustmentPeriodYears("movable", 40)).toBe(4);       // 3 y 4 m ⇒ part years count as one
    expect(adjustmentPeriodYears("immovable", 18)).toBe(2);
    expect(adjustmentPeriodYears("movable", 1)).toBe(1);        // never zero — there is always a first year
    // 🔴 not a capital asset ⇒ NO period at all, which is not the same as a period of 0
    expect(adjustmentPeriodYears("not_capital", 48)).toBeNull();
    // 🔴 the VAT clock and the ACCOUNTING clock differ by construction: a 25-year
    // building depreciates over 300 months and adjusts over 10 years.
    expect(adjustmentPeriodYears("immovable", 300)).not.toBe(300 / 12);
  });

  it("🔴 52(5) — the first window opens at the start of the TAX PERIOD of acquisition, not on the purchase date", () => {
    expect(taxPeriodStart("2026-05-17", "monthly")).toBe("2026-05-01");
    expect(taxPeriodStart("2026-05-17", "quarterly")).toBe("2026-04-01");
    expect(taxPeriodStart("2026-01-02", "quarterly")).toBe("2026-01-01");
    expect(taxPeriodStart("2026-12-31", "quarterly")).toBe("2026-10-01");
    // 🔴 the two tax periods give DIFFERENT starts for the same purchase, which
    // is the whole reason the period has to be declared rather than assumed.
    expect(taxPeriodStart("2026-05-17", "monthly")).not.toBe(taxPeriodStart("2026-05-17", "quarterly"));
  });

  it("🔴 52(5) — each window is twelve months, and the adjustment belongs to the return for the LAST tax period inside it", () => {
    const quarterly = adjustmentWindows("2026-05-17", "quarterly", 3);
    expect(quarterly.map((w) => [w.index, w.startDate, w.endDate])).toEqual([
      [1, "2026-04-01", "2027-03-31"],
      [2, "2027-04-01", "2028-03-31"],
      [3, "2028-04-01", "2029-03-31"],
    ]);
    // the last quarter inside window 1 is Jan–Mar 2027 — that return carries it
    expect([quarterly[0]!.returnPeriodStart, quarterly[0]!.returnPeriodEnd]).toEqual(["2027-01-01", "2027-03-31"]);

    const monthly = adjustmentWindows("2026-05-17", "monthly", 2);
    expect(monthly.map((w) => [w.startDate, w.endDate])).toEqual([
      ["2026-05-01", "2027-04-30"],
      ["2027-05-01", "2028-04-30"],
    ]);
    // the last MONTH inside window 1 is April 2027 — a shorter return than the quarterly case
    expect([monthly[0]!.returnPeriodStart, monthly[0]!.returnPeriodEnd]).toEqual(["2027-04-01", "2027-04-30"]);
    // …and a leap February inside a window does not shorten it
    expect(adjustmentWindows("2027-03-01", "monthly", 1)[0]!.endDate).toBe("2028-02-29");
  });

  it("🔴 51(4) — the default fraction is taxable over taxable-plus-exempt, and an EMPTY year has no fraction at all", () => {
    expect(proportionalDeductionPct(900_000, 100_000)).toBe(90);
    expect(proportionalDeductionPct(1_000_000, 0)).toBe(100);   // wholly taxable
    expect(proportionalDeductionPct(0, 500_000)).toBe(0);       // wholly exempt — a real 0
    // 🔴 no supplies at all is NOT 0 %: 0 would read as "wholly exempt", the
    // opposite of what an empty year means. The absence must survive.
    expect(proportionalDeductionPct(0, 0)).toBeNull();
    expect(proportionalDeductionPct(333_333, 666_667)).toBe(33.33);
  });

  const win = adjustmentWindows("2026-01-10", "quarterly", 6)[0]!;

  it("🔴 52(4) — the adjustment is the potentially-adjustable amount times the CHANGE in use, in both directions", () => {
    // 15,000 initial deduction over 6 years ⇒ 2,500 a year potentially adjustable.
    const base = { window: win, potentiallyAdjustable: 2_500, initialRecoveryPct: 80, actualUseSource: "proportional" as const };
    // use ROSE to 90 %: another 250 is recoverable
    expect(computeAdjustmentYear({ ...base, actualUsePct: 90 }).adjustment).toBe(250);
    // use FELL to 60 %: 500 is repaid — the sign is the direction, and it must survive
    expect(computeAdjustmentYear({ ...base, actualUsePct: 60 }).adjustment).toBe(-500);
    expect(computeAdjustmentYear({ ...base, actualUsePct: 0 }).adjustment).toBe(-2_000);
    expect(computeAdjustmentYear({ ...base, actualUsePct: 100 }).adjustment).toBe(500);
  });

  it("🔴 52(6) — NO CHANGE OF USE is a REASON, reported apart from an adjustment that happens to be zero", () => {
    const base = { window: win, potentiallyAdjustable: 2_500, initialRecoveryPct: 80, actualUseSource: "proportional" as const };
    const same = computeAdjustmentYear({ ...base, actualUsePct: 80 });
    expect([same.adjustment, same.noChangeOfUse]).toEqual([0, true]);

    // 🔴 The distinguishing case: a year with NO figure at all. Its adjustment
    // is also 0, and it is NOT 52(6) — nobody has established that the use did
    // not change. An engine that collapsed the two would evidence a relief it
    // never checked.
    const unknown = computeAdjustmentYear({ ...base, actualUsePct: null, actualUseSource: "unavailable" });
    expect([unknown.adjustment, unknown.noChangeOfUse]).toEqual([0, false]);

    // and a wholly taxable tenant reaches 52(6) by the front door, every year
    const fullyTaxable = computeAdjustmentYear({ window: win, potentiallyAdjustable: 2_500, initialRecoveryPct: 100, actualUsePct: 100, actualUseSource: "proportional" });
    expect([fullyTaxable.adjustment, fullyTaxable.noChangeOfUse]).toEqual([0, true]);
  });

  it("🔴 52(7) — a SALE as a taxable supply recovers the unrecovered share over the windows still to run", () => {
    // 15,000 deducted at 80 %, 6-year period, sold in window 2 ⇒ 4 remain.
    const r = computeDisposalAdjustment({ kind: "sold", windowIndexOfDisposal: 2, adjustmentPeriodYears: 6, potentiallyAdjustable: 2_500, initialRecoveryPct: 80, saleIsTaxableSupply: true });
    expect([r.remainingPeriods, r.useAfterChangePct, r.adjustment]).toEqual([4, 100, 2_000]); // 4 × 2,500 × 20 %
    expect(r.rule).toMatch(/52\(7\)/);

    // already fully recovered ⇒ nothing to adjust, and the REASON says why
    const full = computeDisposalAdjustment({ kind: "sold", windowIndexOfDisposal: 2, adjustmentPeriodYears: 6, potentiallyAdjustable: 2_500, initialRecoveryPct: 100, saleIsTaxableSupply: true });
    expect(full.adjustment).toBe(0);
    expect(full.rule).toMatch(/already recovered in full/);

    // sold after the period has run out ⇒ no remainder to adjust
    const late = computeDisposalAdjustment({ kind: "sold", windowIndexOfDisposal: 6, adjustmentPeriodYears: 6, potentiallyAdjustable: 2_500, initialRecoveryPct: 80, saleIsTaxableSupply: true });
    expect([late.remainingPeriods, late.adjustment]).toEqual([0, 0]);
    expect(late.rule).toMatch(/already run its course/);
  });

  it("🔴 52(7)/(8)/50(3) — destruction, theft, scrapping, withdrawal and an out-of-scope vehicle sale each get ZERO for a DIFFERENT stated reason", () => {
    const common = { windowIndexOfDisposal: 2, adjustmentPeriodYears: 6, potentiallyAdjustable: 2_500, initialRecoveryPct: 80 };
    const rules = (["destroyed", "stolen", "scrapped", "withdrawn"] as const).map((kind) =>
      computeDisposalAdjustment({ ...common, kind, saleIsTaxableSupply: false }),
    );
    expect(rules.map((r) => r.adjustment)).toEqual([0, 0, 0, 0]);
    // 🔴 Four zeros that are NOT the same zero. The reasons must differ, or the
    // working paper cannot evidence any of them.
    expect(new Set(rules.map((r) => r.rule)).size).toBe(4);
    expect(rules[0]!.rule).toMatch(/destroyed or stolen/);
    expect(rules[2]!.rule).toMatch(/earlier than accounted for/);
    expect(rules[3]!.rule).toMatch(/Nominal Supply/);

    // the restricted vehicle: a SALE, but not one made in the course of the activity
    const vehicle = computeDisposalAdjustment({ ...common, kind: "sold", initialRecoveryPct: 0, potentiallyAdjustable: 0, saleIsTaxableSupply: false });
    expect(vehicle.adjustment).toBe(0);
    expect(vehicle.rule).toMatch(/Art\. 50\(3\)/);
    // …and it reaches zero through the arithmetic, not a special case: nothing
    // was deducted, so nothing is adjustable even if the limb were missed.
    expect(vehicle.remainingPeriods).toBe(4);
  });

  it("🔴 over a whole adjustment period the annual adjustments plus the initial deduction never exceed the input tax charged", () => {
    // 15,000 charged, 80 % deducted = 12,000. If the asset turns out 100 %
    // taxable every year, the six annual adjustments recover exactly the 3,000
    // that was not deducted — no more.
    const windows = adjustmentWindows("2026-01-10", "quarterly", 6);
    const total = windows
      .map((w) => computeAdjustmentYear({ window: w, potentiallyAdjustable: 2_500, initialRecoveryPct: 80, actualUsePct: 100, actualUseSource: "proportional" }).adjustment)
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(3_000);
    expect(12_000 + total).toBe(15_000);
  });
});
