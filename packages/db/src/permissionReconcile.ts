/**
 * 🔴 Phase 19B S0 (D10, owner 2026-11-21) — ONE AUTHORITATIVE MATRIX, RECONCILED EXPLICITLY.
 *
 * `PERMISSION_MATRIX` (./permissions.ts) is the only definition of the grants. The `permissions` table is what BOTH
 * readers read: the API's cache (apps/api/src/lib/rbac.ts) and the database's posting checks (`role_holds_grant` for
 * the three posting grants, `org_usable_approver_count`'s role set from `journal_entries` approve; migration 0155).
 *
 *   - The API REFUSES TO START while the table differs from the matrix, naming each difference
 *     (apps/api/src/lib/permissionStartupCheck.ts). It never inserts or deletes.
 *   - This module is the only way to make them agree. A DRY RUN (the default) writes nothing. APPLY runs in ONE
 *     transaction on the owner connection under an advisory lock: additions apply; REMOVALS apply only with the owner's
 *     approval for that environment and that exact set (`<environment>:<sha256 of the set>`); every run that changes
 *     something is recorded in `permission_reconciliations` with every removed row in full; then the database's posting
 *     checks must answer as the matrix does. Any failure rolls the whole run back: nothing applied, nothing recorded.
 *   - RESTORE puts back the rows a recorded run removed (an addition; recorded as its own row). It is the recovery for a
 *     deployment rolled back after a removal: the older code's startup check sees the removed grant as missing.
 *
 * Runbook: docs/product/permissions-reconcile-runbook.md. Migrations no longer write `permissions`
 * (apps/api/src/tests/permission-grant-migration-ratchet.test.ts).
 */
import { createHash } from "node:crypto";
import type { ClientBase } from "pg";
import { PERMISSION_MATRIX } from "./permissions";

/** The advisory lock every apply and restore holds for its whole transaction (`pg_advisory_xact_lock`). */
export const PERMISSION_RECONCILE_LOCK_KEY = 1_901_900_168;

type Q = Pick<ClientBase, "query">;

export interface GrantRow {
  role: string;
  resource: string;
  action: string;
}
export interface StoredGrantRow extends GrantRow {
  id: string;
}

/** `missing`: in the matrix, not in the table. `extra`: in the table, not in the matrix. Both sorted. */
export interface PermissionDrift {
  missing: GrantRow[];
  extra: StoredGrantRow[];
}

export const grantKey = (r: GrantRow): string => `${r.role}:${r.resource}:${r.action}`;
const byKey = (a: GrantRow, b: GrantRow) => (grantKey(a) < grantKey(b) ? -1 : grantKey(a) > grantKey(b) ? 1 : 0);
const plain = (r: GrantRow): GrantRow => ({ role: r.role, resource: r.resource, action: r.action });

export function diffPermissions(table: readonly StoredGrantRow[], matrix: readonly GrantRow[] = PERMISSION_MATRIX): PermissionDrift {
  const inTable = new Set(table.map(grantKey));
  const inMatrix = new Set(matrix.map(grantKey));
  const missing = [...new Map(matrix.filter((m) => !inTable.has(grantKey(m))).map((m) => [grantKey(m), plain(m)])).values()].sort(byKey);
  const extra = table.filter((t) => !inMatrix.has(grantKey(t))).map((t) => ({ id: t.id, ...plain(t) })).sort(byKey);
  return { missing, extra };
}

export const hasDrift = (d: PermissionDrift): boolean => d.missing.length > 0 || d.extra.length > 0;

/** One line per difference — what the startup refusal and the dry run print. */
export function describeDrift(d: PermissionDrift): string[] {
  return [...d.missing.map((r) => `missing (in the matrix, not in the table): ${grantKey(r)}`), ...d.extra.map((r) => `extra (in the table, not in the matrix): ${grantKey(r)}`)];
}

export async function readPermissionTable(q: Q): Promise<StoredGrantRow[]> {
  return (await q.query("SELECT id::text AS id, role, resource, action FROM permissions")).rows as StoredGrantRow[];
}

export async function readPermissionDrift(q: Q, matrix: readonly GrantRow[] = PERMISSION_MATRIX): Promise<PermissionDrift> {
  return diffPermissions(await readPermissionTable(q), matrix);
}

/** SHA-256 of the removal set: its sorted `role:resource:action` lines. What an approval binds to. */
export function removalSetHash(rows: readonly GrantRow[]): string {
  return createHash("sha256").update([...new Set(rows.map(grantKey))].sort().join("\n")).digest("hex");
}

/** The approval for removing exactly `rows` in `environment` — given by the owner after reading the dry run. */
export const removalApproval = (environment: string, rows: readonly GrantRow[]): string => `${environment}:${removalSetHash(rows)}`;

const POSTING_GRANTS = ["gl_cash_posting", "gl_tax_posting", "gl_equity_posting"] as const;
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;

/**
 * Ask the DATABASE's posting checks what they answer, and compare with the matrix: `role_holds_grant` for each posting
 * grant and role, and the role set `org_usable_approver_count` counts. Returns one line per disagreement (none = they
 * agree). The functions read the table live, so this also catches a function redefined to answer otherwise.
 */
export async function postingCheckDisagreements(q: Q, matrix: readonly GrantRow[] = PERMISSION_MATRIX): Promise<string[]> {
  const out: string[] = [];
  for (const resource of POSTING_GRANTS) {
    for (const role of ROLES) {
      const db = (await q.query("SELECT role_holds_grant($1, $2, 'approve') AS g", [role, resource])).rows[0].g === true;
      const m = matrix.some((p) => p.role === role && p.resource === resource && p.action === "approve");
      if (db !== m) out.push(`role_holds_grant(${role}, ${resource}, approve): the database answers ${db}, the matrix ${m}`);
    }
  }
  const counted = new Set<string>(
    (await q.query("SELECT p.role FROM permissions p WHERE p.resource = 'journal_entries' AND p.action = 'approve'")).rows.map((r: { role: string }) => r.role),
  );
  // the function's own definition must still read that role set (a redefinition that hard-codes roles is a disagreement)
  const def = (await q.query("SELECT pg_get_functiondef('org_usable_approver_count(uuid)'::regprocedure) AS d")).rows[0].d as string;
  if (!/resource\s*=\s*'journal_entries'\s+AND\s+p\.action\s*=\s*'approve'/i.test(def)) out.push("org_usable_approver_count no longer reads its role set from the journal_entries approve grant");
  const m = new Set(matrix.filter((p) => p.resource === "journal_entries" && p.action === "approve").map((p) => p.role));
  const a = [...counted].sort().join(","), b = [...m].sort().join(",");
  if (a !== b) out.push(`org_usable_approver_count counts the roles [${a}], the matrix approves journal entries for [${b}]`);
  return out;
}

export type ReconcileRefusalCode =
  | "environment_invalid"
  | "reconcile_in_progress"
  | "removal_needs_approval"
  | "removal_approval_mismatch"
  | "posting_checks_disagree"
  | "drift_remains"
  | "reconciliation_not_found"
  | "nothing_to_restore";

/** A refusal BY NAME. Thrown before COMMIT, so nothing of the run is applied or recorded. */
export class PermissionReconcileRefused extends Error {
  constructor(readonly code: ReconcileRefusalCode, message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "PermissionReconcileRefused";
  }
}

export interface ReconcileResult {
  kind: "dry_run" | "apply" | "restore";
  environment: string;
  database: string;
  /** Before the run (a dry run's whole answer). */
  drift: PermissionDrift;
  added: GrantRow[];
  removed: StoredGrantRow[];
  /** The hash an approval of the current removal set must carry (null when there is nothing to remove). */
  removalSetHash: string | null;
  postingCheckDisagreements: string[];
  /** Null when nothing changed (nothing is recorded then) and for a dry run. */
  reconciliationId: number | null;
  /** After the run, against the current matrix (empty after an apply; a restore can leave rows the matrix lacks). */
  driftAfter: PermissionDrift;
}

const ENV = /^[a-z0-9][a-z0-9_-]{0,40}$/;
function checkEnvironment(environment: string): void {
  if (!ENV.test(environment)) {
    throw new PermissionReconcileRefused("environment_invalid", `Name the environment (lower-case letters, digits, '-' or '_'), not '${environment}'.`);
  }
}

async function takeLock(q: Q): Promise<void> {
  const got = (await q.query("SELECT pg_try_advisory_xact_lock($1) AS ok", [PERMISSION_RECONCILE_LOCK_KEY])).rows[0].ok === true;
  if (!got) throw new PermissionReconcileRefused("reconcile_in_progress", "Another reconcile or restore is running on this database; nothing was changed. Run it again when that one has finished.");
  // no other writer of the table while this run decides (reads, including the posting checks, are not blocked)
  await q.query("LOCK TABLE permissions IN EXCLUSIVE MODE");
}

const currentDatabase = async (q: Q): Promise<string> => (await q.query("SELECT current_database() AS d")).rows[0].d as string;

/**
 * APPLY, inside a transaction the CALLER has opened on the OWNER connection (`reconcilePermissions` owns one). Refusals
 * are thrown before anything is recorded; the caller's rollback undoes whatever this had applied.
 */
export async function reconcileInTransaction(
  q: Q,
  opts: { environment: string; actor: string; approval?: string | null; matrix?: readonly GrantRow[] },
): Promise<ReconcileResult> {
  checkEnvironment(opts.environment);
  const matrix = opts.matrix ?? PERMISSION_MATRIX;
  await takeLock(q);
  const database = await currentDatabase(q);
  const drift = await readPermissionDrift(q, matrix);
  const hash = drift.extra.length ? removalSetHash(drift.extra) : null;
  if (drift.extra.length) {
    const expected = removalApproval(opts.environment, drift.extra);
    if (!opts.approval) {
      throw new PermissionReconcileRefused(
        "removal_needs_approval",
        `${drift.extra.length} grant(s) in the table are not in the matrix. Removing them needs the owner's approval for '${opts.environment}' and this exact set (sha256 ${hash}); nothing was changed.`,
        { extra: drift.extra.map(grantKey), removalSetHash: hash },
      );
    }
    if (opts.approval !== expected) {
      throw new PermissionReconcileRefused(
        "removal_approval_mismatch",
        `The approval given does not name '${opts.environment}' and the removal set now in the table (sha256 ${hash}); nothing was changed.`,
        { extra: drift.extra.map(grantKey), removalSetHash: hash },
      );
    }
  }
  const added: GrantRow[] = [];
  for (const r of drift.missing) {
    const ins = await q.query("INSERT INTO permissions (role, resource, action) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING role, resource, action", [r.role, r.resource, r.action]);
    added.push(...(ins.rows as GrantRow[]));
  }
  const removed: StoredGrantRow[] = [];
  for (const r of drift.extra) {
    const del = await q.query("DELETE FROM permissions WHERE id = $1::uuid RETURNING id::text AS id, role, resource, action", [r.id]);
    removed.push(...(del.rows as StoredGrantRow[]));
  }
  const driftAfter = await readPermissionDrift(q, matrix);
  if (hasDrift(driftAfter)) {
    throw new PermissionReconcileRefused("drift_remains", `The table still differs from the matrix after the run; nothing was changed.\n  ${describeDrift(driftAfter).join("\n  ")}`);
  }
  const disagreements = await postingCheckDisagreements(q, matrix);
  if (disagreements.length) {
    throw new PermissionReconcileRefused("posting_checks_disagree", `The database's posting checks do not answer as the matrix does; nothing was changed.\n  ${disagreements.join("\n  ")}`, { disagreements });
  }
  let reconciliationId: number | null = null;
  if (added.length || removed.length) {
    reconciliationId = (
      await q.query(
        `INSERT INTO permission_reconciliations (kind, environment, database_name, actor, added, removed, removal_set_hash, approval, matrix_rows)
         VALUES ('apply', $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8) RETURNING id`,
        [opts.environment, database, opts.actor, JSON.stringify(added.sort(byKey)), JSON.stringify(removed.sort(byKey)), removed.length ? hash : null, removed.length ? opts.approval : null, matrix.length],
      )
    ).rows[0].id as number;
  }
  return { kind: "apply", environment: opts.environment, database, drift, added, removed, removalSetHash: hash, postingCheckDisagreements: [], reconciliationId, driftAfter };
}

/** RESTORE the rows recorded run `reconciliationId` removed, inside the caller's transaction. An addition. */
export async function restoreInTransaction(
  q: Q,
  opts: { environment: string; actor: string; reconciliationId: number; matrix?: readonly GrantRow[] },
): Promise<ReconcileResult> {
  checkEnvironment(opts.environment);
  const matrix = opts.matrix ?? PERMISSION_MATRIX;
  await takeLock(q);
  const database = await currentDatabase(q);
  const drift = await readPermissionDrift(q, matrix);
  const rec = (await q.query("SELECT id, kind, removed FROM permission_reconciliations WHERE id = $1", [opts.reconciliationId])).rows[0] as
    | { id: number; kind: string; removed: StoredGrantRow[] }
    | undefined;
  if (!rec) throw new PermissionReconcileRefused("reconciliation_not_found", `No reconciliation ${opts.reconciliationId} is recorded on this database; nothing was changed.`);
  const added: GrantRow[] = [];
  for (const r of rec.removed) {
    const ins = await q.query("INSERT INTO permissions (role, resource, action) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING role, resource, action", [r.role, r.resource, r.action]);
    added.push(...(ins.rows as GrantRow[]));
  }
  if (!added.length) {
    throw new PermissionReconcileRefused("nothing_to_restore", `Every grant reconciliation ${opts.reconciliationId} removed is already in the table; nothing was changed.`, { removed: rec.removed.map(grantKey) });
  }
  const reconciliationId = (
    await q.query(
      `INSERT INTO permission_reconciliations (kind, environment, database_name, actor, added, removed, restores_id, matrix_rows)
       VALUES ('restore', $1, $2, $3, $4::jsonb, '[]'::jsonb, $5, $6) RETURNING id`,
      [opts.environment, database, opts.actor, JSON.stringify(added.sort(byKey)), rec.id, matrix.length],
    )
  ).rows[0].id as number;
  return { kind: "restore", environment: opts.environment, database, drift, added, removed: [], removalSetHash: null, postingCheckDisagreements: [], reconciliationId, driftAfter: await readPermissionDrift(q, matrix) };
}

/**
 * Statement names for the transaction a run owns. `nested` runs it as a SAVEPOINT inside a transaction the caller holds
 * (the tests' rolled-back transactions); the rollback-whole behaviour is the same either way.
 */
const txn = (nested: boolean) =>
  nested
    ? { begin: "SAVEPOINT permission_reconcile", commit: "RELEASE SAVEPOINT permission_reconcile", rollback: "ROLLBACK TO SAVEPOINT permission_reconcile" }
    : { begin: "BEGIN", commit: "COMMIT", rollback: "ROLLBACK" };

/** The command's entry: a DRY RUN by default (writes nothing); `apply` reconciles in one transaction, all or nothing. */
export async function reconcilePermissions(
  client: ClientBase,
  opts: { environment: string; actor: string; apply?: boolean; approval?: string | null; nested?: boolean; matrix?: readonly GrantRow[] },
): Promise<ReconcileResult> {
  checkEnvironment(opts.environment);
  const matrix = opts.matrix ?? PERMISSION_MATRIX;
  const t = txn(opts.nested === true);
  if (!opts.apply) {
    await client.query(opts.nested ? t.begin : "BEGIN READ ONLY");
    try {
      const database = await currentDatabase(client);
      const drift = await readPermissionDrift(client, matrix);
      const postingCheck = await postingCheckDisagreements(client, matrix);
      return { kind: "dry_run", environment: opts.environment, database, drift, added: [], removed: [], removalSetHash: drift.extra.length ? removalSetHash(drift.extra) : null, postingCheckDisagreements: postingCheck, reconciliationId: null, driftAfter: drift };
    } finally {
      await client.query(t.rollback);
      if (opts.nested) await client.query("RELEASE SAVEPOINT permission_reconcile");
    }
  }
  await client.query(t.begin);
  try {
    const result = await reconcileInTransaction(client, { ...opts, matrix });
    await client.query(t.commit);
    return result;
  } catch (err) {
    await client.query(t.rollback);
    if (opts.nested) await client.query("RELEASE SAVEPOINT permission_reconcile");
    throw err;
  }
}

/** RESTORE in its own transaction, all or nothing. */
export async function restorePermissions(
  client: ClientBase,
  opts: { environment: string; actor: string; reconciliationId: number; nested?: boolean; matrix?: readonly GrantRow[] },
): Promise<ReconcileResult> {
  const t = txn(opts.nested === true);
  await client.query(t.begin);
  try {
    const result = await restoreInTransaction(client, opts);
    await client.query(t.commit);
    return result;
  } catch (err) {
    await client.query(t.rollback);
    if (opts.nested) await client.query("RELEASE SAVEPOINT permission_reconcile");
    throw err;
  }
}
