import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Credential-vault DB boundary (M12.5).
 *
 * `zatca_credentials` holds per-company ZATCA signing keys — the most sensitive
 * data in the platform. It is owner-only: no RLS, and the app role
 * (`authenticated`) is granted NOTHING.
 *
 * 🔴 The TRUNCATE case is the reason this file exists rather than being folded
 * into `operator-tables.test.ts`. Supabase's base `ALTER DEFAULT PRIVILEGES`
 * silently grants REFERENCES, TRIGGER and **TRUNCATE** on every newly created
 * table to anon/authenticated/service_role. TRUNCATE needs no DELETE privilege
 * and bypasses RLS, so without the explicit REVOKE in migration 0019 the app
 * role — reachable from any of the ~18 business routes via SQL injection — could
 * wipe EVERY tenant's signing keys in one statement. That is unrecoverable: each
 * tenant would have to re-onboard with a new key, CSR and OTP.
 *
 * This test is what stops that REVOKE from being deleted by a future migration
 * regeneration.
 */

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
if (!connectionString) {
  // eslint-disable-next-line no-console
  console.warn("[zatca-credentials] DATABASE_URL not set — skipping boundary test.");
}

const RLS_ROLE = "authenticated";

describeMaybe("zatca_credentials — owner-only credential vault", () => {
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

  it("forbids the app role from SELECT-ing the vault", async () => {
    await expect(asAppRole("SELECT 1 FROM zatca_credentials LIMIT 1")).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("forbids the app role from INSERT-ing into the vault", async () => {
    await expect(
      asAppRole(
        `INSERT INTO zatca_credentials
           (company_id, environment, kms_provider, kms_key_id, wrapped_data_key,
            encrypted_private_key, private_key_iv, private_key_auth_tag)
         VALUES (gen_random_uuid(), 'sandbox', 'x', 'x', '\\x00', '\\x00', '\\x00', '\\x00')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("forbids the app role from UPDATE-ing or DELETE-ing the vault", async () => {
    await expect(asAppRole("UPDATE zatca_credentials SET status = 'revoked'")).rejects.toThrow(
      /permission denied/i,
    );
    await expect(asAppRole("DELETE FROM zatca_credentials")).rejects.toThrow(/permission denied/i);
  });

  it("🔴 forbids the app role from TRUNCATE-ing the vault (bypasses RLS; would destroy every tenant's keys)", async () => {
    await expect(asAppRole("TRUNCATE zatca_credentials")).rejects.toThrow(/permission denied/i);
  });

  it("grants the app role NOTHING at all on the vault", async () => {
    const { rows } = await client.query(
      `SELECT grantee, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_name = 'zatca_credentials'
          AND grantee IN ('anon', 'authenticated', 'service_role')`,
    );
    expect(rows).toEqual([]);
  });

  it("enforces ONE active credential per (company, environment) in the DATABASE", async () => {
    const { rows } = await client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'zatca_credentials'
          AND indexname = 'zatca_credentials_one_active_unq'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE/i);
    expect(rows[0].indexdef).toMatch(/WHERE \(status = 'active'/i);
  });

  it("does NOT enable RLS (owner-only tables rely on the absence of grants)", async () => {
    const { rows } = await client.query(
      "SELECT relrowsecurity FROM pg_class WHERE relname = 'zatca_credentials'",
    );
    expect(rows[0].relrowsecurity).toBe(false);
  });
});
