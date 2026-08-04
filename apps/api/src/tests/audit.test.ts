import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { customersService } from "../services/customers.service";

/**
 * Integration test (M7): a real service mutation, run inside a tenant scope +
 * audit context, produces the correct audit_logs record(s) — right actor, org,
 * action, and before/after snapshots. Exercises the full audit hook end to end
 * (customersService → auditService → audit_logs, on the tenant-scoped connection).
 *
 * Owner-side setup/verify goes through the base `pool` (bypasses RLS). Needs a
 * real database; skips when DATABASE_URL is unset or the DB-free placeholder.
 */
const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[audit] no real DATABASE_URL — skipping audit integration test.");
}

describeMaybe("audit logging — service mutation produces audit records", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;

  const cleanup = async () => {
    if (orgId) await pool.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM customers WHERE name LIKE 'AUDIT-CUST%'`);
    if (userId) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE email = 'audit-int@test.local'`);
    await pool.query(`DELETE FROM companies WHERE name = 'AUDIT Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'audit-int'`);
  };

  beforeAll(async () => {
    await pool.query(`DELETE FROM organizations WHERE slug = 'audit-int'`);
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AUDIT Org','audit-int') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'AUDIT Co','1010101010','399999999999993') RETURNING id`, [orgId])).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('audit-int@test.local','Audit',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("records create then update with correct actor, org, action, and before/after", async () => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    let customerId = 0;
    try {
      customerId = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.7" }, async () => {
          const created = await customersService.create({ name: "AUDIT-CUST" } as never);
          await customersService.update(created.id, { name: "AUDIT-CUST-2" });
          return created.id;
        }),
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }

    const rows = (
      await pool.query(
        `SELECT action, user_id, organization_id, entity_type, entity_id, before_state, after_state, ip_address
         FROM audit_logs WHERE entity_type = 'customer' AND entity_id = $1`,
        [String(customerId)],
      )
    ).rows;

    expect(rows.length).toBe(2);

    // Select by ACTION, never by row order. The create and the update happen in
    // ONE request transaction, and Postgres `now()` is the transaction
    // timestamp — so both rows carry an IDENTICAL `created_at` and any
    // `ORDER BY created_at` has no tiebreak. `audit_logs.id` is a random uuid,
    // not a sequence, so it cannot break the tie either. This test asserts the
    // CONTENT of each record, which is what it actually cares about; ordering
    // was never the property under test.
    const createLog = rows.find((r) => r.action === "create");
    const updateLog = rows.find((r) => r.action === "update");
    expect(createLog, "expected a create audit record").toBeDefined();
    expect(updateLog, "expected an update audit record").toBeDefined();
    // create record — actor, tenant and IP come from the auditContext ALS.
    expect(createLog.user_id).toBe(userId);
    expect(createLog.organization_id).toBe(orgId);
    expect(createLog.ip_address).toBe("203.0.113.7");
    expect(createLog.before_state).toBeNull();
    expect(createLog.after_state?.name).toBe("AUDIT-CUST");
    // update record — carries the before/after transition.
    expect(updateLog.before_state?.name).toBe("AUDIT-CUST");
    expect(updateLog.after_state?.name).toBe("AUDIT-CUST-2");
  });
});
