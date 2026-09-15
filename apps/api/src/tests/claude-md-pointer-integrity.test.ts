/**
 * EVERY POINTER IN CLAUDE.md RESOLVES — mechanically.
 *
 * 🔴 WHY THIS EXISTS (2026-09-15): the split of CLAUDE.md found two pointers
 * that said "incident: findings file" while the findings file held nothing
 * of the kind, and a §5 entry that read "OPEN as a decision" twelve days
 * after the known-issues file recorded it CLOSED. Nothing was checking. A
 * citation whose target does not exist reads exactly like one whose target
 * does — the claim-without-evidence class, in the operating file itself.
 *
 * WHAT IS CHECKED (four pointer classes, each resolved from the REPO ROOT,
 * never the suite's cwd — the conflict-marker guard's first version was
 * blind from apps/api):
 *
 *   1. Markdown links `[..](path)` → the path exists (file or directory).
 *   2. Named record pointers, one grammar:
 *        findings file, "<entry>"   ·   known-issues file, "<entry>"
 *        advisor-questions.md, "<entry>"
 *      → the target file contains an ENTRY whose lead includes <entry>
 *      (case-insensitive). An entry is a heading line, or a list/table row
 *      that opens with bold — the two shapes the history files use for a
 *      record's title.
 *   3. Commit hashes in backticks (`1d01482`) → `git cat-file -e` from the
 *      repo root. 🔴 Refuses on a shallow clone rather than skipping: CI's
 *      tests job fetches full depth for this reason (ci.yml).
 *   4. Guard/script paths in backticks (`tests/x.test.ts`, `e2e/x.spec.ts`,
 *      `scripts/x.mjs`) → the file exists under one of the known roots. A
 *      "Guard: tests/foo.test.ts" naming a test that does not exist is a
 *      check that looks like it covers something.
 *
 * WHAT IS NOT CHECKED, said plainly so this is not mistaken for a
 * staleness guard: a BARE pointer ("Record: findings file." with no named
 * entry) cannot be verified — it points at a 370k-character file, not at
 * a record. Those are COUNTED and pinned shrink-only below: a new bare
 * pointer fails (name the entry), and when one is named the pin comes
 * down. And a STATUS line ("OPEN", "NOT enforced", "✅") is not a pointer:
 * this test cannot tell whether the claim is still true — the N1 case
 * would NOT have been caught by it. Only reading the record catches that.
 *
 * VALIDATED IN BOTH DIRECTIONS: the checker runs against a planted text
 * carrying one dangling pointer of each class (must report all four) and a
 * resolving text (must report none) before the real file is judged.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
  cwd: process.cwd(),
}).trim();

/** Aliases the operating file uses for its record files. */
const RECORD_FILES: Record<string, string> = {
  "findings file": "docs/history/findings-and-lessons.md",
  "known-issues file": "docs/history/known-issues-and-audit-findings.md",
  "advisor-questions.md": "docs/product/advisor-questions.md",
};

/** Roots a backticked guard/script path may be relative to. */
const CODE_ROOTS = ["", "apps/api/src", "apps/api", "apps/web", "apps/web/src", "packages/db"];

/**
 * 🔴 The shrink-only pin on UNVERIFIABLE pointers. A bare "findings file"
 * with no entry name is a pointer this test cannot follow. The split found
 * 21 of them on 2026-09-15 and named every one against a real entry the
 * same day, so the pin starts at ZERO: a bare pointer is now inexpressible
 * in the operating file, not merely discouraged. Never raise it.
 */
const BARE_POINTERS_PINNED = 0;

type Dangling = { kind: string; pointer: string; reason: string };

const norm = (s: string) => s.split("\r\n").join("\n");

function entryLines(text: string): string[] {
  return norm(text)
    .split("\n")
    .filter((l) => /^#{1,6} /.test(l) || /^\s*[-*] \*\*/.test(l) || /^\| \*\*/.test(l))
    .map((l) => l.toLowerCase());
}

function commitExists(hash: string, root: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${hash}^{commit}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The checker. `readTarget` and `commitOk` are injectable so the planted
 * texts can be judged without touching the real tree.
 */
export function findDangling(
  text: string,
  deps: {
    root: string;
    readTarget: (rel: string) => string | null;
    pathExists: (rel: string) => boolean;
    commitOk: (hash: string) => boolean;
  },
): { dangling: Dangling[]; bare: string[]; named: number } {
  const dangling: Dangling[] = [];
  const bare: string[] = [];
  let named = 0;
  const src = norm(text);

  // 1. Markdown links.
  for (const m of src.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1].replace(/#.*$/, "");
    if (/^[a-z]+:\/\//.test(target)) continue; // external — not this test's claim
    if (!deps.pathExists(target)) dangling.push({ kind: "link", pointer: target, reason: "path does not exist" });
  }

  // 2. Named record pointers, and 2b. bare ones.
  const aliases = Object.keys(RECORD_FILES).map((a) => a.replace(/[.]/g, "\\.")).join("|");
  // One alias may name several entries: findings file, "A" and "B" · "C".
  const namedRe = new RegExp(`(${aliases}),\\s*("[^"]+"(?:\\s*(?:,|and|·|\\+)\\s*"[^"]+")*)`, "gi");
  for (const m of src.matchAll(namedRe)) {
    const alias = m[1].toLowerCase();
    const rel = RECORD_FILES[alias];
    const body = deps.readTarget(rel);
    for (const q of m[2].matchAll(/"([^"]+)"/g)) {
      named++;
      const entry = q[1].toLowerCase();
      if (body === null) {
        dangling.push({ kind: "record-file", pointer: `${alias}, "${q[1]}"`, reason: `${rel} missing` });
        continue;
      }
      if (!entryLines(body).some((l) => l.includes(entry))) {
        dangling.push({ kind: "record-entry", pointer: `${alias}, "${q[1]}"`, reason: `no entry in ${rel} whose lead contains it` });
      }
    }
  }
  const bareRe = new RegExp(`(${aliases})(?!,\\s*")`, "gi");
  for (const m of src.matchAll(bareRe)) {
    // A markdown link's visible text ("[`docs/product/advisor-questions.md`]") is a link, not a bare pointer.
    const before = src.slice(Math.max(0, m.index! - 40), m.index!);
    if (/\[`(docs\/[a-z/-]*)?$/.test(before) || /\(docs\/[a-z/-]*$/.test(before)) continue;
    bare.push(m[0]);
  }

  // 3. Commit hashes in backticks.
  for (const m of src.matchAll(/`([0-9a-f]{7,40})`/g)) {
    const h = m[1];
    if (!/[0-9]/.test(h) || !/[a-f]/.test(h)) continue; // not hash-shaped
    if (!deps.commitOk(h)) dangling.push({ kind: "commit", pointer: h, reason: "git cat-file cannot find it" });
  }

  // 4. Guard/script paths in backticks.
  for (const m of src.matchAll(/`((?:tests|e2e|scripts|lib)\/[A-Za-z0-9_./-]+\.(?:test\.ts|spec\.ts|mjs|ts))`/g)) {
    const rel = m[1];
    if (!CODE_ROOTS.some((r) => deps.pathExists(r ? `${r}/${rel}` : rel))) {
      dangling.push({ kind: "code-path", pointer: rel, reason: `not found under ${CODE_ROOTS.join(", ")}` });
    }
  }

  return { dangling, bare, named };
}

const realDeps = {
  root: repoRoot,
  readTarget: (rel: string) => (existsSync(join(repoRoot, rel)) ? readFileSync(join(repoRoot, rel), "utf8") : null),
  pathExists: (rel: string) => existsSync(join(repoRoot, rel)),
  commitOk: (hash: string) => commitExists(hash, repoRoot),
};

describe("CLAUDE.md pointer integrity", () => {
  it("🔴 the checker SEES a dangling pointer of every class (planted positives)", () => {
    const planted = [
      "See [the doc](docs/history/does-not-exist.md).",
      'Record: findings file, "AN ENTRY THAT WAS NEVER WRITTEN".',
      "Fixed in `0badf00d` and guarded by `tests/no-such-guard.test.ts`.",
    ].join("\n");
    const { dangling } = findDangling(planted, {
      ...realDeps,
      readTarget: () => "## A REAL HEADING\n- **A real bullet**\n",
      pathExists: () => false,
      commitOk: () => false,
    });
    expect(dangling.map((d) => d.kind).sort()).toEqual(["code-path", "commit", "link", "record-entry"]);
  });

  it("…and reports NOTHING for pointers that resolve (the other direction)", () => {
    const good = [
      "See [the doc](docs/present.md).",
      'Record: findings file, "A REAL HEADING"; also known-issues file, "a real bullet".',
      "Fixed in `1d01482` and guarded by `tests/present.test.ts`.",
    ].join("\n");
    const { dangling, bare, named } = findDangling(good, {
      ...realDeps,
      readTarget: () => "## 2026-01-01 — A REAL HEADING: with a subtitle\n- **A real bullet** — text\n",
      pathExists: () => true,
      commitOk: () => true,
    });
    expect(dangling).toEqual([]);
    expect(bare).toEqual([]);
    expect(named).toBe(2);
  });

  it("🔴 refuses a shallow clone instead of passing vacuously on commit hashes", () => {
    const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: repoRoot, encoding: "utf8" }).trim();
    expect(shallow, "shallow clone: commit-hash pointers cannot be resolved — fetch full depth (ci.yml does)").toBe("false");
  });

  it("🔴 every pointer in CLAUDE.md resolves — file, entry, commit, guard", () => {
    const text = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
    const { dangling, named } = findDangling(text, realDeps);
    expect(named, "no named record pointers found — the grammar or the file changed").toBeGreaterThan(5);
    expect(
      dangling,
      `dangling pointers in CLAUDE.md:\n${dangling.map((d) => `  [${d.kind}] ${d.pointer} — ${d.reason}`).join("\n")}`,
    ).toEqual([]);
  });

  it("bare pointers (unverifiable) only SHRINK — name the entry instead of adding one", () => {
    const text = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
    const { bare } = findDangling(text, realDeps);
    expect(
      bare.length,
      `${bare.length} bare record pointers; pinned at ${BARE_POINTERS_PINNED}. A bare "findings file" cannot be followed — name the entry: findings file, "<heading>".`,
    ).toBeLessThanOrEqual(BARE_POINTERS_PINNED);
    expect(bare.length, `bare pointers fell to ${bare.length} — lower BARE_POINTERS_PINNED so the pin stays true`).toBe(BARE_POINTERS_PINNED);
  });
});
