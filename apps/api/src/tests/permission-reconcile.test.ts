import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PERMISSION_MATRIX,
  pool,
  PERMISSION_RECONCILE_LOCK_KEY,
  PermissionReconcileRefused,
  grantKey,
  postingCheckDisagreements,
  readPermissionDrift,
  reconcilePermissions,
  removalApproval,
  removalSetHash,
  restorePermissions,
} from "@workspace/db";

/**
 * 🔴 Phase 19B S0 (D10, owner 2026-11-21) — the reconcile command, against a real database.
 *
 * The `permissions` table is global and shared with every other suite (and this suite runs beside them, in parallel), so each case runs inside ONE transaction that
 * is rolled back: it first sets the table to exactly the matrix (CI's test database is migrated but not seeded, so its
 * table is NOT the matrix), plants a known difference, and runs the command NESTED (a savepoint inside that
 * transaction — the same rollback-whole code path as the command's own transaction). Nothing here is committed except
 * by the two cases that refuse before writing.
 */
const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
const ENV = "s0-test";
const ACTOR = "permission-reconcile.test";
/** A pooled connection (the pg client type, as the command takes it, plus release). */
type Client = Parameters<typeof reconcilePermissions>[0] & { release(): void };

describeMaybe("permissions:reconcile — dry run, approval for removals, one transaction, record, restore, posting checks", () => {
  let c: Client;
  let other: Client;

  const tableKeys = async (q: Client = c) => ((await q.query("SELECT role, resource, action FROM permissions")).rows as Array<{ role: string; resource: string; action: string }>).map(grantKey).sort();
  const records = async (q: Client = c) => Number((await q.query("SELECT count(*) AS n FROM permission_reconciliations")).rows[0].n);
  const matrixKeys = [...new Set(PERMISSION_MATRIX.map(grantKey))].sort();
  /** Inside the open transaction: the table becomes exactly the matrix. */
  async function setTableToMatrix() {
    await c.query("DELETE FROM permissions");
    for (const p of PERMISSION_MATRIX) await c.query("INSERT INTO permissions (role, resource, action) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [p.role, p.resource, p.action]);
  }
  const remove = (key: string) => { const [role, resource, action] = key.split(":"); return c.query("DELETE FROM permissions WHERE role = $1 AND resource = $2 AND action = $3", [role, resource, action]); };
  const plantExtra = async (key: string) => { const [role, resource, action] = key.split(":"); return (await c.query("INSERT INTO permissions (role, resource, action) VALUES ($1, $2, $3) RETURNING id::text AS id", [role, resource, action])).rows[0].id as string; };
  async function refusal(p: Promise<unknown>) {
    try { await p; } catch (e) { if (e instanceof PermissionReconcileRefused) return e; throw e; }
    throw new Error("expected a refusal by name");
  }

  const MISSING_A = "viewer:invoices:read";
  const MISSING_B = "accountant:gl_cash_posting:approve";
  const EXTRA = "viewer:invoices:approve";

  beforeAll(async () => {
    c = await pool.connect();
    other = await pool.connect();
    // the planted keys are what the cases claim they are
    expect(matrixKeys).toContain(MISSING_A);
    expect(matrixKeys).toContain(MISSING_B);
    expect(matrixKeys).not.toContain(EXTRA);
  });
  afterAll(async () => { c?.release(); other?.release(); });
  // 🔴 the table lock FIRST, before this transaction writes anything — as the command itself takes it before its writes.
  // A parallel suite seeding the table then waits for this short transaction; taken after a write, it can deadlock.
  beforeEach(async () => { await c.query("BEGIN"); await c.query("LOCK TABLE permissions IN EXCLUSIVE MODE"); await setTableToMatrix(); });
  afterEach(async () => { await c.query("ROLLBACK"); });

  it("🔴 a DRY RUN lists the difference both ways and writes nothing", async () => {
    await remove(MISSING_A);
    const extraId = await plantExtra(EXTRA);
    const before = { keys: await tableKeys(), records: await records() };
    const r = await reconcilePermissions(c, { environment: ENV, actor: ACTOR, nested: true });
    expect(r.kind).toBe("dry_run");
    expect(r.drift.missing.map(grantKey)).toEqual([MISSING_A]);
    expect(r.drift.extra.map((e) => ({ id: e.id, key: grantKey(e) }))).toEqual([{ id: extraId, key: EXTRA }]);
    expect(r.removalSetHash).toBe(removalSetHash([{ role: "viewer", resource: "invoices", action: "approve" }]));
    expect({ keys: await tableKeys(), records: await records() }, "a dry run writes nothing").toEqual(before);
  });

  it("🔴 ADDITIONS apply without an approval, are recorded, and leave the table equal to the matrix", async () => {
    await remove(MISSING_A); await remove(MISSING_B);
    const before = await records();
    const r = await reconcilePermissions(c, { environment: ENV, actor: ACTOR, apply: true, nested: true });
    expect(r.added.map(grantKey).sort()).toEqual([MISSING_B, MISSING_A].sort());
    expect(r.removed).toEqual([]);
    expect(await tableKeys()).toEqual(matrixKeys);
    expect(await records()).toBe(before + 1);
    const rec = (await c.query("SELECT kind, environment, actor, added, removed, approval, removal_set_hash, matrix_rows FROM permission_reconciliations WHERE id = $1", [r.reconciliationId])).rows[0];
    expect(rec).toMatchObject({ kind: "apply", environment: ENV, actor: ACTOR, removed: [], approval: null, removal_set_hash: null, matrix_rows: PERMISSION_MATRIX.length });
    expect((rec.added as Array<{ role: string; resource: string; action: string }>).map(grantKey).sort()).toEqual([MISSING_B, MISSING_A].sort());
  });

  it("🔴 a REMOVAL without the owner's approval is refused by name, and NOTHING of the run applies (not even its additions)", async () => {
    await remove(MISSING_A);
    await plantExtra(EXTRA);
    const before = { keys: await tableKeys(), records: await records() };
    const e = await refusal(reconcilePermissions(c, { environment: ENV, actor: ACTOR, apply: true, nested: true }));
    expect(e.code).toBe("removal_needs_approval");
    expect(e.detail.extra).toEqual([EXTRA]);
    expect({ keys: await tableKeys(), records: await records() }).toEqual(before);
  });

  it("🔴 an approval for ANOTHER environment, or for ANOTHER removal set, is refused; nothing applies", async () => {
    await plantExtra(EXTRA);
    const before = { keys: await tableKeys(), records: await records() };
    const set = [{ role: "viewer", resource: "invoices", action: "approve" }];
    const otherEnv = await refusal(reconcilePermissions(c, { environment: ENV, actor: ACTOR, apply: true, nested: true, approval: removalApproval("production", set) }));
    expect(otherEnv.code).toBe("removal_approval_mismatch");
    const otherSet = await refusal(reconcilePermissions(c, { environment: ENV, actor: ACTOR, apply: true, nested: true, approval: removalApproval(ENV, [{ role: "viewer", resource: "bills", action: "approve" }]) }));
    expect(otherSet.code).toBe("removal_approval_mismatch");
    expect({ keys: await tableKeys(), records: await records() }).toEqual(before);
  });

  it("🔴 an APPROVED removal applies and is recorded IN FULL; RESTORE puts it back and is recorded as its own row", async () => {
    await remove(MISSING_A);
    const extraId = await plantExtra(EXTRA);
    const set = [{ role: "viewer", resource: "invoices", action: "approve" }];
    const r = await reconcilePermissions(c, { environment: ENV, actor: ACTOR, apply: true, nested: true, approval: removalApproval(ENV, set) });
    expect(r.added.map(grantKey)).toEqual([MISSING_A]);
    expect(r.removed).toEqual([{ id: extraId, role: "viewer", resource: "invoices", action: "approve" }]);
    expect(await tableKeys()).toEqual(matrixKeys);
    const rec = (await c.query("SELECT removed, removal_set_hash, approval FROM permission_reconciliations WHERE id = $1", [r.reconciliationId])).rows[0];
    expect(rec).toEqual({ removed: [{ id: extraId, role: "viewer", resource: "invoices", action: "approve" }], removal_set_hash: removalSetHash(set), approval: removalApproval(ENV, set) });

    const back = await restorePermissions(c, { environment: ENV, actor: ACTOR, reconciliationId: r.reconciliationId!, nested: true });
    expect(back.added.map(grantKey)).toEqual([EXTRA]);
    expect(await tableKeys(), "the removed grant is back").toContain(EXTRA);
    expect(back.driftAfter.extra.map(grantKey), "…and, the matrix lacking it, it reads as extra again").toEqual([EXTRA]);
    const restoreRec = (await c.query("SELECT kind, restores_id, added FROM permission_reconciliations WHERE id = $1", [back.reconciliationId])).rows[0];
    expect(restoreRec).toMatchObject({ kind: "restore", restores_id: r.reconciliationId });
    // restoring twice finds nothing to put back
    expect((await refusal(restorePermissions(c, { environment: ENV, actor: ACTOR, reconciliationId: r.reconciliationId!, nested: true }))).code).toBe("nothing_to_restore");
  });

  it("🔴 a run that FAILS PART-WAY rolls back WHOLE: its additions and approved removal are undone and nothing is recorded", async () => {
    await remove(MISSING_A);
    await plantExtra(EXTRA);
    // the failure, planted after the writes: the database's posting check answers otherwise than the matrix
    await c.query(`CREATE OR REPLACE FUNCTION role_holds_grant(member_role text, res text, act text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$`);
    const before = { keys: await tableKeys(), records: await records() };
    const set = [{ role: "viewer", resource: "invoices", action: "approve" }];
    const e = await refusal(reconcilePermissions(c, { environment: ENV, actor: ACTOR, apply: true, nested: true, approval: removalApproval(ENV, set) }));
    expect(e.code).toBe("posting_checks_disagree");
    expect(e.message).toContain("role_holds_grant(admin, gl_cash_posting, approve): the database answers false, the matrix true");
    expect({ keys: await tableKeys(), records: await records() }, "the planted difference is exactly as it was").toEqual(before);
    expect(before.keys).not.toContain(MISSING_A);
    expect(before.keys).toContain(EXTRA);
  });

  it("🔴 the run holds the advisory lock; a second run while one holds it is refused by name and writes nothing", async () => {
    await remove(MISSING_A);
    await reconcilePermissions(c, { environment: ENV, actor: ACTOR, apply: true, nested: true });
    // c's transaction now holds the lock: another connection cannot take it
    expect((await other.query("SELECT pg_try_advisory_xact_lock($1) AS ok", [PERMISSION_RECONCILE_LOCK_KEY])).rows[0].ok).toBe(false);
    // and a whole run on that other connection is refused (it refuses before writing anything)
    const before = await records(other);
    const e = await refusal(reconcilePermissions(other, { environment: ENV, actor: ACTOR, apply: true }));
    expect(e.code).toBe("reconcile_in_progress");
    expect(await records(other)).toBe(before);
  });

  it("🔴 the POSTING-CHECK comparison sees a disagreement (presence), none on the matrix (absence), and the approver role set move", async () => {
    expect(await postingCheckDisagreements(c), "the table is the matrix").toEqual([]);
    await remove("accountant:gl_tax_posting:approve");
    expect(await postingCheckDisagreements(c)).toEqual(["role_holds_grant(accountant, gl_tax_posting, approve): the database answers false, the matrix true"]);
    await remove("accountant:journal_entries:approve");
    expect((await postingCheckDisagreements(c)).at(-1)).toBe("org_usable_approver_count counts the roles [admin], the matrix approves journal entries for [accountant,admin]");
    expect((await readPermissionDrift(c)).missing.map(grantKey)).toEqual(["accountant:gl_tax_posting:approve", "accountant:journal_entries:approve"]);
  });

  it("🔴 the record is APPEND-ONLY (the owner included) and the application's roles hold nothing on it", async () => {
    await remove(MISSING_A);
    const r = await reconcilePermissions(c, { environment: ENV, actor: ACTOR, apply: true, nested: true });
    for (const sql of [`UPDATE permission_reconciliations SET actor = 'someone else' WHERE id = ${r.reconciliationId}`, `DELETE FROM permission_reconciliations WHERE id = ${r.reconciliationId}`, "TRUNCATE permission_reconciliations"]) {
      await c.query("SAVEPOINT s");
      await expect(c.query(sql), sql).rejects.toThrow(/append-only/);
      await c.query("ROLLBACK TO SAVEPOINT s");
    }
    const grants = (await c.query(`SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'permission_reconciliations' AND grantee IN ('authenticated', 'anon', 'service_role', 'PUBLIC')`)).rows;
    expect(grants).toEqual([]);
  });
});

describeMaybe("permissions:reconcile — the command itself", () => {
  const dbDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "db");
  const run = (args: string[]) => {
    try { return { code: 0, out: execFileSync(process.execPath, ["--import", "tsx", "src/permissionsReconcileCli.ts", ...args], { cwd: dbDir, encoding: "utf8", env: process.env }) }; }
    catch (e) { const x = e as { status: number; stdout: string; stderr: string }; return { code: x.status, out: `${x.stdout}${x.stderr}` }; }
  };
  it("🔴 the command's dry run reports and writes nothing (exit 0); an unnamed environment is refused by name (exit 2)", async () => {
    const c = await pool.connect();
    const count = async () => (await c.query("SELECT (SELECT count(*) FROM permissions) AS p, (SELECT count(*) FROM permission_reconciliations) AS r")).rows[0];
    const before = await count();
    const dry = run(["--env", ENV]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain("Nothing was written (dry run).");
    expect(dry.out).toContain(`matrix ${PERMISSION_MATRIX.length} grants`);
    expect(await count()).toEqual(before);
    const bad = run(["--env", "Not An Env", "--apply"]);
    expect(bad.code, bad.out).toBe(2);
    expect(bad.out).toContain("REFUSED (environment_invalid)");
    expect(await count()).toEqual(before);
    c.release();
  }, 60_000);
});
