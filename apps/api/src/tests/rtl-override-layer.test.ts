/**
 * THE RTL OVERRIDE LAYER'S EXCLUSION LIST, PINNED.
 *
 * ── 🔴 WHY THE EXCLUSIONS NEED A GUARD AND THE RULES DO NOT ────────────────
 * The rules are self-evidencing: if `pl-8` stops flipping, Arabic looks wrong
 * and someone says so. The EXCLUSIONS are the opposite — they look like an
 * unfinished list. The natural instinct on reading "24 of 39 utilities are
 * flipped" is to finish the job, and finishing it is exactly the mistake:
 *
 *   `left-[50%]` / `left-1/2` is CENTRING, always paired with
 *   `-translate-x-1/2`. Centred is centred in both directions. Flipping it
 *   moves every dialog, alert-dialog and carousel off-centre — in Arabic only,
 *   which is the language the layer exists for.
 *
 * That is the same shape as the guardrail that killed the server: a change
 * that looks green and is visibly broken where it matters most.
 *
 * So the excluded utilities are asserted ABSENT from the layer. A future
 * contributor who adds them has to delete an assertion that explains why they
 * are missing, which is the point.
 *
 * ── 🔴 AND A VACUOUS GREEN, CAUGHT INSIDE THIS FILE ────────────────────────
 * The first version built its patterns with `new RegExp` from template
 * literals, and the heredoc that wrote the file collapsed the escapes: `\\b`
 * became `\b`, which in a JS template literal is a **backspace character**, not
 * a word boundary. Every pattern silently matched nothing.
 *
 * **Both exclusion assertions then passed vacuously** — they would have passed
 * with every excluded utility present, which is the precise opposite of what
 * they exist to check. Only the PAIRED PRESENCE assertion ("the layer does flip
 * the safe ones") went red and exposed it.
 *
 * Assert presence AND absence. The rule earned itself inside a guard written to
 * prevent a different mistake — so the matching here is a plain string search
 * with no escaping to get wrong.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, "../../../web/src");
const css = readFileSync(join(WEB_SRC, "rtl-overrides.css"), "utf8");

/**
 * Rule bodies only — the header comment names the exclusions on purpose — with
 * CSS ESCAPES REMOVED.
 *
 * 🔴 The second vacuity in this file, and it survived the first fix. A class
 * containing `/`, `.`, `[`, `]` or `%` must be escaped in a selector, so
 * `left-1/2` is written `.left-1\\/2`. A literal search for `.left-1/2` therefore
 * matches nothing — and the exclusion assertions passed again while a flip for
 * an excluded utility sat three lines above them in the file.
 *
 * Caught only by FAULT-INJECTING the guard: adding the forbidden rule and
 * watching the test stay green. A guard that has never been shown to fail is a
 * guard nobody has tested.
 */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\\/g, "");

/**
 * Is this utility flipped by the layer? A selector is `.<utility>` followed by
 * whitespace or `{`, so three literal checks cover it without a regex.
 */
function flips(utility: string): boolean {
  return (
    rules.includes(`.${utility} `) ||
    rules.includes(`.${utility}{`) ||
    rules.includes(`.${utility}\t`) ||
    rules.includes(`.${utility}\n`)
  );
}

/** 🔴 Never flip. Centring and box geometry, not direction. */
const MUST_NOT_FLIP = [
  "left-1/2",
  "left-[50%]",
  "right-1/2",
  "right-[50%]",
  "left-full",
  "right-full",
];

/** Flipping these needs a per-occurrence judgement CSS cannot make. */
const NEEDS_HAND_AUDIT = [
  "left-0", "right-0", "left-1", "right-1", "left-2", "right-2",
  "left-3", "right-3", "left-4", "right-4", "left-12", "right-12",
  "left-52", "right-52",
];

/** The ones that are unambiguously directional and MUST be flipped. */
const MUST_FLIP = ["pl-8", "pr-2", "ml-auto", "rounded-l-md", "border-l-0"];

describe("the RTL override layer", () => {
  it("is not vacuous — the matcher works and the layer has rules", () => {
    // 🔴 The matcher is tested before it is trusted. This is the assertion the
    // first version of this file needed and did not have.
    expect(flips("pl-8"), "the matcher itself is broken").toBe(true);
    expect(flips("definitely-not-a-utility")).toBe(false);
    expect((rules.match(/\[dir='rtl'\]/g) ?? []).length).toBeGreaterThan(20);
  });

  it("🔴 never flips CENTRING geometry — an off-centre dialog is worse than unflipped padding", () => {
    expect(
      MUST_NOT_FLIP.filter(flips),
      "A centring or full-box utility is being flipped. `left-1/2` and `left-[50%]` " +
        "are paired with `-translate-x-1/2` in dialog, alert-dialog, carousel, " +
        "resizable and sidebar — flipping them moves every modal off-centre in Arabic.",
    ).toEqual([]);
  });

  it("🔴 does not flip POSITIONING utilities that are directional in one component and geometric in another", () => {
    expect(
      NEEDS_HAND_AUDIT.filter(flips),
      "A positioning utility is being flipped globally. At least one (`left-0`) is " +
        "directional in navigation-menu and sidebar and GEOMETRIC in resizable, where " +
        "it resets the handle for a vertical panel group. CSS sees the class, not the " +
        "intent — these need a per-occurrence audit, not a blanket rule.",
    ).toEqual([]);
  });

  it("flips the things that are unambiguously directional", () => {
    // Paired with the two above: a layer that excluded EVERYTHING would satisfy
    // both absence assertions and do nothing at all.
    const missing = MUST_FLIP.filter((u) => !flips(u));
    expect(missing, "the layer stopped flipping utilities it is meant to flip").toEqual([]);
  });

  it("🔴 is imported, or it is a file that does nothing", () => {
    const index = readFileSync(join(WEB_SRC, "index.css"), "utf8");
    expect(
      index.includes("rtl-overrides.css"),
      "the override layer is not imported — the rules exist and reach no page",
    ).toBe(true);
  });
});
