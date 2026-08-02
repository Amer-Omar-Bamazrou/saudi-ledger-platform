import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Security-audit log boundary (M11.1): `security_audit_logs` is an identity-layer
 * table written and read ONLY on the base/owner connection. The RLS app role
 * (`authenticated`) is granted NOTHING on it — it cannot SELECT or INSERT. This
 * keeps the table entirely off the tenant-scoped path (unlike business
 * `audit_logs`, which the app role may INSERT/SELECT under RLS).
 *
 * Uses the non-privileged `authenticated` role with the REAL migration-granted
 * privileges (none), inside rolled-back transactions.
 */

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
if (!connectionString) {
  // eslint-disable-next-line no-console
  console.warn("[security-audit-log] DATABASE_URL not set — skipping boundary test.");
}

const RLS_ROLE = "authenticated";

describeMaybe("security_audit_logs — owner-only (app role has no access)", () => {
  let client: pg.Client;

  /** Run `sql` as the non-owner app role inside a rolled-back tx. */
  async function asAppRole(sql: string): Promise<pg.QueryResult> {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL ROLE ${RLS_ROLE}`);
      return await client.query(sql);
    } finally {
      await client.query("ROLLBACK");
    }
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  it("forbids the app role from SELECT-ing security_audit_logs", async () => {
    await expect(asAppRole(`SELECT id FROM security_audit_logs LIMIT 1`)).rejects.toThrow(/permission denied/i);
  });

  it("forbids the app role from INSERT-ing into security_audit_logs", async () => {
    await expect(
      asAppRole(`INSERT INTO security_audit_logs (action) VALUES ('boundary.test')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("allows the owner connection to INSERT + SELECT (identity layer)", async () => {
    const ins = await client.query(
      `INSERT INTO security_audit_logs (action) VALUES ('boundary.owner.test') RETURNING id`,
    );
    expect(ins.rowCount).toBe(1);
    await client.query(`DELETE FROM security_audit_logs WHERE id = $1`, [ins.rows[0].id]);
  });
});
