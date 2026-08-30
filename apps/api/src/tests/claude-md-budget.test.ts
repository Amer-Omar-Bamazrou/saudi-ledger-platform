import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE OPERATING FILE'S SIZE BUDGET, MECHANIZED.
 *
 * ── 🔴 WHY THIS EXISTS: PROSE ASKING FOR RESTRAINT HAS FAILED TWICE ────────
 * `CLAUDE.md` is loaded into every session. It was 207k characters and was
 * TRUNCATED in every session that read it — the operating rules silently
 * stopped arriving partway through. It was restructured to 35k, carried a
 * written budget of "well under 100k", and was back to 157k within four weeks.
 *
 * The regrowth is not carelessness, and that is the point. **Writing has a
 * trigger and deleting has none**: a session that closes a milestone, finds a
 * defect or answers a question is the session with the most to say about it,
 * and no session is ever the one whose job is to remove what an earlier one
 * wrote. So the file only ever grows, and every growth is individually
 * justified.
 *
 * A budget stated in prose is advice to a reader who is, at that moment,
 * writing. A budget stated as a failing test is a trigger for deletion — the
 * one thing the process lacked. This is the §3 rule "make the wrong thing
 * inexpressible, not forbidden", applied to our own documentation.
 *
 * 🔴 **RAISING `BUDGET` IS NOT A WAY TO PASS THIS TEST.** When it goes red,
 * something in the file has become history; the three eviction rules at the top
 * of `CLAUDE.md` say where each kind of thing goes. Raising the number is how
 * the file reached 157k the first time.
 */
const BUDGET = 75_000;

/**
 * The point of truncation is what makes an over-budget file DANGEROUS rather
 * than merely long: the rules that get cut are the ones at the bottom, and
 * nothing announces that they were cut. Recorded so the number has a meaning
 * beyond taste.
 */
const OBSERVED_TRUNCATION_SIZE = 207_000;

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

/**
 * 🔴 Line endings are NORMALIZED before measuring, and that is not a detail.
 *
 * The budget is about how much of this file arrives in a session's context —
 * a property of its CONTENT. Read raw, the same file measures ~863 characters
 * larger on a Windows checkout (CRLF) than on Linux (LF), so the guard was
 * reporting a property of the developer's git config: red locally, green in
 * CI, for a file nobody had touched. A measurement that moves when the thing
 * being measured does not is the instrument's own version of the defects this
 * suite exists to catch.
 */
function readOperatingFile(): string {
  return readFileSync(join(repoRoot, "CLAUDE.md"), "utf8").split("\r\n").join("\n");
}

describe("CLAUDE.md size budget", () => {
  it("stays inside the budget that keeps it from being truncated in session context", () => {
    const text = readOperatingFile();
    const size = text.length;

    expect(
      size,
      `CLAUDE.md is ${size.toLocaleString()} characters, over the ${BUDGET.toLocaleString()} budget.\n` +
        `\n` +
        `This is not a request to trim prose. Something in the file has become HISTORY.\n` +
        `Apply the three eviction rules at the top of CLAUDE.md, in this order:\n` +
        `  1. §5 — is there a queue item marked ✅/CLOSED? It leaves in the commit that closed it;\n` +
        `     its as-built record goes to docs/history/known-issues-and-audit-findings.md.\n` +
        `  2. §3 — is a lesson longer than one line? The incident goes to\n` +
        `     docs/history/findings-and-lessons.md; the rule stays here.\n` +
        `  3. §2 — does an entry explain HOW something was built? That is a history record\n` +
        `     in the wrong file; it goes to docs/history/milestone-as-built-records.md.\n` +
        `\n` +
        `Do NOT raise BUDGET. At ${OBSERVED_TRUNCATION_SIZE.toLocaleString()} characters this file was\n` +
        `truncated in every session that loaded it, and the rules that vanished were the ones\n` +
        `at the bottom — silently, with nothing to say they had gone.`,
    ).toBeLessThanOrEqual(BUDGET);
  });

  /**
   * The anti-vacuity half. A size assertion passes trivially if the file is
   * missing, empty, or being read from the wrong path — the failure mode this
   * whole suite calls "a confident zero". If the read is wrong, THIS is the
   * test that goes red, and it names the reason.
   */
  it("is actually reading the operating file, not an empty or missing one", () => {
    const text = readOperatingFile();
    expect(text.length, "CLAUDE.md read as empty — the budget assertion above would pass vacuously").toBeGreaterThan(
      10_000,
    );
    expect(text).toContain("## 3. Standing rules");
    expect(text).toContain("## 5. Pre-production queue");
  });
});
