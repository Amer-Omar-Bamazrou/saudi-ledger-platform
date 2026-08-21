/**
 * M23 — the audit trail names its actors, without leaking across tenants.
 *
 * `users` is outside RLS; resolution goes through the identity layer
 * (`membersRepository.memberNamesByIds`, the same sanctioned consumer as
 * B1's activeAdminEmails), scoped to the org's own memberships. The negative
 * case is the one that matters: a userId with NO membership in this org must
 * come back UNRESOLVED — never a name borrowed from another tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { membersRepository } from "../repositories/members.repository";
import { auditLogsService } from "../services/auditLogs.service";
import { periodLocksService } from "../services/periodLocks.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[audit-trail] no real DATABASE_URL — skipping.");
}

describeMaybe("M23 — audit-trail actor resolution", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let outsiderId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.99" }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    if (orgId) {
      await pool.query(`DELETE FROM period_locks WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [orgId]);
    }
    if (userId) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE email IN ('audit-trail@test.local','audit-outsider@test.local')`);
    await pool.query(`DELETE FROM companies WHERE name = 'AUDIT Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'audit-trail-test'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AUDIT Org','audit-trail-test') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'AUDIT Co','1010101018','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('audit-trail@test.local','Trail Reader',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    // A real user with NO membership in this org — the leak candidate.
    outsiderId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('audit-outsider@test.local','Foreign Actor',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    // Produce an audited action attributable to Trail Reader.
    await inTenant(() => periodLocksService.lock({ period: "2025-06", userId }));
  });

  afterAll(async () => {
    await cleanup();
  });

  it("resolves this org's member and 🔴 refuses a foreign userId", async () => {
    const names = await membersRepository.memberNamesByIds(orgId, [userId, outsiderId]);
    expect(names.get(userId)).toBe("Trail Reader");
    expect(names.has(outsiderId), "a userId with no membership here must not resolve").toBe(false);
  });

  it("the audit list carries actorName end to end", async () => {
    const page = await inTenant(() =>
      auditLogsService.list({ entityType: "period_lock", limit: 10, offset: 0 }, orgId),
    );
    expect(page.logs.length).toBeGreaterThan(0);
    expect(page.logs[0].actorName).toBe("Trail Reader");
    expect(page.logs[0].action).toBe("create");
  });
});
