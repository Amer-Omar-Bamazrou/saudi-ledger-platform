import { defineConfig, devices } from "@playwright/test";

/**
 * P5 — BROWSER TESTS IN CI.
 *
 * ── 🔴 WHY THIS EXISTS ─────────────────────────────────────────────────────
 * Every other test in this repo runs a layer BELOW the one that breaks. The
 * scoreboard, from CLAUDE.md §5:
 *
 *   found by a browser : the blank AP-aging page, swallowed server refusals,
 *                        the GL showing SAR 0.00, an uneditable bill, AUD-13's
 *                        issued zero-value tax invoice, a statement link that
 *                        dropped the customer it was opened from
 *   found by 1,179 tests : none of them
 *
 * The suite calls services with hand-built objects, so a client that builds a
 * request differently is invisible to it BY CONSTRUCTION. Only something that
 * drives the real client closes that.
 *
 * ── 🔴 RETRIES ARE ZERO, DELIBERATELY ──────────────────────────────────────
 * This is the decision that determines whether P5 is worth having. A suite
 * people learn to re-run is a guard REPORTING COVERAGE IT DOES NOT HAVE — the
 * exact failure this project keeps finding elsewhere, imported into the tool
 * built to prevent it. `retries: 2` would make that failure invisible: the
 * second pass goes green, nobody reads the first, and the suite's real signal
 * quietly becomes "it passed at least once in three".
 *
 * So a flake here is a DEFECT to fix, not a cost to absorb. What pays for that
 * strictness is determinism, bought four ways:
 *
 *   1. ONE worker. The app has one database and one tenant; parallel workers
 *      would race each other through it. `docs/test-suite-notes.md` already
 *      records this class — API flakes that were cross-fork collisions.
 *   2. Seeded data created once, in global setup, under a slug owned by this
 *      suite alone.
 *   3. No `waitForTimeout` anywhere. Playwright's auto-waiting asserts on the
 *      condition; a sleep asserts on the machine's mood.
 *   4. Both servers started by Playwright and waited for on a real health
 *      check, so "the page failed" can never mean "the server was not up yet".
 *
 * If a test here becomes flaky, the honest responses are to fix the race or
 * delete the test. Raising `retries` is neither.
 */

const WEB_PORT = 5173;
const API_PORT = 3000;

export default defineConfig({
  testDir: "./e2e",

  /** See the note above. Not a placeholder — a decision. */
  retries: 0,
  workers: 1,
  fullyParallel: false,

  /* A crawl of 60 routes should take seconds; a minute means something hung. */
  timeout: 30_000,
  expect: { timeout: 10_000 },

  /* CI must never sit on an interactive prompt, and `test.only` must not
     silently shrink the suite to one test on a pushed branch. */
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    /* Diagnosis without retries: keep everything from a failure, once. */
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  globalSetup: "./e2e/global-setup.ts",

  /**
   * Both servers, started here rather than in CI shell steps, so local and CI
   * runs are the same run. `reuseExistingServer` locally means a dev server
   * already up is used as-is; in CI it is always a fresh boot.
   */
  webServer: [
    {
      command: "pnpm --filter @workspace/api-server run dev",
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @workspace/bookkeeping run dev",
      url: `http://localhost:${WEB_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
