/**
 * NO TRACKED FILE CARRIES A MERGE-CONFLICT MARKER — mechanically.
 *
 * 🔴 WHY THIS EXISTS (2026-09-14): a merge commit with an unresolved
 * conflict block in CLAUDE.md was pushed and PASSED ALL FIVE CHECKS —
 * typecheck, tests, e2e, build, secrets — because a marker in a Markdown
 * file breaks nothing any of them compile or run. It was caught by a human
 * re-grepping after the push, which is a habit, not a guarantee. This test
 * makes the state inexpressible instead: `pnpm run verify` and CI both run
 * it, so a resolution that missed a block fails loudly before merge.
 *
 * The match is anchored at LINE START and covers only the `<<<<<<<` and
 * `>>>>>>>` arms — a conflict always carries both, and the middle
 * `=======` line is deliberately excluded because a seven-character
 * Markdown setext underline is exactly seven equals signs at line start
 * (the false positive the anchor rule exists to avoid, one arm further).
 *
 * Implemented as `git grep` over TRACKED files: untracked scratch cannot
 * fail the build, and binary files are skipped by git's own detection.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Built by repetition so this file cannot match its own pattern.
const ARM = (c: string) => `^${c}{7}( |$)`;
const PATTERN = `(${ARM("<")}|${ARM(">")})`;

describe("conflict markers", () => {
  it("🔴 no tracked file contains an unresolved merge-conflict marker", () => {
    // 🔴 From the REPO ROOT, not the test's cwd: the suite runs in apps/api,
    // and `git grep -- .` from there scans only that subtree — the planted
    // positive (a marker file at the root) sailed straight past the first
    // version. The unvalidated-probe rule, cashed in on its own guard.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      cwd: process.cwd(),
    }).trim();
    let out = "";
    let exitCode = 0;
    try {
      out = execFileSync("git", ["grep", "-nIE", PATTERN, "--", "."], {
        encoding: "utf8",
        cwd: repoRoot,
      });
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? 0;
    }
    // git grep: 0 = matches found (the failure), 1 = none (the pass).
    expect(exitCode, `unresolved conflict markers found:\n${out}`).toBe(1);
    expect(out).toBe("");
  });
});
