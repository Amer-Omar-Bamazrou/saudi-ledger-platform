/**
 * 🔴 Phase 19B S0 (D10, owner 2026-11-21) — THE API REFUSES TO START WHILE THE `permissions` TABLE DIFFERS FROM
 * `PERMISSION_MATRIX`, and names each difference.
 *
 * The matrix is the one definition of the grants; the table is what this process's cache (lib/rbac.ts) and the
 * database's posting checks both read. A process that started on a drifted table would enforce grants nobody
 * reviewed — or lack grants the release needs — and the posting checks would agree with it, not with the matrix.
 *
 * It NEVER inserts or deletes: the only fix is the explicit reconcile command
 * (`pnpm --filter @workspace/db run permissions:reconcile`, docs/product/permissions-reconcile-runbook.md).
 * Called from index.ts before the server listens.
 */
import { describeDrift, hasDrift, readPermissionDrift, type PermissionDrift } from "@workspace/db";

type Q = Parameters<typeof readPermissionDrift>[0];

export class PermissionDriftError extends Error {
  constructor(readonly drift: PermissionDrift, readonly database: string) {
    super(
      `The permissions table in database '${database}' differs from PERMISSION_MATRIX (${drift.missing.length} missing, ${drift.extra.length} extra). ` +
        `The API does not start until they agree. Run \`pnpm --filter @workspace/db run permissions:reconcile --env <environment>\` ` +
        `(a dry run) and follow docs/product/permissions-reconcile-runbook.md.\n  ${describeDrift(drift).join("\n  ")}`,
    );
    this.name = "PermissionDriftError";
  }
}

/** Throws `PermissionDriftError` naming every difference; returns when the table and the matrix agree. */
export async function assertPermissionsMatchMatrix(q: Q): Promise<void> {
  const database = (await q.query("SELECT current_database() AS d")).rows[0].d as string;
  const drift = await readPermissionDrift(q);
  if (hasDrift(drift)) throw new PermissionDriftError(drift, database);
}
