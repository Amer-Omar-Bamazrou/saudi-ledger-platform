/**
 * RTL codemod — physical Tailwind properties -> logical properties.
 *
 * Scope: app code ONLY. `components/ui/**` is excluded on purpose: those are
 * vendored shadcn primitives, and rewriting them creates drift against every
 * future `shadcn add`. Their 105 usages are a separate, named decision.
 *
 * Only tokens INSIDE string literals are rewritten, and only when they match a
 * Tailwind class shape exactly — so `rounded-lg` is never mistaken for
 * `rounded-l`, and prose is left alone. Variants (`md:`, `hover:`, `rtl:`) and
 * negative values (`-ml-4`) are preserved.
 *
 * Run:  node scripts/rtl-codemod.mjs [--dry]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const DRY = process.argv.includes("--dry");

const files = execSync('git ls-files "apps/web/src/**/*.tsx" "apps/web/src/**/*.ts"', {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.includes("components/ui/"));

const EXACT = {
  "text-left": "text-start",
  "text-right": "text-end",
  "float-left": "float-start",
  "float-right": "float-end",
};

/** Prefix pairs whose replacement keeps the remainder of the token. */
const PREFIX = [
  ["border-l", "border-s"],
  ["border-r", "border-e"],
  ["rounded-l", "rounded-s"],
  ["rounded-r", "rounded-e"],
  ["ml", "ms"],
  ["mr", "me"],
  ["pl", "ps"],
  ["pr", "pe"],
];

/** `rounded-lg`, `border-lime-…` — a letter after l/r means it is NOT a side. */
const SIDE_IS_LETTER = /^(rounded|border)-[lr][a-z]/;

/** Inset utilities that have logical equivalents. */
const INSET = /^(left|right)-(\d|\[|full$|auto$|px$|1\/|2\/|3\/)/;

function convertToken(token) {
  // variants:  md:hover:pr-2   ->  variants="md:hover:" body="pr-2"
  const idx = token.lastIndexOf(":");
  const variants = idx === -1 ? "" : token.slice(0, idx + 1);
  let body = idx === -1 ? token : token.slice(idx + 1);

  let sign = "";
  if (body.startsWith("-")) {
    sign = "-";
    body = body.slice(1);
  }

  let out = null;

  if (EXACT[body]) {
    out = EXACT[body];
  } else if (!SIDE_IS_LETTER.test(body)) {
    for (const [from, to] of PREFIX) {
      if (body === from) {
        out = to;
        break;
      }
      if (body.startsWith(from + "-")) {
        out = to + body.slice(from.length);
        break;
      }
    }
    if (out === null && INSET.test(body)) {
      if (body.startsWith("left-")) out = "start-" + body.slice("left-".length);
      else if (body.startsWith("right-")) out = "end-" + body.slice("right-".length);
    }
  }

  return out === null ? null : variants + sign + out;
}

// Matches a single-, double- or backtick-quoted literal, honouring escapes.
const QUOTE = new RegExp(
  "([\"'`])((?:\\\\.|(?!\\1)[^\\\\])*?)\\1",
  "g",
);

let totalTokens = 0;
const perFile = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  let changed = 0;

  const out = src.replace(QUOTE, (whole, quote, body) => {
    if (body.indexOf("-") === -1) return whole;
    const parts = body.split(/(\s+)/).map((seg) => {
      if (seg === "" || /^\s+$/.test(seg)) return seg;
      const converted = convertToken(seg);
      if (converted !== null && converted !== seg) {
        changed++;
        return converted;
      }
      return seg;
    });
    return quote + parts.join("") + quote;
  });

  if (changed > 0) {
    totalTokens += changed;
    perFile.push({ file, changed });
    if (!DRY) writeFileSync(file, out);
  }
}

perFile.sort((a, b) => b.changed - a.changed);
console.log(DRY ? "DRY RUN — nothing written\n" : "APPLIED\n");
for (const { file, changed } of perFile.slice(0, 20)) {
  console.log(`  ${String(changed).padStart(3)}  ${file}`);
}
if (perFile.length > 20) console.log(`  … and ${perFile.length - 20} more files`);
console.log(`\n  ${totalTokens} tokens across ${perFile.length} files (components/ui excluded)`);
