/**
 * 🔴 THE BUSINESS-DATE SEAM IS THE ONLY "TODAY" (2026-09-16).
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC calendar day, and at
 * 01:00 Riyadh it is yesterday. The pre-pilot batch replaced every such
 * "today" in both apps with `businessToday()` from `@workspace/shared`
 * (`business-date-night-window.test.ts` proves the seam). This test makes
 * the wrong thing INEXPRESSIBLE rather than forbidden by review: any new
 * inline derivation of a calendar day from the raw clock fails CI on the
 * commit that adds it, naming the file and line.
 *
 * What it forbids: a day, month or year sliced off the ISO string of the
 * current instant (`new Date()` / `Date.now()`). What it leaves alone:
 * formatting a SPECIFIC instant (a stored timestamp, a `Date.UTC(...)`
 * month-end), full ISO timestamps in audit strings, and the seam's own
 * implementation.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = [join(HERE, "../../src"), join(HERE, "../../../web/src")];
const REPO = join(HERE, "../../../..");

// A DAY (…slice(0, 10) / .split("T")[0]) or a MONTH (…slice(0, 7)) or a
// YEAR (…slice(0, 4)) taken off the current instant. A full timestamp
// (`slice(0, 19)` for a filename stamp) is an instant, not a business date.
const DAY_OR_SHORTER = String.raw`\.(slice\(0,\s*(4|7|10)\)|split\("T"\)|substring\(0,\s*(4|7|10)\))`;
const FORBIDDEN = [
  new RegExp(String.raw`new Date\(\)\s*\.toISOString\(\)\s*` + DAY_OR_SHORTER),
  new RegExp(String.raw`new Date\(\s*Date\.now\(\)[^)]*\)\s*\.toISOString\(\)\s*` + DAY_OR_SHORTER),
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "tests" || name === "generated" || name === "node_modules" || name === "dist") continue;
      walk(p, acc);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".spec.ts")) acc.push(p);
  }
  return acc;
}

describe("the business-date seam", () => {
  it("no source file derives a calendar day from the raw UTC clock — businessToday()/businessDate() are the one way", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (FORBIDDEN.some((re) => re.test(line))) hits.push(`${relative(REPO, file).replace(/\\/g, "/")}:${i + 1}  ${line.trim()}`);
        });
      }
    }
    expect(hits, [
      "A calendar day is being sliced off the UTC clock. That is yesterday between 00:00 and 03:00 Riyadh.",
      "Use businessToday() / businessDate(at) / businessDateShift() from @workspace/shared instead.",
      ...hits,
    ].join("\n")).toEqual([]);
  });

  it("is actually reading both apps (the guard is not vacuous)", () => {
    const files = ROOTS.flatMap((r) => walk(r));
    expect(files.length).toBeGreaterThan(200);
    const usingSeam = files.filter((f) => /businessToday\(|businessDate\(/.test(readFileSync(f, "utf8")));
    expect(usingSeam.length, "the seam is consumed by both apps").toBeGreaterThan(20);
  });
});
