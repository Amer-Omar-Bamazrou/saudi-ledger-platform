/**
 * Corpus inspection (2026-08-23) — prints, for every case flagged `hard`, what
 * the deterministic engine actually does with it (code + confidence).
 *
 * The `hard` flag is a CLAIM about the engine ("not expected to solve alone"),
 * and a claim about the engine is checkable against the engine — a case the
 * engine solves at ≥0.65 never reaches the LLM in hybrid mode, so leaving it
 * flagged hard pads the hard-only baseline and dulls exactly the measurement
 * the flag exists to sharpen. Run after any corpus edit:
 *   npx tsx src/scripts/benchmark/inspectCases.ts
 */
import { categorizeTransaction } from "../../services/categorization/categorizer";
import { BENCHMARK_CASES } from "./categorizerCases";

for (const c of BENCHMARK_CASES) {
  if (!c.hard) continue;
  const det = categorizeTransaction(c.description, 100, c.type, c.descriptionAr);
  const got = det?.systemCode ?? null;
  const conf = det?.confidence ?? 0;
  const solved = got === c.expected && conf >= 0.65;
  const label = solved ? "ENGINE-SOLVED" : got === c.expected ? "low-conf-right" : got === null ? "engine-null" : "engine-wrong";
  console.log(
    `${label.padEnd(14)} [${c.language}] expected=${String(c.expected).padEnd(18)} got=${String(got).padEnd(18)} conf=${conf.toFixed(2)}  ${c.description || c.descriptionAr}`,
  );
}
