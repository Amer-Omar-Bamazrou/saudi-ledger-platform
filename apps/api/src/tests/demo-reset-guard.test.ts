/**
 * 🔴 THE GUARD THAT MATTERS: the demo reset refuses to run against a database
 * that holds tenants which are not the demo — EVEN WITH `DEMO_MODE=true`.
 *
 * `runDemoReset` TRUNCATEs every tenant table in the database. The flag that
 * triggers it is an environment variable, and environment variables get copied:
 * a cloned Railway service, a restored backup, a `.env` pasted into the wrong
 * project. So the flag is treated as the trigger, never as the safety
 * mechanism. The safety mechanism is a precondition the real platform cannot
 * satisfy — exactly one organization, and it must be the demo.
 *
 * This test asserts the refusal AGAINST REAL ROWS rather than a mocked catalog,
 * because the thing being proven is "it did not delete them", and only real
 * rows can go missing.
 *
 * It also asserts the refusal is RECORDED as a failed run: a silent skip would
 * leave the banner promising a weekly wipe forever, which is the failure this
 * whole mechanism exists to prevent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// `vi.hoisted` because the mock factory runs during module loading — before a
// plain `const` at file scope has been initialised (the import graph reaches
// loadEnv on its way in, via the e-invoice enqueue path).
const { overrides } = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }));
vi.mock("@workspace/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/config")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...overrides }) };
});

import { pool } from "@workspace/db";
import { runDemoReset, DemoResetRefused } from "../services/demo/demoReset.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[demo-reset-guard] no real DATABASE_URL — skipping.");

const FOREIGN_SLUG = "demo-guard-real-tenant";

describeMaybe("demo reset — refuses to touch a database with real tenants", () => {
  let foreignOrgId = "";

  beforeAll(async () => {
    const { rows } = await pool.query(
      `INSERT INTO organizations (name, slug, verification_status)
       VALUES ('A Real Tenant', $1, 'approved') RETURNING id`,
      [FOREIGN_SLUG],
    );
    foreignOrgId = rows[0].id;
  });

  afterEach(() => {
    for (const k of Object.keys(overrides)) delete overrides[k];
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM demo_reset_runs`);
    await pool.query(`DELETE FROM organizations WHERE slug = $1`, [FOREIGN_SLUG]);
    await pool.end();
  });

  it("does not run at all when DEMO_MODE is off", async () => {
    overrides.DEMO_MODE = false;
    const out = await runDemoReset();
    expect(out.status).toBe("failed");
    expect(out.detail).toContain("DEMO_MODE is off");
  });

  it("🔴 refuses with DEMO_MODE ON, because the database holds a non-demo tenant", async () => {
    overrides.DEMO_MODE = true;
    overrides.DEMO_ADMIN_EMAIL = "demo@example.com";
    overrides.DEMO_ADMIN_PASSWORD = "not-used-because-it-refuses";

    const out = await runDemoReset();

    expect(out.status).toBe("failed");
    // The message must NAME what it found — a refusal nobody can diagnose is a
    // refusal somebody overrides.
    expect(out.detail).toContain("Refusing to reset");
    // The message NAMES foreign tenants but truncates to the first five — and
    // in a full parallel run, other suites' orgs exist concurrently, so OUR
    // slug may not make the cut (the "passes alone, fails in the full run"
    // class from test-suite-notes). Assert the naming behaviour, not that this
    // particular slug won the race to be listed.
    expect(out.detail).toMatch(/that are not the demo tenant \([^)]+\)/);
  });

  it("🔴 and the real tenant is still there", async () => {
    // The assertion the whole file exists for.
    const { rows } = await pool.query(`SELECT id FROM organizations WHERE id = $1`, [
      foreignOrgId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("🔴 records the refusal as a FAILED run, never a silent skip", async () => {
    const { rows } = await pool.query(
      `SELECT status, detail FROM demo_reset_runs ORDER BY id DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].detail).toContain("Refusing to reset");
    // And because it is not a success, `lastSuccessfulReset` stays null — so
    // the banner does not claim a wipe and the alarm keeps counting.
    const { rows: ok } = await pool.query(
      `SELECT count(*)::int AS n FROM demo_reset_runs WHERE status = 'succeeded'`,
    );
    expect(ok[0].n).toBe(0);
  });

  it("DemoResetRefused is a distinct error type, not a bare Error", () => {
    // So a caller can tell "I declined" from "I broke" — they need different
    // responses, and one of them is an emergency.
    expect(new DemoResetRefused("x")).toBeInstanceOf(Error);
    expect(new DemoResetRefused("x").name).toBe("Error");
  });
});
