#!/usr/bin/env node
/**
 * THE GATE — `pnpm run verify`.
 *
 * Runs exactly what CI's non-e2e jobs run, in CI's order, and stops at the
 * first failure.
 *
 * ── 🔴 WHY THIS IS A SCRIPT AND NOT A `&&` CHAIN ──────────────────────────
 * It exists to answer one question honestly: *what has actually been
 * verified?* A `&&` chain answers "something failed" and says nothing about
 * scope, so the reader supplies the scope from memory — which is the defect
 * this gate was built for (2026-09-02: "the tests pass" was TRUE, "the
 * typecheck passes" was FALSE, and the first was reported as covering the
 * second).
 *
 * So the gate STATES ITS OWN LIMITS at the moment someone reads it, pass or
 * fail — the same reasoning as a Coming Soon page naming its blocker: a limit
 * you have to go and look up is a limit nobody looks up.
 */
import { spawnSync } from "node:child_process";

/** CI's non-e2e jobs, in CI's order. Keep this list equal to .github/workflows/ci.yml. */
const STEPS = [
  { name: "typecheck", args: ["run", "typecheck"] },
  { name: "api-server tests", args: ["--filter", "@workspace/api-server", "run", "test"] },
  { name: "db tests", args: ["--filter", "@workspace/db", "run", "test"] },
  { name: "zatca-tlv tests", args: ["--filter", "@workspace/zatca-tlv", "run", "test"] },
  { name: "web tests", args: ["--filter", "@workspace/bookkeeping", "run", "test"] },
  { name: "build", args: ["run", "build"] },
];

/**
 * 🔴 What this gate does NOT cover. Printed every time, because the moment a
 * gate goes green is exactly the moment somebody is about to report it as
 * proof of something wider.
 */
const NOT_COVERED = [
  "the BROWSER suite — run `pnpm --filter @workspace/bookkeeping run test:e2e`",
  "whether a page RENDERS, or a control does anything when clicked (P5's job)",
  "anything needing a live external service: ZATCA's sandbox, a mail provider, Groq",
  "migrations against a real deployment, and the deployment-time queue items (C1, C3, C4, C6)",
];

/**
 * 🔴 One command STRING with `shell: true`, not a program plus an args array.
 *
 * Two constraints meet here and only this satisfies both. Node >= 20 refuses to
 * spawn a `.cmd` (pnpm on Windows is `pnpm.CMD`) without a shell, so `shell`
 * cannot be dropped; and passing an ARGS ARRAY with `shell: true` warns
 * DEP0190 on every run, which teaches people to skim this gate's output. A
 * single pre-joined string does neither. The commands are hard-coded constants
 * a few lines above — nothing here is built from input.
 */
const command = (args) => `pnpm ${args.join(" ")}`;

const line = (ch = "─") => ch.repeat(72);

function limits(heading) {
  console.log(`\n${line()}`);
  console.log(heading);
  for (const item of NOT_COVERED) console.log(`  · ${item}`);
  console.log(line());
}

const started = Date.now();
for (const step of STEPS) {
  console.log(`\n[36m▶ verify: ${step.name}[0m`);
  const run = spawnSync(command(step.args), { stdio: "inherit", shell: true });

  /**
   * 🔴 A step that could not be LAUNCHED is not a step that FAILED, and a gate
   * that cannot tell them apart is the defect it exists to prevent. (Earned:
   * spawning `pnpm.cmd` without a shell fails silently on Node >= 20, and this
   * gate reported it as "typecheck failed" with no output — indistinguishable
   * from a real type error until someone read the empty log.)
   */
  if (run.error) {
    console.error(`
[31m✖ verify could not RUN: ${step.name}[0m`);
    console.error(`  ${String(run.error.message ?? run.error)}`);
    console.error("  🔴 Nothing was verified — this is a broken runner, not a failing check.");
    process.exit(1);
  }

  if (run.status !== 0) {
    console.error(`\n[31m✖ verify FAILED at: ${step.name}[0m`);
    const reached = STEPS.slice(0, STEPS.indexOf(step)).map((s) => s.name);
    console.error(
      reached.length > 0
        ? `  Passed before it: ${reached.join(", ")}.`
        : "  Nothing ran before it.",
    );
    const skipped = STEPS.slice(STEPS.indexOf(step) + 1).map((s) => s.name);
    if (skipped.length > 0) {
      console.error(`  🔴 NOT RUN, so NOT verified: ${skipped.join(", ")}.`);
    }
    limits("🔴 And `verify` does not cover these at all, even when it passes:");
    process.exit(run.status ?? 1);
  }
}

console.log(`\n[32m✔ verify passed[0m (${Math.round((Date.now() - started) / 1000)}s) — ${STEPS.map((s) => s.name).join(", ")}.`);
limits("🔴 What a green `verify` does NOT prove:");
