import fs from "node:fs";

const TAILWINDY = (s) => {
  const toks = s.trim().split(/\s+/);
  const cls = toks.filter((t) => /[-:\[\]\/]/.test(t));
  return toks.length > 0 && cls.length >= Math.ceil(toks.length / 2);
};
const CODE_TOKENS = /(^s*,|new Date|as string|validation error|=>|::|:\/\/|\breturn\b|\bconst\b|\bexport\b|\bimport\b|\binterface\b|\btypeof\b|\bawait\b|\bfunction\b|[;=`]|\$\{)/;
const EXCLUDE = new Set(["KSA Ledger", "SAR", "IBAN", "VAT", "QR", "PDF", "ZATCA", "N/A", "OK"]);
const prose = (raw) => {
  const s = raw.replace(/\s+/g, " ").trim();
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
  const DQ = '"(?:[^"\\\\]|\\\\.)*"';
  const BT = "`[^`]*`";
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
  for (const m of stripped.matchAll(/[>}]([^<>{}]+)[<{]/g)) {
    const p = prose(m[1]);
    if (p) out.push(`text: ${p}`);
  }
  for (const m of stripped.matchAll(new RegExp('"((?:[^"\\\\]|\\\\.){4,120})"', "g"))) {
    const s = m[1];
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
