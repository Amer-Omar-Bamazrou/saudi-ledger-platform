/**
 * M19.3.1 — the chart must never render an empty frame in place of a sentence.
 *
 * These cases are the ones the owner found by LOOKING at the page: a ratio
 * chart with axis, legend and nothing else, and a money chart with two flat
 * lines overlapping at zero. Both were faithful renderings of degenerate data,
 * and both said something false about the business.
 */
import { describe, expect, it } from "vitest";
import { classifyChartState } from "./chartState";

const claimable = (n: number) => Array.from({ length: n }, () => ({ claimable: true }));
const withheld = (n: number) => Array.from({ length: n }, () => ({ claimable: false }));

describe("classifyChartState", () => {
  it("draws when there is anything non-zero to draw", () => {
    expect(classifyChartState(claimable(3), [1.4, 0, null])).toBeNull();
    // A single negative value is still something to draw — an overdrawn month
    // is exactly what a reader needs to see.
    expect(classifyChartState(claimable(3), [-62678, null, 0])).toBeNull();
  });

  it("reports loading before the data arrives, rather than 'no activity'", () => {
    // Undefined means "not fetched yet". Calling that "no activity" would
    // libel the tenant for the duration of every page load.
    expect(classifyChartState(undefined, [])).toBe("loading");
  });

  it("🔴 all points withheld ⇒ 'all_withheld', never an empty frame", () => {
    expect(classifyChartState(withheld(4), [null, null, null, null])).toBe("all_withheld");
  });

  it("🔴 a RATIO of all-nulls is UNDEFINED, not 'no activity'", () => {
    // The live case: no current liabilities in the reliable months, so the
    // ratio has no value. Saying "no activity" would be false — there was
    // activity, it just had no denominator.
    expect(classifyChartState(claimable(6), [null, null, null], { ratio: true })).toBe(
      "undefined_ratio",
    );
  });

  it("🔴 MONEY of all-zeros is 'no activity' — the same input, a different fact", () => {
    // Identical values, opposite meaning, decided by which chart is asking.
    expect(classifyChartState(claimable(6), [0, 0, 0])).toBe("no_activity");
  });

  it("a mix of withheld and empty-but-claimable is NOT 'all_withheld'", () => {
    // The live default window: four claimable-but-zero months and two withheld.
    // Reporting it as all-withheld would hide that most of the range genuinely
    // had nothing in it; the page appends the withheld count instead.
    const points = [...claimable(4), ...withheld(2)];
    expect(classifyChartState(points, [0, 0, 0, 0, null, null])).toBe("no_activity");
    expect(classifyChartState(points, [null, null, null, null, null, null], { ratio: true })).toBe(
      "undefined_ratio",
    );
  });

  it("an empty result set is 'no activity', not a crash", () => {
    expect(classifyChartState([], [])).toBe("no_activity");
  });
});
