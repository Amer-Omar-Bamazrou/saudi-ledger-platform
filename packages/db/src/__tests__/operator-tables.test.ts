import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Operator-surface tables boundary (M11.3): `platform_operators` and
 * `verification_reviews` are identity-layer tables accessed ONLY on the
 * base/owner connection (the /operator + /onboarding surfaces run before
 * resolveTenant). The RLS app role (`authenticated`) is granted NOTHING on them —
 * it cannot SELECT or INSERT — keeping the cross-tenant review privilege and its
 * history entirely off the tenant-scoped path.
 *
 * Uses the non-privileged `authenticated` role with the REAL migration-granted
 * privileges (none), inside rolled-back transactions.
 */

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
if (!connectionString) {
  // eslint-disable-next-line no-console
  console.warn("[operator-tables] DATABASE_URL not set — skipping boundary test.");
}

const RLS_ROLE = "authenticated";

describeMaybe("platform_operators / verification_reviews / verification_documents — owner-only", () => {
  let client: pg.Client;

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

  for (const table of ["platform_operators", "verification_reviews", "verification_documents"]) {
    it(`forbids the app role from SELECT-ing ${table}`, async () => {
      await expect(asAppRole(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(/permission denied/i);
    });
  }

  it("forbids the app role from INSERT-ing into platform_operators", async () => {
    await expect(
      asAppRole(`INSERT INTO platform_operators (user_id) VALUES (2147483647)`),
    ).rejects.toThrow(/permission denied/i);
  });
});
