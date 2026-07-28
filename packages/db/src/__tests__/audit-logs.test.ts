import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Audit-log guarantees (M7):
 *   1. Tenant isolation — a session scoped to org B cannot SELECT org A's audit
 *      rows (RLS).
 *   2. Append-only — the application role (`authenticated`) may INSERT/SELECT but
 *      NOT UPDATE or DELETE audit_logs (migration 0006 revoked those). The audit
 *      trail is tamper-resistant.
 *
 * Uses the non-privileged `authenticated` role (the API's runtime posture) and
 * the REAL migration-granted privileges — no in-test GRANT — so append-only is
 * exercised exactly as production. Everything runs inside rolled-back transactions.
 */

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
if (!connectionString) {
  // eslint-disable-next-line no-console
  console.warn("[audit-logs] DATABASE_URL not set — skipping audit-log tests.");
}

const RLS_ROLE = "authenticated";

describeMaybe("audit_logs — tenant isolation + append-only", () => {
  let client: pg.Client;
  let orgA = "";
  let orgB = "";

  /** Run `sql` as the non-owner role scoped to `orgId`, inside a rolled-back tx. */
  async function asTenant(orgId: string, sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
      await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
      return await client.query(sql, params);
    } finally {
      await client.query("ROLLBACK");
    }
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(`DELETE FROM audit_logs WHERE entity_id IN ('ISO-AUDIT-A','ISO-AUDIT-B')`);
    await client.query(`DELETE FROM organizations WHERE slug IN ('iso-audit-a','iso-audit-b')`);

    orgA = (await client.query(`INSERT INTO organizations (name, slug) VALUES ('ISO Audit A','iso-audit-a') RETURNING id`)).rows[0].id;
    orgB = (await client.query(`INSERT INTO organizations (name, slug) VALUES ('ISO Audit B','iso-audit-b') RETURNING id`)).rows[0].id;
    // One audit row per org, inserted as the owner (bypasses RLS for setup).
    await client.query(
      `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id) VALUES ($1,'create','test','ISO-AUDIT-A')`,
      [orgA],
    );
    await client.query(
      `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id) VALUES ($1,'create','test','ISO-AUDIT-B')`,
      [orgB],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DELETE FROM audit_logs WHERE entity_id IN ('ISO-AUDIT-A','ISO-AUDIT-B')`);
    await client.query(`DELETE FROM organizations WHERE slug IN ('iso-audit-a','iso-audit-b')`);
    await client.end();
  });

  it("hides org A's audit rows from a session scoped to org B", async () => {
    const r = await asTenant(orgB, `SELECT id FROM audit_logs WHERE entity_id = 'ISO-AUDIT-A'`);
    expect(r.rowCount).toBe(0);
  });

  it("exposes org A's audit rows to a session scoped to org A", async () => {
    const r = await asTenant(orgA, `SELECT id FROM audit_logs WHERE entity_id = 'ISO-AUDIT-A'`);
    expect(r.rowCount).toBe(1);
  });

  it("forbids the app role from UPDATE-ing audit_logs (append-only)", async () => {
    await expect(
      asTenant(orgA, `UPDATE audit_logs SET action = 'tampered' WHERE entity_id = 'ISO-AUDIT-A'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("forbids the app role from DELETE-ing audit_logs (append-only)", async () => {
    await expect(
      asTenant(orgA, `DELETE FROM audit_logs WHERE entity_id = 'ISO-AUDIT-A'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("still allows the app role to INSERT audit rows for its own org", async () => {
    const r = await asTenant(
      orgA,
      `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id) VALUES ($1,'create','test','ISO-AUDIT-A') RETURNING id`,
      [orgA],
    );
    expect(r.rowCount).toBe(1);
  });
});
