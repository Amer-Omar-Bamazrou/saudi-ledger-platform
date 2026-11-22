/**
 * 🔴 19B S0 (owner, 2026-11-22): "Make the test job apply the reconcile's additions after migrating, so the suites run
 * against the production matrix."
 *
 * Two facts keep it so, and this file pins both:
 *  1. CI's `test` job runs `permissions:reconcile --apply` after `migrate` and before any suite — additions only (no
 *     `--approve-removals`), and never `continue-on-error`, so a refusal fails the job.
 *  2. The API suites' global setup refuses to start while the table differs from the matrix, by the API's own
 *     startup function — so a job that skipped (1) fails loudly instead of testing a drifted table.
 * The behaviour of (2) is the startup check's, proven in permission-startup-check.test.ts; it was shown red on a
 * migrated-only database and green on a reconciled one (evidence `ci-reconcile/`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const ci = readFileSync(`${root}.github/workflows/ci.yml`, "utf8").replace(/\r\n/g, "\n");

/** The step lines (`- name:` / `- run:` / `run:`) of one job, in order. */
function jobBlock(job: string): string {
  const start = ci.indexOf(`\n  ${job}:\n`);
  expect(start, `job '${job}' in ci.yml`).toBeGreaterThan(-1);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function stepIndex(block: string, pattern: RegExp): number {
  const steps = block.split(/\n      - /);
  return steps.findIndex((s) => pattern.test(s));
}

describe("CI's test job runs the suites against PERMISSION_MATRIX (19B S0)", () => {
  const test = jobBlock("test");

  it("🔴 reconciles after migrating and before the first suite", () => {
    const migrate = stepIndex(test, /run: pnpm --filter @workspace\/db run migrate\b/);
    const reconcile = stepIndex(test, /run: pnpm --filter @workspace\/db run permissions:reconcile\b/);
    const firstSuite = stepIndex(test, /run: pnpm --filter @workspace\/api-server run test\b/);
    expect(migrate, "the migrate step").toBeGreaterThan(0);
    expect(reconcile, "the reconcile step").toBeGreaterThan(migrate);
    expect(firstSuite, "the API suites").toBeGreaterThan(reconcile);
  });

  it("🔴 applies additions only, and a refusal fails the job", () => {
    const steps = test.split(/\n      - /);
    const step = steps.find((s) => /permissions:reconcile/.test(s)) ?? "";
    expect(step).toMatch(/--apply\b/);
    expect(step).toMatch(/--env [a-z0-9_-]+/);
    expect(step, "a removal needs the owner's approval — never in CI").not.toMatch(/--approve-removals/);
    expect(step, "a refused reconcile must fail the job").not.toMatch(/continue-on-error/);
  });

  it("🔴 the suites' global setup is the API's startup check", () => {
    const config = readFileSync(`${root}apps/api/vitest.config.ts`, "utf8");
    expect(config).toMatch(/globalSetup:\s*\[\s*"src\/tests\/globalSetup\.ts"\s*\]/);
    const setup = readFileSync(`${root}apps/api/src/tests/globalSetup.ts`, "utf8");
    expect(setup).toMatch(/import \{ assertPermissionsMatchMatrix \} from "\.\.\/lib\/permissionStartupCheck"/);
    expect(setup).toMatch(/await assertPermissionsMatchMatrix\(pool\)/);
  });
});
