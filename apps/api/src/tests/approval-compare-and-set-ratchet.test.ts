/**
 * 🔴 G08 residuals, PR A — THE COMPARE-AND-SET RATCHET.
 *
 * Every adapter the approval engine drives must declare `compareAndSet: true`
 * (its writes apply only from the state the engine checked, and a write that
 * matched nothing throws `TransitionNotApplied`), or be named below. The list
 * may only SHRINK: an adapter converted later leaves it in the same commit, and
 * a NEW adapter that is not on compare-and-set fails this test. Both directions
 * are asserted, so the list cannot hold a name that is already converted, nor
 * miss one that is not.
 *
 * RESIDUAL RISK of the adapters not yet converted (owner decision 2026-10-18:
 * out of PR A, risk documented, not tested):
 *  - budgetVersionApprovable, taxComputationVersionApprovable — their services
 *    already take row locks; the Phase 18 (2.4) proofs forced every ordering of
 *    their transitions and found them SAFE (2026-10-21), so they stay as they are.
 *
 * quotationApprovable and purchaseOrderApprovable LEFT the list on 2026-10-21
 * (Phase 18 2.4): the proofs reproduced the check-then-act races on both, and
 * they are now on compare-and-set.
 *
 * Scans the source (not the tests) for `approvalService.<transition>(<adapter>`
 * calls and reads each adapter's own definition.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..");

const NOT_YET_ON_COMPARE_AND_SET = [
  "budgetVersionApprovable",
  "taxComputationVersionApprovable",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests" || entry.name === "generated" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("the approval engine's adapters are on compare-and-set, or named as not yet", () => {
  it("every adapter passed to approvalService either declares compareAndSet: true or is on the shrinking list — both directions", () => {
    const sources = new Map(sourceFiles(SRC).map((f) => [f, fs.readFileSync(f, "utf8")]));
    const used = new Set<string>();
    for (const text of sources.values()) {
      for (const m of text.matchAll(/approvalService\.(?:submit|sendBack|approve|reject)\(\s*([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
    }
    expect(used.size, "anti-vacuity: the scan finds the engine's adapters").toBe(8);

    const onCompareAndSet: string[] = [];
    const notOnCompareAndSet: string[] = [];
    for (const name of used) {
      const declaration = new RegExp(`export (?:function|const) ${name}\\b`);
      const file = [...sources.values()].find((t) => declaration.test(t));
      expect(file, `the definition of ${name}`).toBeDefined();
      const from = file!.slice(file!.search(declaration));
      const next = from.slice(1).search(/\nexport /);
      const own = next === -1 ? from : from.slice(0, next + 1);
      (/\bcompareAndSet:\s*true\b/.test(own) ? onCompareAndSet : notOnCompareAndSet).push(name);
    }
    expect(notOnCompareAndSet.sort(), "adapters NOT on compare-and-set — this list may only shrink").toEqual(NOT_YET_ON_COMPARE_AND_SET);
    expect(onCompareAndSet.sort()).toEqual(["billApprovable", "invoiceApprovable", "journalEntryApprovable", "payrollApprovable", "purchaseOrderApprovable", "quotationApprovable"]);
  });
});
