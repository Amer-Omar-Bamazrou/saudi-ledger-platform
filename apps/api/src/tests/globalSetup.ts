/**
 * 🔴 19B S0 (owner, 2026-11-22): THE API SUITES RUN AGAINST THE PRODUCTION MATRIX, OR NOT AT ALL.
 *
 * CI's test job used to migrate without seeding, so the `permissions` table held only the 50 grants the seven pinned
 * grant-writing migrations insert, until one of the seven suites that call `seedPermissions()` happened to fill it.
 * A test's answer then depended on which suite ran first: measured 2026-11-22 (evidence `ci-reconcile/`), 17 tests in 3
 * suites failed on the migrated-only table — the database's approver count read no roles, so bookkeepers' cash, tax and
 * equity postings were not refused, and an admin was refused creates — and passed on the matrix. The job now
 * reconciles after migrating (ci.yml); this check is what keeps it so.
 *
 * Before any suite starts, the table must equal `PERMISSION_MATRIX` — the same check, by the same function, that
 * refuses to start the API (lib/permissionStartupCheck.ts). A drifted table fails the run here, naming every
 * difference and the command that fixes it. It never inserts or deletes.
 *
 * A DB-free run (the placeholder URL in vitest.config.ts) has no table to check and is not refused.
 */
import { assertPermissionsMatchMatrix } from "../lib/permissionStartupCheck";

export function isPlaceholderDatabase(url: string | undefined): boolean {
  return !url || url.includes("placeholder");
}

export default async function setup(): Promise<void> {
  if (isPlaceholderDatabase(process.env.DATABASE_URL)) return;
  // This process only checks; the suites run in their own workers with their own pools.
  const { pool } = await import("@workspace/db");
  try {
    await assertPermissionsMatchMatrix(pool);
  } finally {
    await pool.end();
  }
}
