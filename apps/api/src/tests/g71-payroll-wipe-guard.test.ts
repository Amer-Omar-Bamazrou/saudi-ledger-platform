import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, sep } from "node:path";

/**
 * 🔴 G71 (Phase 18, B-SMALL-4; owner decision 2026-10-21: the script is KEPT
 * and guarded) — the demo-seed script refuses to run unless `DEMO_MODE=1` is
 * set, and its payroll wipe is limited to the payroll it created itself.
 *
 * The defect: `scripts/src/demo-seed.mts` had no DEMO_MODE guard and deleted
 * EVERY payroll run of the `default` organization — not only rows it had
 * created — one autocommitted statement at a time.
 *
 * Proved three ways:
 *   1. BEHAVIOUR: run without `DEMO_MODE=1` against an unreachable database,
 *      the script refuses with its own sentence and never tries to connect;
 *      with `DEMO_MODE=1` the same run gets past the guard and fails on the
 *      connection — so the guard, nothing else, is what stopped it.
 *   2. SHAPE: the refusal is the first statement of `main()`; every payroll
 *      DELETE in the script is keyed on the id list of its own demo runs
 *      (draft, every item a `DEMO-` employee), never on the organization alone.
 *   3. EVERYWHERE ELSE: no API or workspace-script source has a raw payroll
 *      DELETE outside a file that refuses outside demo mode (a planted
 *      offender proves the scan can see one).
 */

const REPO = join(__dirname, "..", "..", "..", "..");
const API_SRC = join(REPO, "apps", "api", "src");
const SCRIPTS_SRC = join(REPO, "scripts", "src");
const SCRIPT = join(SCRIPTS_SRC, "demo-seed.mts");
const WIPE = /DELETE\s+FROM\s+"?payroll_(runs|items)"?/i;
const DEMO_REFUSAL = /\bDEMO_MODE\b/;
const REFUSAL_SENTENCE = "demo-seed refuses to run: DEMO_MODE=1 is not set.";
const UNREACHABLE = "postgresql://g71-guard@127.0.0.1:1/none";

/** Run the script under tsx with the given DEMO_MODE, against a database that cannot be reached. */
function runScript(demoMode: string | undefined) {
  const tsxCli = join(createRequire(join(REPO, "scripts", "package.json")).resolve("tsx/package.json"), "..", "dist", "cli.mjs");
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: UNREACHABLE };
  delete env.DEMO_MODE;
  if (demoMode !== undefined) env.DEMO_MODE = demoMode;
  const r = spawnSync(process.execPath, [tsxCli, SCRIPT], { cwd: join(REPO, "scripts"), env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function offenders(roots: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules" && entry !== "dist") walk(full);
        continue;
      }
      if (!/\.(ts|mts|mjs|js)$/.test(entry)) continue;
      if (full.includes(`${sep}tests${sep}`) || full.includes(`${sep}__tests__${sep}`)) continue; // fixtures clean up on purpose
      const src = readFileSync(full, "utf8");
      if (WIPE.test(src) && !DEMO_REFUSAL.test(src)) found.push(full);
    }
  };
  for (const r of roots) walk(r);
  return found;
}

describe("G71 — the demo-seed script runs only in demo mode, and wipes only its own payroll", () => {
  it("🔴 BEHAVIOUR: without DEMO_MODE=1 (unset, or 'true') it refuses before any query; with DEMO_MODE=1 it gets past the guard (and fails on the unreachable database)", () => {
    for (const mode of [undefined, "true", "0"]) {
      const r = runScript(mode);
      expect(r.status, `DEMO_MODE=${mode}: ${r.out}`).not.toBe(0);
      expect(r.out, `DEMO_MODE=${mode}`).toContain(REFUSAL_SENTENCE);
      expect(r.out, `DEMO_MODE=${mode}: no connection was attempted`).not.toMatch(/ECONNREFUSED|connect/i);
    }
    const allowed = runScript("1");
    expect(allowed.status).not.toBe(0);
    expect(allowed.out, "movement: the guard let it through").not.toContain(REFUSAL_SENTENCE);
    expect(allowed.out, "it then tried the database").toMatch(/ECONNREFUSED|connect/i);
  }, 120_000);

  it("🔴 SHAPE: the refusal is main()'s first statement, and every payroll DELETE is keyed on the script's own demo-run ids", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const body = src.slice(src.indexOf("async function main()"));
    expect(body.indexOf("refuseOutsideDemoMode();"), "the guard is called in main()").toBeGreaterThan(-1);
    expect(body.indexOf("refuseOutsideDemoMode();"), "before the first query").toBeLessThan(body.indexOf("pool.query("));
    expect(src).toContain('process.env.DEMO_MODE !== "1"');
    const deletes = src.match(/DELETE\s+FROM\s+payroll_(runs|items)[^`]*/gi) ?? [];
    expect(deletes.length, "anti-vacuity: the script does delete payroll").toBe(2);
    for (const d of deletes) expect(d, d).toMatch(/= ANY\(\$1::int\[\]\)/);
    expect(src).toMatch(/r\.status='draft'/);
    expect(src).toMatch(/employee_number NOT LIKE \$2/);
  });

  it("no other API or workspace-script source bulk-deletes payroll without refusing outside DEMO_MODE (the scan sees a planted offender)", () => {
    expect(offenders([API_SRC, SCRIPTS_SRC])).toEqual([]);
    const planted = "await q(`DELETE FROM payroll_runs WHERE organization_id=$1`, [orgId]);";
    expect(WIPE.test(planted) && !DEMO_REFUSAL.test(planted)).toBe(true);
    expect(readdirSync(SCRIPTS_SRC).length, "the scripts root resolves").toBeGreaterThan(0);
  });
});
