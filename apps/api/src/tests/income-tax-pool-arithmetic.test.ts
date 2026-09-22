/**
 * FA-E — the Income Tax Law Art. 17 arithmetic, on its own (2026-09-22).
 *
 * Record: docs/product/fixed-assets-decision-pack.md §24.
 *
 * `computePoolYear` is pure, so every rule of Art. 17(d)–(i) and Art. 18 can be
 * exercised without a register, a company or a clock — and each case below
 * asserts the figure MOVES the way the rule says, not merely that it is a
 * number. Where a rule says MAY, the test proves that the engine does NOT take
 * it unless the election was made: an untaken election is the case most easily
 * "passed" by an engine that quietly takes it.
 */
import { describe, expect, it } from "vitest";
import { ART17_RATES, ART17_SMALL_BALANCE_SAR, computePoolYear, type Art17Group } from "../services/assets/incomeTaxPool";

const year = (over: Partial<Parameters<typeof computePoolYear>[0]> = {}) =>
  computePoolYear({
    taxYear: 2026,
    group: 3,
    openingBalance: 0,
    current: { additions: 0, disposals: 0, allAssetsDisposed: false },
    previous: { additions: 0, disposals: 0 },
    declaration: { repairs: null, electSmallBalanceWriteOff: false, electGroupClosedWriteOff: false },
    ...over,
  });

describe("FA-E — Income Tax Law Art. 17, as arithmetic", () => {
  it("🔴 17(b) — the five groups carry the Law's own rates, and there is no sixth", () => {
    expect(ART17_RATES).toEqual({ 1: 5, 2: 10, 3: 25, 4: 20, 5: 10 });
    expect(Object.keys(ART17_RATES)).toHaveLength(5);
  });

  it("🔴 17(d)+(e) — the HALF-YEAR convention: an addition contributes 50 % in its own year and the other 50 % in the next, and the deduction is the rate on the resulting balance", () => {
    // Year 1: nothing opening, 100,000 added. Half of it enters: 50,000 × 25 % = 12,500.
    const y1 = year({ current: { additions: 100_000, disposals: 0, allAssetsDisposed: false } });
    expect([y1.additionsHalf, y1.balanceBeforeDeduction, y1.depreciationDeduction, y1.closingBalance]).toEqual([50_000, 50_000, 12_500, 37_500]);

    // Year 2: nothing new, but the SAME addition is "previous year" — its other
    // half enters now. 37,500 + 50,000 = 87,500 × 25 % = 21,875.
    const y2 = year({ openingBalance: y1.closingBalance, previous: { additions: 100_000, disposals: 0 } });
    expect([y2.additionsHalf, y2.balanceBeforeDeduction, y2.depreciationDeduction, y2.closingBalance]).toEqual([50_000, 87_500, 21_875, 65_625]);

    // Year 3: the asset is fully in the pool; nothing but the declining balance.
    const y3 = year({ openingBalance: y2.closingBalance });
    expect([y3.additionsHalf, y3.balanceBeforeDeduction, y3.depreciationDeduction]).toEqual([0, 65_625, 16_406.25]);

    // 🔴 The property, not the number: across the three years the pool has taken
    // in exactly the cost base once, no more.
    expect(y1.additionsHalf + y2.additionsHalf + y3.additionsHalf).toBe(100_000);
  });

  it("🔴 17(e) — disposals take 50 % out on the same two-year convention, and the balance is LOWER than it would have been", () => {
    const withoutDisposal = year({ openingBalance: 100_000 });
    const withDisposal = year({ openingBalance: 100_000, current: { additions: 0, disposals: 30_000, allAssetsDisposed: false } });
    expect(withDisposal.disposalsHalf).toBe(15_000);
    expect(withDisposal.balanceBeforeDeduction).toBe(85_000);
    // presence, absence AND movement: the figure is not merely present, it MOVED
    expect(withDisposal.balanceBeforeDeduction).toBeLessThan(withoutDisposal.balanceBeforeDeduction);
    expect(withoutDisposal.balanceBeforeDeduction - withDisposal.balanceBeforeDeduction).toBe(15_000);
    expect(withDisposal.excessTaxableIncome).toBe(0);
  });

  it("🔴 17(g) — when 50 % of the disposals exceeds the balance, the group goes to ZERO and the excess is TAXABLE INCOME (never a negative pool)", () => {
    // Opening 10,000, no additions, 50,000 of compensation ⇒ half is 25,000.
    const r = year({ openingBalance: 10_000, current: { additions: 0, disposals: 50_000, allAssetsDisposed: false } });
    expect(r.disposalsHalf).toBe(25_000);
    expect(r.balanceBeforeDeduction).toBe(0);
    expect(r.excessTaxableIncome).toBe(15_000); // 25,000 − 10,000
    expect(r.depreciationDeduction).toBe(0);
    expect(r.closingBalance).toBe(0);
    // and the boundary: exactly equal is NOT an excess
    const exact = year({ openingBalance: 25_000, current: { additions: 0, disposals: 50_000, allAssetsDisposed: false } });
    expect([exact.balanceBeforeDeduction, exact.excessTaxableIncome]).toEqual([0, 0]);
  });

  it("🔴 Art. 18 — repairs are deductible up to 4 % of the balance and the EXCESS is added to the pool; UNDECLARED is not zero", () => {
    // Balance 100,000 ⇒ cap 4,000. Repairs 10,000 ⇒ 4,000 expensed, 6,000 into the pool.
    const r = year({ openingBalance: 100_000, declaration: { repairs: 10_000, electSmallBalanceWriteOff: false, electGroupClosedWriteOff: false } });
    expect(r.repairs).toEqual({ declared: 10_000, capBase: 100_000, cap: 4_000, deductibleAsExpense: 4_000, addedToPool: 6_000 });
    expect(r.balanceBeforeDeduction).toBe(106_000);
    expect(r.depreciationDeduction).toBe(26_500); // 25 % of 106,000

    // Under the cap: all of it is expense, nothing joins the pool.
    const under = year({ openingBalance: 100_000, declaration: { repairs: 1_000, electSmallBalanceWriteOff: false, electGroupClosedWriteOff: false } });
    expect([under.repairs.deductibleAsExpense, under.repairs.addedToPool, under.balanceBeforeDeduction]).toEqual([1_000, 0, 100_000]);

    // 🔴 NOT DECLARED: the engine adds nothing AND says the figure is missing —
    // the caller must be able to tell "no repairs" from "nobody said".
    const undeclared = year({ openingBalance: 100_000 });
    expect(undeclared.repairs.declared).toBeNull();
    expect([undeclared.repairs.deductibleAsExpense, undeclared.repairs.addedToPool]).toEqual([0, 0]);
    // a DECLARED zero reaches the same figures by a different route, and says so
    const zero = year({ openingBalance: 100_000, declaration: { repairs: 0, electSmallBalanceWriteOff: false, electGroupClosedWriteOff: false } });
    expect(zero.repairs.declared).toBe(0);
    expect(zero.balanceBeforeDeduction).toBe(undeclared.balanceBeforeDeduction);
  });

  it("🔴 17(h) says MAY — the small balance is OFFERED and not taken; taking it is the taxpayer's act and it zeroes the carry-forward", () => {
    // Balance 1,200 ⇒ 25 % = 300, leaving 900, which is below SAR 1,000.
    const offered = year({ openingBalance: 1_200 });
    expect(offered.balanceAfterDeduction).toBe(900);
    expect(offered.elections.smallBalance).toEqual({ available: true, amount: 900, taken: false });
    expect([offered.totalDeduction, offered.closingBalance]).toEqual([300, 900]);

    const taken = year({ openingBalance: 1_200, declaration: { repairs: null, electSmallBalanceWriteOff: true, electGroupClosedWriteOff: false } });
    expect(taken.elections.smallBalance.taken).toBe(true);
    expect([taken.totalDeduction, taken.closingBalance]).toEqual([1_200, 0]);

    // 🔴 The election is not available above the threshold, and electing it there
    // changes NOTHING — an election the Law does not offer cannot be taken.
    const tooBig = year({ openingBalance: 100_000, declaration: { repairs: null, electSmallBalanceWriteOff: true, electGroupClosedWriteOff: false } });
    expect(tooBig.balanceAfterDeduction).toBeGreaterThan(ART17_SMALL_BALANCE_SAR);
    expect(tooBig.elections.smallBalance).toEqual({ available: false, amount: 0, taken: false });
    expect(tooBig.closingBalance).toBe(75_000);
  });

  it("🔴 17(i) says MAY — the whole balance is offered ONLY when every asset of the group is gone, and a group with no assets is not a closed group", () => {
    const closed = year({ openingBalance: 40_000, current: { additions: 0, disposals: 0, allAssetsDisposed: true } });
    expect(closed.elections.groupClosed).toEqual({ available: true, amount: 30_000, taken: false });
    expect(closed.closingBalance).toBe(30_000);

    const taken = year({ openingBalance: 40_000, current: { additions: 0, disposals: 0, allAssetsDisposed: true }, declaration: { repairs: null, electSmallBalanceWriteOff: false, electGroupClosedWriteOff: true } });
    expect([taken.totalDeduction, taken.closingBalance]).toEqual([40_000, 0]);

    // not all disposed ⇒ not offered, and electing it changes nothing
    const open = year({ openingBalance: 40_000, declaration: { repairs: null, electSmallBalanceWriteOff: false, electGroupClosedWriteOff: true } });
    expect(open.elections.groupClosed).toEqual({ available: false, amount: 0, taken: false });
    expect(open.closingBalance).toBe(30_000);
  });

  it("🔴 the two elections are never BOTH applied — 17(i) is the wider one, and taking it makes 17(h) moot rather than deducting twice", () => {
    // Balance 1,200, group fully disposed, and BOTH elected.
    const both = year({
      openingBalance: 1_200,
      current: { additions: 0, disposals: 0, allAssetsDisposed: true },
      declaration: { repairs: null, electSmallBalanceWriteOff: true, electGroupClosedWriteOff: true },
    });
    expect(both.elections.groupClosed.taken).toBe(true);
    expect(both.elections.smallBalance.taken).toBe(false);
    // 300 (the rate) + 900 (the balance) — ONCE, not 300 + 900 + 900
    expect([both.totalDeduction, both.closingBalance]).toEqual([1_200, 0]);
  });

  it("🔴 every group runs at its own rate on the same facts — the rate is the only thing that differs", () => {
    const byGroup = ([1, 2, 3, 4, 5] as Art17Group[]).map((g) => year({ group: g, openingBalance: 100_000 }));
    expect(byGroup.map((r) => r.depreciationDeduction)).toEqual([5_000, 10_000, 25_000, 20_000, 10_000]);
    expect(byGroup.map((r) => r.closingBalance)).toEqual([95_000, 90_000, 75_000, 80_000, 90_000]);
  });

  it("🔴 the pool is a POOL — two assets of one group are indistinguishable in it, and their halves add", () => {
    const together = year({ current: { additions: 60_000 + 40_000, disposals: 0, allAssetsDisposed: false } });
    const a = year({ current: { additions: 60_000, disposals: 0, allAssetsDisposed: false } });
    const b = year({ current: { additions: 40_000, disposals: 0, allAssetsDisposed: false } });
    expect(together.depreciationDeduction).toBe(a.depreciationDeduction + b.depreciationDeduction);
    expect(together.balanceBeforeDeduction).toBe(50_000);
  });
});
