import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * 🔴 G71 (Phase 18, B-SMALL-4; plan D-4: "no payroll deletion outside demo
 * mode") — no code outside the tests bulk-deletes payroll unless it refuses to
 * run when DEMO_MODE is off.
 *
 * The defect: `scripts/src/demo-seed.mts` had no DEMO_MODE guard and deleted
 * EVERY payroll run of the `default` organization — not only rows it had
 * created — one autocommitted statement at a time, then failed on a table that
 * does not exist (`depreciation_entries`), leaving its earlier deletes
 * committed. It was superseded by the in-API demo seed (`services/demo`, which
 * runs only under DEMO_MODE and posts through the product), and is deleted.
 *
 * This guard keeps the shape from coming back: any raw `DELETE FROM payroll_…`
 * in the API source or the workspace scripts must sit in a file that refuses
 * outside demo mode. The product's own per-run delete (the payroll repository,
 * keyed on one run and its status, through Drizzle) is not raw SQL and is not
 * matched. A planted offender proves the scan can see one.
 */

const API_SRC = join(__dirname, "..");
const SCRIPTS_SRC = join(__dirname, "..", "..", "..", "..", "scripts", "src");
const WIPE = /DELETE\s+FROM\s+"?payroll_(runs|items)"?/i;
const DEMO_REFUSAL = /\bDEMO_MODE\b/;

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

describe("G71 — no payroll wipe outside demo mode", () => {
  it("🔴 no API or workspace-script source bulk-deletes payroll without refusing outside DEMO_MODE", () => {
    const hits = offenders([API_SRC, SCRIPTS_SRC]);
    expect(
      hits,
      "A raw `DELETE FROM payroll_runs/payroll_items` outside the tests must refuse to run when DEMO_MODE is off " +
        "(see services/demo/demoReset.service.ts). A payroll run is a posted record of what was paid; a script that " +
        "wipes them on a working database removes the record and its correction path together.",
    ).toEqual([]);
  });

  it("the scan can see an offender (a planted unguarded wipe is reported; the same text with a DEMO_MODE refusal is not)", () => {
    const plantedWipe = "await q(`DELETE FROM payroll_runs WHERE organization_id=$1`, [orgId]);";
    expect(WIPE.test(plantedWipe) && !DEMO_REFUSAL.test(plantedWipe)).toBe(true);
    const guarded = `if (!loadEnv().DEMO_MODE) throw new Error("demo only");\n${plantedWipe}`;
    expect(WIPE.test(guarded) && !DEMO_REFUSAL.test(guarded)).toBe(false);
    expect(readdirSync(SCRIPTS_SRC).length, "the scripts root resolves (the scan is not vacuous)").toBeGreaterThan(0);
  });
});
