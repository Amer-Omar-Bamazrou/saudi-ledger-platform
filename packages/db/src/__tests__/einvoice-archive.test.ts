import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * M12.8 archive boundaries — the two new tables, tested for OPPOSITE things.
 *
 * ── `einvoice_archive` — tenant-readable but APPEND-ONLY ────────────────────
 * Unlike the owner-only identity tables, the tenant MUST be able to read this:
 * they are legally required to retain and produce their own invoices. So the app
 * role gets SELECT + INSERT — and nothing else.
 *
 * ZATCA §5.5 requires that generated invoices "should not be deleted or altered
 * by any user" and that the solution protect them from "any alteration or
 * undetected deletion". That is enforced the way `audit_logs` (M6) and
 * `security_audit_logs` (M11.1) enforce it: in the database, because a
 * convention protects nothing against a compromised app role.
 *
 * 🔴 TRUNCATE IS THE ONE THAT MATTERS and the one that is easy to miss.
 * Supabase's base `ALTER DEFAULT PRIVILEGES` grants REFERENCES, TRIGGER and
 * TRUNCATE on every newly created table. **TRUNCATE is not subject to
 * row-level security** — unlike DELETE it is not filtered by the
 * `tenant_isolation` policy — so without an explicit REVOKE one statement from
 * any of the ~18 business routes could erase EVERY tenant's archive index while
 * the policy looked on. Revoking UPDATE/DELETE alone would look correct and be
 * insufficient.
 *
 * ── `zatca_credential_reminders` — owner-only ───────────────────────────────
 * Granted nothing at all, like the vault it points at.
 */

const connectionString = process.env.DATABASE_URL;
const REAL_DB = !!connectionString && !connectionString.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[einvoice-archive] DATABASE_URL not set — skipping boundary test.");
}

const RLS_ROLE = "authenticated";

describeMaybe("M12.8 — einvoice_archive is append-only; reminders are owner-only", () => {
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

  const grants = async (table: string): Promise<string[]> => {
    const { rows } = await client.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = $1 AND grantee = $2`,
      [table, RLS_ROLE],
    );
    return rows.map((r) => r.privilege_type).sort();
  };

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  // ── einvoice_archive ─────────────────────────────────────────────────────

  it("grants the app role exactly SELECT + INSERT — and nothing else", async () => {
    // Measured, not assumed. CLAUDE.md's standing warning applies: do not
    // assume a table's grants are what the migration wrote; verify against
    // information_schema, because the Supabase defaults add to them.
    expect(await grants("einvoice_archive")).toEqual(["INSERT", "SELECT"]);
  });

  it("🔴 the app role cannot TRUNCATE the archive index (TRUNCATE BYPASSES RLS)", async () => {
    await expect(asAppRole(`TRUNCATE TABLE einvoice_archive`)).rejects.toMatchObject({
      code: "42501", // insufficient_privilege
    });
  });

  it("the app role cannot UPDATE or DELETE an archive row", async () => {
    await expect(
      asAppRole(`UPDATE einvoice_archive SET sha256 = 'tampered'`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(asAppRole(`DELETE FROM einvoice_archive`)).rejects.toMatchObject({ code: "42501" });
  });

  it("the app role CAN select (the tenant must be able to produce their archive)", async () => {
    // No org GUC is set, so RLS matches nothing — but the statement must be
    // PERMITTED. A privilege error here would mean the tenant cannot read their
    // own legally-required records.
    const res = await asAppRole(`SELECT count(*) FROM einvoice_archive`);
    expect(res.rows).toHaveLength(1);
  });

  it("has RLS enabled with a tenant_isolation policy", async () => {
    const { rows } = await client.query(
      `SELECT c.relrowsecurity, p.polname
         FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE c.relname = 'einvoice_archive'`,
    );
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows.map((r) => r.polname)).toContain("tenant_isolation");
  });

  // ── zatca_credential_reminders ───────────────────────────────────────────

  it("grants the app role NOTHING on zatca_credential_reminders", async () => {
    expect(await grants("zatca_credential_reminders")).toEqual([]);
  });

  it("the app role cannot even SELECT the reminders table", async () => {
    await expect(
      asAppRole(`SELECT * FROM zatca_credential_reminders`),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("the app role cannot TRUNCATE the reminders table", async () => {
    await expect(
      asAppRole(`TRUNCATE TABLE zatca_credential_reminders`),
    ).rejects.toMatchObject({ code: "42501" });
  });

  // ── the dead column is gone ──────────────────────────────────────────────

  it("companies.zatca_onboarding_status is dropped (nothing ever wrote it)", async () => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'companies' AND column_name = 'zatca_onboarding_status'`,
    );
    expect(rows).toHaveLength(0);
  });
});
