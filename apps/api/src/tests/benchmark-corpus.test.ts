/**
 * AI-2 — the benchmark corpus is itself an instrument, so its two authoring
 * disciplines are FORCED, not remembered (2026-08-23):
 *
 *  1. Every `expected` label is an emittable SEED_CATEGORIES code (or null).
 *     The benchmark's parse() maps unknown codes to null, so a typo'd expected
 *     code makes its case silently UNWINNABLE — the two-id-spaces disease, in
 *     the measuring instrument.
 *  2. 🔴 `hard` is a MEASURED claim about the engine ("not expected to solve
 *     alone"), and claims about the engine are checkable against the engine.
 *     The first expansion authored 28 hard flags by guess and the engine
 *     solved every one of them at ≥0.65 — including six from the ORIGINAL
 *     corpus — padding the hard-only baseline the §2a gate reads. A
 *     hard-flagged case the engine solves at high confidence never reaches
 *     the LLM in hybrid mode, so it measures nothing.
 *  3. The §12g size bar (≥30 hard per language; one case ≈ 3 points) holds,
 *     so a future trim cannot quietly hand the verdict back to single cases.
 *
 * No DB, no network — the engine is a pure function.
 */
import { describe, expect, it } from "vitest";
import { BENCHMARK_CASES } from "../scripts/benchmark/categorizerCases";
import { categorizeTransaction, SEED_CATEGORIES } from "../services/categorization/categorizer";

const LOW_CONFIDENCE_THRESHOLD = 0.65;

describe("benchmark corpus — the instrument's own invariants", () => {
  it("every expected label is an emittable SEED_CATEGORIES code, or null", () => {
    const codes = new Set(SEED_CATEGORIES.map((c) => c.systemCode));
    const bad = BENCHMARK_CASES.filter((c) => c.expected !== null && !codes.has(c.expected));
    expect(bad.map((c) => `${c.description || c.descriptionAr} → ${c.expected}`)).toEqual([]);
  });

  it("🔴 no hard-flagged case is solved by the deterministic engine at ≥0.65 — hard is a measured claim", () => {
    const leaked = BENCHMARK_CASES.filter((c) => {
      if (!c.hard) return false;
      const det = categorizeTransaction(c.description, 100, c.type, c.descriptionAr);
      return det != null && det.systemCode === c.expected && det.confidence >= LOW_CONFIDENCE_THRESHOLD;
    });
    // A failure here means the engine grew vocabulary (or a case was misjudged):
    // run scripts/benchmark/inspectCases.ts and reflag what it names.
    expect(leaked.map((c) => c.description || c.descriptionAr)).toEqual([]);
  });

  it("≥30 hard cases per language, EN and AR equal-N (the §12g bar)", () => {
    const hard = (lang: string) => BENCHMARK_CASES.filter((c) => c.language === lang && c.hard).length;
    expect(hard("en")).toBeGreaterThanOrEqual(30);
    expect(hard("ar")).toBeGreaterThanOrEqual(30);
    expect(hard("mixed")).toBeGreaterThanOrEqual(30);
    expect(hard("en")).toBe(hard("ar"));
  });

  it("restraint is measured in every language (honest-null cases exist)", () => {
    for (const lang of ["en", "ar", "mixed"] as const) {
      const nulls = BENCHMARK_CASES.filter((c) => c.language === lang && c.expected === null).length;
      expect(nulls).toBeGreaterThanOrEqual(2);
    }
  });
});
