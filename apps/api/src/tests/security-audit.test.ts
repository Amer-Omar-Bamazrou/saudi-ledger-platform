/**
 * Security-audit log (M11.1) — proves that identity/security events are recorded
 * to `security_audit_logs` and are readable only by an admin of the target org.
 *
 * Focus:
 *   1. Membership changes emit org-scoped security events (assigned / role_changed
 *      / status_changed), captured with the actor and target.
 *   2. The org read is explicitly authorized — an admin of org B cannot read
 *      org A's security events (mirrors the members.service boundary).
 *   3. Global (org-less) events are NOT exposed by the per-org read.
 *
 * DB-backed; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { membersService } from "../services/members.service";
import { securityAuditService } from "../services/securityAudit.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[security-audit] no real DATABASE_URL — skipping security-audit test.");
}

describeMaybe("securityAuditService — records + org-scoped, authorized reads", () => {
  let orgA = "";
  let orgB = "";
  let adminA = 0;
  let adminB = 0;
  let target = 0;

  const cleanup = async () => {
    // Clear security-audit rows FIRST (their FKs to users/orgs block the deletes
    // below). Match by the stable test email/slug patterns so leftovers from a
    // prior failed run — whose ids we no longer hold — are also removed.
    await pool.query(
      `DELETE FROM security_audit_logs
         WHERE organization_id IN (SELECT id FROM organizations WHERE slug IN ('secaudit-a','secaudit-b'))
            OR actor_user_id  IN (SELECT id FROM users WHERE email LIKE 'secaudit-test-%')
            OR target_user_id IN (SELECT id FROM users WHERE email LIKE 'secaudit-test-%')`,
    );
    await pool.query(
      `DELETE FROM organization_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'secaudit-test-%')`,
    );
    await pool.query(`DELETE FROM users WHERE email LIKE 'secaudit-test-%'`);
    await pool.query(`DELETE FROM organizations WHERE slug IN ('secaudit-a','secaudit-b')`);
  };

  beforeAll(async () => {
    await cleanup();
    orgA = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('SecAudit A','secaudit-a') RETURNING id`)).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('SecAudit B','secaudit-b') RETURNING id`)).rows[0].id;
    const mkUser = async (email: string) =>
      (await pool.query(`INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,$1,' ','viewer',true) RETURNING id`, [email])).rows[0].id;
    adminA = await mkUser("secaudit-test-admin-a@test.local");
    adminB = await mkUser("secaudit-test-admin-b@test.local");
    target = await mkUser("secaudit-test-target@test.local");
    await pool.query(`INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`, [adminA, orgA]);
    await pool.query(`INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`, [adminB, orgB]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("records a membership.assigned event, readable by the org admin", async () => {
    await membersService.assign(adminA, orgA, target, "bookkeeper", {
      actorEmail: "secaudit-test-admin-a@test.local",
      ipAddress: "203.0.113.7",
    });

    const events = await securityAuditService.listForOrg(adminA, orgA);
    const ev = events.find((e) => e.action === "membership.assigned" && e.targetUserId === target);
    expect(ev).toBeTruthy();
    expect(ev?.actorUserId).toBe(adminA);
    expect(ev?.organizationId).toBe(orgA);
    expect(ev?.actorEmail).toBe("secaudit-test-admin-a@test.local");
    expect(ev?.ipAddress).toBe("203.0.113.7");
  });

  it("records a membership.role_changed event on an update", async () => {
    await membersService.update(adminA, orgA, target, { role: "accountant" });
    const events = await securityAuditService.listForOrg(adminA, orgA);
    const ev = events.find((e) => e.action === "membership.role_changed" && e.targetUserId === target);
    expect(ev).toBeTruthy();
    expect(ev?.metadata).toMatchObject({ before: { role: "bookkeeper" }, after: { role: "accountant" } });
  });

  it("records a membership.status_changed event when only status changes", async () => {
    await membersService.update(adminA, orgA, target, { status: "inactive" });
    const events = await securityAuditService.listForOrg(adminA, orgA);
    expect(events.some((e) => e.action === "membership.status_changed" && e.targetUserId === target)).toBe(true);
  });

  it("CRITICAL: an admin of org B cannot read org A's security events (403)", async () => {
    await expect(securityAuditService.listForOrg(adminB, orgA)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("does not expose global (org-less) events in the per-org read", async () => {
    await securityAuditService.record({
      action: "user.created",
      actorUserId: adminA,
      targetUserId: target,
      organizationId: null,
      metadata: { email: "secaudit-test-target@test.local" },
    });
    const events = await securityAuditService.listForOrg(adminA, orgA);
    expect(events.some((e) => e.action === "user.created")).toBe(false);
  });
});
