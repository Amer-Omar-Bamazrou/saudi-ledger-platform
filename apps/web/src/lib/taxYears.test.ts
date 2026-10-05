import { describe, expect, it } from "vitest";
import { defaultComputationYear } from "./taxYears";

const Y = (label: number) => ({ label, startDate: `${label}-01-01`, endDate: `${label}-12-31` });

describe("defaultComputationYear — the year a new computation suggests (QA 2026-10-04)", () => {
  it("🔴 the latest COMPLETED fiscal year — not the oldest offered (the list arrives newest first)", () => {
    const offered = [Y(2027), Y(2026), Y(2025), Y(2024)]; // as the fiscal-years endpoint lists them
    expect(defaultComputationYear(offered, "2026-10-04")?.label).toBe(2025);
    // the same list in the other order answers the same — the rule is about dates, not position
    expect(defaultComputationYear([...offered].reverse(), "2026-10-04")?.label).toBe(2025);
  });

  it("when the completed years already have computations, the year running today; otherwise the earliest offered", () => {
    expect(defaultComputationYear([Y(2027), Y(2026)], "2026-10-04")?.label).toBe(2026);
    expect(defaultComputationYear([Y(2028), Y(2027)], "2026-10-04")?.label).toBe(2027);
    expect(defaultComputationYear([], "2026-10-04")).toBeNull();
  });

  it("a non-calendar fiscal year ends when it ends (Apr–Mar)", () => {
    const apr = (label: number) => ({ label, startDate: `${label - 1}-04-01`, endDate: `${label}-03-31` });
    expect(defaultComputationYear([apr(2027), apr(2026), apr(2025)], "2026-10-04")?.label).toBe(2026);
  });
});
