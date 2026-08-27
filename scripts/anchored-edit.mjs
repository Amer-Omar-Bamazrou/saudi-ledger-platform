#!/usr/bin/env node
/**
 * anchored-edit — the standing pattern for scripted edits to TRACKED files.
 *
 * 🔴 WHY THIS EXISTS (2026-08-27). A scripted edit to a tracked file was driven
 * by a shell variable that was empty. The command it built did not fail and did
 * not match nothing: with no address to match on, `sed` applied the append to
 * EVERY line, so a one-line change became a change to every line of the file.
 * The tool reported success. Same shape as `rm -rf "$DIR"/` with `DIR` unset —
 * a command that cannot distinguish "no target" from "all targets", and whose
 * default on ambiguity is maximal action.
 *
 * The countermeasure is not more care with quoting. It is to make the ambiguous
 * case IMPOSSIBLE TO EXPRESS: every edit must name an anchor, the anchor must
 * match EXACTLY ONCE, and anything else — zero matches, two matches, an empty
 * anchor — aborts having written nothing. "No target" and "all targets" then
 * have different, loud outcomes, which is the property sed lacks.
 *
 * USAGE (anchor/replacement/insertion come from files or stdin, never from
 * interpolated shell — interpolation is how the empty variable got in):
 *
 *   node scripts/anchored-edit.mjs --file <path> --anchor <anchorFile> \
 *        [--replace <newFile> | --after <insertFile> | --before <insertFile>] \
 *        [--allow-untracked] [--dry-run]
 *
 * Exit codes: 0 applied · 1 refused (anchor not unique / empty / missing file).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(name);

const file = arg("--file");
const anchorFile = arg("--anchor");
const mode = ["--replace", "--after", "--before"].find(has);
const payloadFile = mode ? arg(mode) : undefined;

const die = (msg) => {
  console.error(`anchored-edit: REFUSED — ${msg}`);
  console.error("anchored-edit: nothing was written.");
  process.exit(1);
};

if (!file) die("--file is required");
if (!anchorFile) die("--anchor is required");
if (!mode) die("one of --replace / --after / --before is required");
if (!payloadFile) die(`${mode} needs a file path`);

// A tracked file is one a mistake is committed into. Untracked scratch files
// may opt out, but must say so explicitly.
if (!has("--allow-untracked")) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", file], { stdio: "ignore" });
  } catch {
    die(`${file} is not tracked by git (pass --allow-untracked if that is intended)`);
  }
}

const original = readFileSync(file, "utf8");
const anchor = readFileSync(anchorFile, "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
const payload = readFileSync(payloadFile, "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
const source = original.replace(/\r\n/g, "\n");

// 🔴 The whole point. An empty anchor matches at every position; a repeated
// anchor edits a place the author did not look at. Both abort.
if (anchor.trim() === "") die("the anchor is EMPTY — this is the failure mode this tool exists to stop");

let count = 0;
let from = 0;
for (;;) {
  const at = source.indexOf(anchor, from);
  if (at === -1) break;
  count += 1;
  from = at + anchor.length;
  if (count > 1) break;
}
if (count === 0) die(`the anchor does not appear in ${file}`);
if (count > 1) die(`the anchor appears more than once in ${file} — it does not identify one place`);

const at = source.indexOf(anchor);
const replacement =
  mode === "--replace" ? payload
  : mode === "--after" ? `${anchor}\n${payload}`
  : `${payload}\n${anchor}`;
const updated = source.slice(0, at) + replacement + source.slice(at + anchor.length);

if (has("--dry-run")) {
  console.log(`anchored-edit: would apply ${mode} to ${file} (anchor matched exactly once).`);
  process.exit(0);
}
writeFileSync(file, updated);
console.log(`anchored-edit: applied ${mode} to ${file} (anchor matched exactly once).`);
