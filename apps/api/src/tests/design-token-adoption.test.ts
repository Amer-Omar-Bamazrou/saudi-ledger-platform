/**
 * THE DESIGN TOKEN RATCHET.
 *
 * ── 🔴 WHY THIS EXISTS ─────────────────────────────────────────────────────
 * The app had a token layer and did not use it. Measured 2026-08-31: **604**
 * raw Tailwind palette classes (`text-emerald-400`, `bg-red-500/20`, …) across
 * 56 of 107 files, while five semantic accounting tokens sat in `index.css`
 * with **zero consumers** — defined, wired into five `badge.tsx` variants, and
 * used by no page. A shape without a consumer, in the design layer.
 *
 * Raw palette classes are not a style preference. They are the reason a colour
 * change is a 56-file edit instead of a one-line one, and the reason two things
 * that mean the same thing can drift apart without anything noticing.
 *
 * ── WHY A RATCHET AND NOT A BAN ────────────────────────────────────────────
 * A ban would fail today: 45 occurrences remain that the tokens deliberately do
 * not cover — shades outside 400/500, and families (orange, purple, violet,
 * zinc) with too few uses to name a meaning for honestly. Naming a token for a
 * colour used twice is how the last five orphan tokens happened.
 *
 * So the guard holds the line instead: the count may fall, never rise. New code
 * reaches for a token because the alternative goes red.
 *
 * 🔴 **RAISING `BASELINE` IS NOT A WAY TO PASS THIS TEST** — the same rule as
 * the CLAUDE.md budget. If a genuinely new meaning needs a colour, add a TOKEN
 * for it (and a consumer, in the same commit), rather than a raw class.
 *
 * ── THE ANTI-VACUITY HALF ──────────────────────────────────────────────────
 * A scanner that stops seeing files reports a beautifully low number. The
 * companion assertion pins the file count, so coverage shrinking goes red
 * rather than green — the failure this project has already had once, in the
 * list-shape guard.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Measured after the 2026-08-31 conversion (was 604). Ratchet DOWN only. */
const BASELINE = 45;

/**
 * Files the scanner saw when this guard was written. If it sees fewer, it has
 * gone partially blind and its count means less than it appears to.
 */
const FILES_AT_WRITING = 107;

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const webSrc = join(repoRoot, "apps", "web", "src");

/**
 * `components/ui/**` is EXCLUDED, and that is a recorded decision rather than
 * an oversight: own-or-track (2026-08-27) decided not to own the vendored
 * shadcn components, because rewriting them makes every one a merge conflict
 * against every future upgrade. Scanning what we have decided not to edit would
 * produce a number nobody may act on.
 */
const PALETTE =
  /\b(?:text|bg|border|ring|from|to|via|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;

function scan(): { total: number; files: number; byFile: Array<[number, string]> } {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "ui") walk(p);
      } else if (/\.(tsx|ts)$/.test(entry.name)) {
        files.push(p);
      }
    }
  })(webSrc);

  let total = 0;
  const byFile: Array<[number, string]> = [];
  for (const f of files) {
    const hits = readFileSync(f, "utf8").match(PALETTE) ?? [];
    if (hits.length > 0) {
      total += hits.length;
      byFile.push([hits.length, f.slice(repoRoot.length + 1).split("\\").join("/")]);
    }
  }
  byFile.sort((a, b) => b[0] - a[0]);
  return { total, files: files.length, byFile };
}

describe("design token adoption", () => {
  it("🔴 raw palette classes never increase — reach for a token, or add one", () => {
    const { total, byFile } = scan();
    const worst = byFile
      .slice(0, 8)
      .map(([n, f]) => `    ${String(n).padStart(3)}  ${f}`)
      .join("\n");

    expect(
      total,
      `Raw Tailwind palette classes rose to ${total}, over the ${BASELINE} baseline.\n` +
        `\n` +
        `This is not a style nit. A raw palette class is why changing a colour is a\n` +
        `56-file edit, and why two things that mean the same thing drift apart.\n` +
        `\n` +
        `Use a semantic token instead:\n` +
        `    text-emerald-400  ->  text-positive        bg-emerald-500/20  ->  bg-positive-surface/20\n` +
        `    text-red-400      ->  text-negative        bg-red-500/20      ->  bg-negative-surface/20\n` +
        `    text-amber-400    ->  text-attention       bg-amber-500/20    ->  bg-attention-surface/20\n` +
        `    text-blue-400     ->  text-info            bg-blue-500/20     ->  bg-info-surface/20\n` +
        `\n` +
        `If the colour means something none of those cover, add a TOKEN and a consumer\n` +
        `in the same commit. Do NOT raise BASELINE — that is how the orphan tokens happened.\n` +
        `\n` +
        `Highest counts now:\n${worst}`,
    ).toBeLessThanOrEqual(BASELINE);
  });

  it("the scanner still sees the whole app (anti-vacuity — a blind scan reports a great number)", () => {
    const { files } = scan();
    expect(
      files,
      `The scan walked ${files} files, down from ${FILES_AT_WRITING}. Either files were removed,\n` +
        `or the walk stopped reaching part of the tree — which lowers the count for a reason\n` +
        `that has nothing to do with adoption. Widen the scan; do not lower this number.`,
    ).toBeGreaterThanOrEqual(FILES_AT_WRITING);
  });

  it("🔴 the semantic tokens are DEFINED, so the classes above resolve to something", () => {
    const css = readFileSync(join(webSrc, "index.css"), "utf8");
    for (const token of [
      "--color-positive",
      "--color-positive-surface",
      "--color-negative",
      "--color-negative-surface",
      "--color-attention",
      "--color-attention-surface",
      "--color-info",
      "--color-info-surface",
    ]) {
      expect(css, `${token} is missing from index.css — every converted class silently renders unstyled`).toContain(
        `${token}:`,
      );
    }
  });

  /**
   * 🔴 The consumer half, and the reason this file exists at all. The five
   * accounting tokens were defined and consumed by nothing; the state tokens
   * must not repeat that. A token with no consumer is not a design system, it
   * is a decision nobody took.
   */
  it("🔴 each semantic token has a real CONSUMER in app code, not just a definition", () => {
    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "ui") walk(p);
        } else if (/\.(tsx|ts)$/.test(entry.name)) files.push(p);
      }
    })(webSrc);
    const source = files.map((f) => readFileSync(f, "utf8")).join("\n");

    for (const name of ["positive", "negative", "attention", "info"]) {
      const used = new RegExp(`\\b(?:text|bg|border|ring|fill|stroke)-${name}(?:-surface)?\\b`).test(source);
      expect(used, `no page uses the "${name}" token — it is a definition with no consumer, like the five before it`).toBe(
        true,
      );
    }
  });
});
