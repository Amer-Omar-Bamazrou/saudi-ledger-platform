import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * M14 — no app role holds TRUNCATE, REFERENCES or TRIGGER on anything.
 *
 * 🔴 TRUNCATE IS NOT SUBJECT TO ROW-LEVEL SECURITY. Unlike DELETE it is not
 * filtered by `tenant_isolation`, so one statement from a compromised app role
 * — or a SQL-injection flaw in any of the ~18 business domains — could erase
 * EVERY tenant's rows from a table while RLS looked on. That is the difference
 * between a tenant-scoped incident and a platform-wide one.
 *
 * These grants were never written by our migrations. Supabase's base
 * `ALTER DEFAULT PRIVILEGES` hands all three to anon/authenticated/service_role
 * on every newly created table; **35 tables had accumulated them** by M14,
 * including the "owner-only" identity tables that were assumed to have no grants
 * at all.
 *
 * Two assertions, and the second is the one that keeps this closed:
 *   1. No such grant exists today.
 *   2. A BRAND-NEW table does not receive them either — otherwise the next
 *      `CREATE TABLE` silently undoes migration 0026, which is exactly how the
 *      35 accumulated unnoticed in the first place.
 */

const connectionString = process.env.DATABASE_URL;
const REAL_DB = !!connectionString && !connectionString.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[destructive-grants] DATABASE_URL not set — skipping.");
}

const APP_ROLES = ["anon", "authenticated", "service_role"];
const DESTRUCTIVE = ["TRUNCATE", "REFERENCES", "TRIGGER"];

describeMaybe("M14 — app roles hold no TRUNCATE / REFERENCES / TRIGGER", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  it("🔴 no app role holds a destructive grant on ANY table", async () => {
    const { rows } = await client.query(
      `SELECT table_name, grantee, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND grantee = ANY($1)
          AND privilege_type = ANY($2)
        ORDER BY table_name, grantee, privilege_type`,
      [APP_ROLES, DESTRUCTIVE],
    );

    // Named in the failure so the offending table is obvious rather than a count.
    expect(
      rows.map((r) => `${r.table_name}.${r.privilege_type}→${r.grantee}`),
      "a destructive grant reappeared — see migration 0026",
    ).toEqual([]);
  });

  it("🔴 a BRAND-NEW table does not inherit them from Supabase's defaults", async () => {
    // The recurrence guard. Without the ALTER DEFAULT PRIVILEGES in 0026, the
    // next table created by any migration silently re-grants all three.
    await client.query(`CREATE TABLE IF NOT EXISTS m14_grant_probe (id int)`);
    try {
      const { rows } = await client.query(
        `SELECT grantee, privilege_type
           FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name = 'm14_grant_probe'
            AND grantee = ANY($1) AND privilege_type = ANY($2)`,
        [APP_ROLES, DESTRUCTIVE],
      );
      expect(
        rows.map((r) => `${r.privilege_type}→${r.grantee}`),
        "a new table inherited destructive grants — the default privileges regressed",
      ).toEqual([]);
    } finally {
      await client.query(`DROP TABLE IF EXISTS m14_grant_probe`);
    }
  });

  it("the app role still holds exactly what it USES on a business table", async () => {
    // The revoke must not have taken anything real. `invoices` is representative:
    // RLS-scoped business data the app role reads and writes.
    const { rows } = await client.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='public' AND table_name='invoices' AND grantee='authenticated'
        ORDER BY privilege_type`,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
  });

  it("owner-only tables still hold NOTHING", async () => {
    const { rows } = await client.query(
      `SELECT table_name, count(*)::int AS n
         FROM information_schema.role_table_grants
        WHERE table_schema='public' AND grantee = ANY($1)
          AND table_name = ANY($2)
        GROUP BY table_name`,
      [
        APP_ROLES,
        [
          "zatca_credentials",
          "zatca_credential_reminders",
          "platform_operators",
          "verification_reviews",
          "verification_documents",
          "organization_invitations",
          "security_audit_logs",
        ],
      ],
    );
    expect(rows).toEqual([]);
  });

  it("audit_logs remains append-only (INSERT + SELECT, never UPDATE/DELETE)", async () => {
    // M6's guarantee must survive a broad revoke.
    const { rows } = await client.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='public' AND table_name='audit_logs' AND grantee='authenticated'
        ORDER BY privilege_type`,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
  });

  it("einvoice_archive remains append-only (M12.8)", async () => {
    const { rows } = await client.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema='public' AND table_name='einvoice_archive' AND grantee='authenticated'
        ORDER BY privilege_type`,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
  });
});
