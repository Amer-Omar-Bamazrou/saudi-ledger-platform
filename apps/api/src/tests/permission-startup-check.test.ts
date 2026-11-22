import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beginTenantConnection, pool, PERMISSION_MATRIX } from "@workspace/db";
import { assertPermissionsMatchMatrix, PermissionDriftError } from "../lib/permissionStartupCheck";
import { can, resetPermissionCache } from "../lib/rbac";

/**
 * 🔴 Phase 19B S0 (D10, owner 2026-11-21).
 *
 * 1. The API REFUSES TO START while the `permissions` table differs from PERMISSION_MATRIX, naming every difference,
 *    and starts when they agree — checked inside a rolled-back transaction that first sets the table to exactly the
 *    matrix (CI's test database is migrated but not seeded), then plants one missing and one extra grant.
 * 2. The check is on the boot path: index.ts calls it before importing the app or listening.
 * 3. THE API'S PERMISSION CHECKS AND THE DATABASE'S POSTING CHECKS READ THE SAME GRANTS (owner, 2026-11-21): for every
 *    posting grant and the journal-entry approval that sets the approver count, the API's `can()` (its cache, loaded
 *    through a real tenant connection) and the database's `role_holds_grant` answer alike, and both answer as the
 *    table does — in whatever state this database is.
 */
describe("19B S0 — the startup check, and one set of grants for both readers", () => {
  const SLUG = `s0-startup-${Date.now()}`;
  let orgId = "";
  beforeAll(async () => {
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('S0 startup check', $1) RETURNING id`, [SLUG])).rows[0].id;
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  });

  it("🔴 starts on a table equal to the matrix; REFUSES on a drifted one, naming each difference and the database", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      // the table lock before any write: a parallel suite seeding the table waits for this transaction, never deadlocks
      await c.query("LOCK TABLE permissions IN EXCLUSIVE MODE");
      await c.query("DELETE FROM permissions");
      for (const p of PERMISSION_MATRIX) await c.query("INSERT INTO permissions (role, resource, action) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [p.role, p.resource, p.action]);
      await expect(assertPermissionsMatchMatrix(c), "the table is the matrix: it starts").resolves.toBeUndefined();

      await c.query("DELETE FROM permissions WHERE role = 'viewer' AND resource = 'invoices' AND action = 'read'");
      await c.query("INSERT INTO permissions (role, resource, action) VALUES ('viewer', 'invoices', 'approve')");
      const database = (await c.query("SELECT current_database() AS d")).rows[0].d as string;
      const err = (await assertPermissionsMatchMatrix(c).then(() => null, (e: unknown) => e)) as PermissionDriftError | null;
      expect(err, "a drifted table must refuse").toBeInstanceOf(PermissionDriftError);
      expect(err!.message).toContain(`database '${database}'`);
      expect(err!.message).toContain("missing (in the matrix, not in the table): viewer:invoices:read");
      expect(err!.message).toContain("extra (in the table, not in the matrix): viewer:invoices:approve");
      expect(err!.message).toContain("permissions:reconcile");
      expect({ missing: err!.drift.missing.length, extra: err!.drift.extra.length }).toEqual({ missing: 1, extra: 1 });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("🔴 the check is on the BOOT PATH: index.ts runs it before it imports the app or listens", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");
    const check = src.indexOf("await assertPermissionsMatchMatrix(pool)");
    expect(check, "index.ts calls the startup check").toBeGreaterThan(0);
    expect(check).toBeLessThan(src.indexOf(`await import("./app")`));
    expect(check).toBeLessThan(src.indexOf("app.listen("));
  });

  it("🔴 the API's grants and the database's posting checks answer ALIKE, and as the table does", async () => {
    const roles = ["admin", "accountant", "bookkeeper", "viewer"];
    const resources = ["gl_cash_posting", "gl_tax_posting", "gl_equity_posting", "journal_entries"];
    const keys = roles.flatMap((role) => resources.map((resource) => ({ role, resource })));

    // the API: its real cache, loaded through a tenant connection exactly as a request loads it
    resetPermissionCache();
    const conn = await beginTenantConnection({ organizationId: orgId, role: "authenticated" });
    let api: boolean[];
    try {
      api = await conn.run(async () => Promise.all(keys.map((k) => can(k.role, k.resource, "approve"))));
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      resetPermissionCache();
    }
    // the database's posting checks
    const database: boolean[] = [];
    for (const k of keys) database.push((await pool.query("SELECT role_holds_grant($1, $2, 'approve') AS g", [k.role, k.resource])).rows[0].g === true);
    // the table itself
    const table: boolean[] = [];
    for (const k of keys) table.push(((await pool.query("SELECT 1 FROM permissions WHERE role = $1 AND resource = $2 AND action = 'approve'", [k.role, k.resource])).rowCount ?? 0) > 0);

    const label = (v: boolean[]) => keys.map((k, i) => `${k.role}:${k.resource}=${v[i]}`);
    expect(label(api), "the API's cache and the database's posting check").toEqual(label(database));
    expect(label(database), "…and both the table").toEqual(label(table));
    // non-vacuous: the posting grants are held by some role and refused to another
    expect(table.some(Boolean) && table.some((g) => !g), "some grants held, some not").toBe(true);
  });
});
