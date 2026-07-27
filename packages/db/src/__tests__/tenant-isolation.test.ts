import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Cross-tenant isolation — the acceptance test for the entire tenancy system.
 *
 * Proves that Postgres Row-Level Security (migration 0003) prevents a session
 * scoped to org B from reading OR mutating org A's data, and that the same data
 * IS visible when scoped to org A.
 *
 * WHY A ROLE SWITCH:
 * RLS is bypassed by a table's OWNER, by superusers, and by roles with the
 * BYPASSRLS attribute. On Supabase the connection role (`postgres`) both owns the
 * tables and has BYPASSRLS, so it never sees RLS — which is exactly why the app
 * keeps working between M3 and M4 (see 0003; we deliberately do not FORCE RLS).
 * To OBSERVE RLS, this test switches to the non-privileged `authenticated` role
 * (non-owner, non-BYPASSRLS) via `SET LOCAL ROLE` before querying — the same
 * posture the API will adopt in M4. Tenant context is supplied through the
 * `app.current_org_id` GUC, set transaction-locally.
 *
 * Everything the switch needs (a table privilege grant, the role, the GUC) is
 * confined to a transaction that is always rolled back, so the test leaves no
 * persistent grants, roles, or settings behind.
 */

const connectionString = process.env.DATABASE_URL;
// Non-privileged, non-BYPASSRLS role that the current user may `SET ROLE` to.
// `authenticated` ships with Supabase and `postgres` is already a member of it.
const RLS_ROLE = "authenticated";

const describeMaybe = connectionString ? describe : describe.skip;
if (!connectionString) {
  // eslint-disable-next-line no-console
  console.warn("[tenant-isolation] DATABASE_URL not set — skipping RLS isolation test.");
}

describeMaybe("cross-tenant isolation (RLS)", () => {
  let client: pg.Client;
  let orgA = "";
  let orgB = "";
  let txnId = 0;

  /**
   * Run `sql` as the non-privileged RLS role, scoped to `orgId` (pass null to
   * leave the tenant GUC unset). The grant, role switch, and GUC all live inside
   * a transaction that is always rolled back — nothing persists.
   */
  async function asTenant(
    orgId: string | null,
    sql: string,
    params: unknown[],
  ): Promise<pg.QueryResult> {
    await client.query("BEGIN");
    try {
      await client.query(`GRANT SELECT, UPDATE, DELETE ON "transactions" TO ${RLS_ROLE}`);
      if (orgId !== null) {
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
      }
      await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
      return await client.query(sql, params);
    } finally {
      await client.query("ROLLBACK");
    }
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();

    // Seed two isolated tenants + one transaction owned by org A. Runs as the
    // connection owner, which bypasses RLS, so setup is unaffected by policies.
    await client.query(`DELETE FROM transactions WHERE description = 'ISO-TEST-TXN'`);
    await client.query(`DELETE FROM companies WHERE name IN ('ISO Test Co A', 'ISO Test Co B')`);
    await client.query(`DELETE FROM organizations WHERE slug IN ('iso-test-a', 'iso-test-b')`);

    orgA = (
      await client.query(`INSERT INTO organizations (name, slug) VALUES ('ISO Test Org A', 'iso-test-a') RETURNING id`)
    ).rows[0].id;
    orgB = (
      await client.query(`INSERT INTO organizations (name, slug) VALUES ('ISO Test Org B', 'iso-test-b') RETURNING id`)
    ).rows[0].id;
    const companyA = (
      await client.query(`INSERT INTO companies (organization_id, name) VALUES ($1, 'ISO Test Co A') RETURNING id`, [orgA])
    ).rows[0].id;
    txnId = (
      await client.query(
        `INSERT INTO transactions (organization_id, company_id, date, description, amount, type)
         VALUES ($1, $2, '2026-01-01', 'ISO-TEST-TXN', '100.00', 'debit') RETURNING id`,
        [orgA, companyA],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DELETE FROM transactions WHERE description = 'ISO-TEST-TXN'`);
    await client.query(`DELETE FROM companies WHERE name IN ('ISO Test Co A', 'ISO Test Co B')`);
    await client.query(`DELETE FROM organizations WHERE slug IN ('iso-test-a', 'iso-test-b')`);
    await client.end();
  });

  it("hides org A's row from a session scoped to org B (SELECT → 0 rows)", async () => {
    const r = await asTenant(orgB, `SELECT id FROM transactions WHERE id = $1`, [txnId]);
    expect(r.rowCount).toBe(0);
  });

  it("blocks UPDATE of org A's row from org B (0 rows affected)", async () => {
    const r = await asTenant(orgB, `UPDATE transactions SET notes = 'hacked' WHERE id = $1`, [txnId]);
    expect(r.rowCount).toBe(0);
  });

  it("blocks DELETE of org A's row from org B (0 rows affected)", async () => {
    const r = await asTenant(orgB, `DELETE FROM transactions WHERE id = $1`, [txnId]);
    expect(r.rowCount).toBe(0);
  });

  it("returns empty (not an error) when no tenant context is set", async () => {
    const r = await asTenant(null, `SELECT id FROM transactions WHERE id = $1`, [txnId]);
    expect(r.rowCount).toBe(0);
  });

  it("exposes org A's row to a session scoped to org A (SELECT → 1 row)", async () => {
    const r = await asTenant(orgA, `SELECT id FROM transactions WHERE id = $1`, [txnId]);
    expect(r.rowCount).toBe(1);
  });

  it("left the row intact — the blocked UPDATE/DELETE never touched it", async () => {
    const r = await client.query(`SELECT notes FROM transactions WHERE id = $1`, [txnId]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].notes).toBeNull();
  });
});
