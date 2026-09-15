import fs from "node:fs";

// 🔴 Hold-out round 1 (2026-09-15): "Ahmed Al-Rashidi" read as half Tailwind
// because any token with a hyphen counted as a class. Tailwind classes are
// lowercase; a capitalised hyphenated token is a word.
const TAILWINDY = (s) => {
  const toks = s.trim().split(/\s+/);
  const cls = toks.filter((t) => /[-:\[\]\/]/.test(t) && /^[a-z0-9\-:\[\]\/.%!#]+$/.test(t));
  return toks.length > 0 && cls.length >= Math.ceil(toks.length / 2);
};
// 🔴 The `\b`s here were literal BACKSPACE bytes (0x08) until 2026-09-15 — the
// file was first written through a template string — so `new Date`, `as string`
// and `validation error` had never matched. Found by hold-out round 1.
// `??`, `?.` and `| null` added by hold-out round 3 (a type-cast fragment).
const CODE_TOKENS = /(^s*,|\bnew Date\b|\bas string\b|\bvalidation error\b|=>|::|:\/\/|\?\?|\?\.|\|\s*null\b|\breturn\b|\bconst\b|\bexport\b|\bimport\b|\binterface\b|\btypeof\b|\bawait\b|\bfunction\b|[;=`]|\$\{)/;
const EXCLUDE = new Set(["KSA Ledger", "SAR", "IBAN", "VAT", "QR", "PDF", "ZATCA", "N/A", "OK"]);
const prose = (raw) => {
  const s = raw.replace(/\s+/g, " ").trim();
  // 🔴 Hold-out round 1: "CR:" sat under the 4-char floor. A short
  // abbreviation ending in a colon is a LABEL, unless it is on the exclude list.
  if (/^[A-Za-z]{2,3}:$/.test(s)) return EXCLUDE.has(s.slice(0, -1)) ? null : s;
  if (s.length < 4 || !/[a-z]/.test(s) || !/[A-Za-z]{3}/.test(s)) return null;
  if (EXCLUDE.has(s)) return null;
  if (CODE_TOKENS.test(s)) return null;
  if (TAILWINDY(s)) return null;
  if (!/[A-Za-z] [A-Za-z]/.test(s) && !/^[A-Z][a-z]{3,}/.test(s)) return null;
  if (/^[a-z][A-Za-z0-9]*$/.test(s)) return null;
  return s;
};

export function scan(src) {
  const out = [];
  const DQ = '"(?:[^"\\\\\\n]|\\\\.)*"'; // no raw newline inside a JS string — keeps quote parity per line
  // A template literal may carry ONE level of nested template inside ${…}
  // (`${x.number ?? \`#${x.id}\`}`) — the backtick twin of the quote-parity
  // defect: `[^`]*` paired the inner backtick with the outer and read the
  // rest of the file out of phase.
  const BT = "`(?:[^`\\\\$]|\\\\.|\\$(?!\\{)|\\$\\{(?:[^{}`]|`[^`]*`)*\\})*`";
  let stripped = src
    .replace(new RegExp("\\b(?:t|tOutside)\\(\\s*(" + DQ + "|" + BT + ")\\s*,\\s*(" + DQ + "|" + BT + ")", "g"), "t(TX, TX")
    .replace(new RegExp('lang\\s*===\\s*"ar"\\s*\\?\\s*(' + DQ + "|" + BT + ")\\s*:\\s*(" + DQ + "|" + BT + ")", "g"), "LANGTX")
    .replace(new RegExp('lang\\s*===\\s*"en"\\s*\\?\\s*(' + DQ + "|" + BT + ")\\s*:\\s*(" + DQ + "|" + BT + ")", "g"), "LANGTX")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // idiom 3: paired fields — an English value whose <key>Ar sibling follows
  stripped = stripped.replace(
    new RegExp("(\\w+):\\s*(" + DQ + "|" + BT + ")(\\s*,\\s*)(\\w+)Ar\\s*:", "g"),
    (m, k1, _v, sep, k2) => (k1 === k2 ? `${k1}: TX${sep}${k2}Ar:` : m),
  );
  // idiom 5: { en: "…", ar: "…" } label objects
  stripped = stripped.replace(
    new RegExp("\\ben(\\w*):\\s*(" + DQ + "|" + BT + ")\\s*,\\s*ar\\1:\\s*(" + DQ + "|" + BT + ")", "gs"),
    "en$1: TX, ar$1: TXAR",
  );
  // idiom 4: positional pairs — an English literal immediately followed by
  // an Arabic literal ("English", "العربية") is a translated pair wherever
  // it appears (the nav tree's built(...) helper, and array data).
  stripped = stripped.replace(
    new RegExp("(" + DQ + ")\\s*,\\s*(\"[^\"]*[\\u0600-\\u06FF][^\"]*\"|`[^`]*[\\u0600-\\u06FF][^`]*`)", "g"),
    '"TX", "TXAR"',
  );
  // 🔴 Hold-out round 1: the twelve Gregorian month names were rendered via
  // t(m, m) — the Arabic arm IS the English word — and every one is a
  // single-word literal the str: pass cannot see (it requires a space). A
  // const holding a list of ≥3 capitalised English words is a DISPLAY LIST,
  // flagged unless a sibling NAME_AR / NAMEAr list exists in the file (the
  // paired-array idiom, like HIJRI_MONTHS / HIJRI_MONTHS_AR).
  const hasArSibling = (name) => {
    const base = name.replace(/_EN$|En$/, "");
    return new RegExp(`\\b${base}_AR\\b|\\b${base}Ar\\b`).test(src);
  };
  // An entry is a capitalised word, or a few words ("Rabi' al-Awwal") — a list
  // of DISPLAY names, not a list of sentences.
  const LIST = /const\s+(\w+)\s*(?::[^=]+)?=\s*\[\s*((?:"[A-Z][A-Za-z'’-]{2,}(?: [A-Za-z'’-]+){0,2}"\s*,\s*){2,}"[A-Z][A-Za-z'’-]{2,}(?: [A-Za-z'’-]+){0,2}")/g;
  for (const m of stripped.matchAll(LIST)) {
    const name = m[1];
    const words = [...m[2].matchAll(/"([^"]+)"/g)].map((w) => w[1]).filter((w) => w !== "TX" && w !== "TXAR");
    if (words.length < 3) continue;
    if (hasArSibling(name)) {
      // idiom 6: a paired display list (NAME / NAME_AR) is translated at use —
      // blank its literals so the str: pass does not read them as untranslated.
      stripped = stripped.replace(m[2], m[2].replace(/"[^"]+"/g, '"TX"'));
      continue;
    }
    out.push(`list: ${name} = ${words.slice(0, 4).join(", ")}${words.length > 4 ? ", …" : ""} (${words.length} words)`);
  }
  for (const m of stripped.matchAll(/[>}]([^<>{}]+)[<{]/g)) {
    const p = prose(m[1]);
    if (p) out.push(`text: ${p}`);
  }
  // 🔴 Hold-out round 2 (2026-09-15): "Login failed" was missed because the
  // pass matched only literals of ≥4 chars — so at `navigate("/")` the engine
  // failed at the short literal's opening quote, then paired its CLOSING quote
  // with the NEXT string's opening quote, and read every other literal in the
  // rest of the file as junk. Tokenise EVERY string (no raw newlines — a JS
  // string cannot contain one) so quote parity never drifts; filter by length
  // afterwards.
  for (const m of stripped.matchAll(new RegExp('"((?:[^"\\\\\\n]|\\\\.)*)"', "g"))) {
    const s = m[1];
    if (s.length < 4 || s.length > 120) continue;
    if (/^[؀-ۿ]/.test(s)) continue;
    const p = prose(s);
    if (p && / /.test(p)) out.push(`str: ${p}`);
  }
  return [...new Set(out)];
}

const files = process.argv.slice(2);
let total = 0;
for (const f of files) {
  const hits = scan(fs.readFileSync(f, "utf8"));
  total += hits.length;
  if (hits.length) {
    console.log(`== ${f} (${hits.length})`);
    for (const h of hits) console.log("   ", h);
  }
}
console.log(`TOTAL: ${total}`);
