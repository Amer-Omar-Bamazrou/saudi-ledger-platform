/**
 * The M11.3 boundary, asserted BEHAVIOURALLY: platform-operator status grants
 * nothing whatsoever inside a tenant.
 *
 * 🔴 WHY THIS EXISTS. The boundary was, until now, a claim in a doc-comment
 * ("operators hold no membership, so `resolveTenant` blocks every business
 * route") plus one test of `resolveTenant`. That is an argument about a
 * mechanism, not a measurement of the surface: it says nothing about the
 * identity-layer routes that run BEFORE `resolveTenant` and are therefore not
 * protected by it at all — `/orgs/:orgId/members`, `/auth/users*`. Those are
 * exactly where an exemption would matter, because they are the routes that can
 * GRANT a membership.
 *
 * The specific escalation this rules out, end to end: an operator adding
 * THEMSELVES to a tenant as admin. That would be the inversion of M11.3 —
 * the guarantee is that operators are excluded from tenants, so a path by which
 * an operator joins one is not a weaker version of the guarantee, it is its
 * opposite. And it would not be read-only: it is cross-tenant privilege
 * escalation with no design intent behind it.
 *
 * Static evidence that it cannot happen (the search shape, so the claim is
 * reviewable rather than merely asserted): `isOperator` / `platform_operators`
 * appears in exactly four places in the API — `lib/operator.ts` (the guard),
 * `repositories/operators.repository.ts` (the query), `routes/index.ts` (the
 * mount), and `demoReset.service.ts` (a TRUNCATE list). No authorization path
 * — `rbac.ts`, `auth.ts`, `tenant.ts`, `members.service.ts`,
 * `userAdmin.service.ts` — consults it, so `assertOrgAdmin` has no way to know
 * an operator when it sees one.
 *
 * Static evidence ages, though. These tests are the standing measurement.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3108";
process.env.SESSION_SECRET ??= "operator-tenant-boundary-test-session-secret-0123";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[operator-tenant-boundary] no real DATABASE_URL — skipping.");
}

const PW = "BoundaryPw123!";
const OP_EMAIL = "optb-operator@test.local";
const ADMIN_EMAIL = "optb-tenant-admin@test.local";

describeMaybe("M11.3 boundary — operator status grants NOTHING inside a tenant", () => {
  let server: http.Server;
  let base = "";
  let operatorId = 0;
  let tenantAdminId = 0;
  let tenantOrg = "";

  const ORG_FILTER = `(SELECT id FROM organizations WHERE slug LIKE 'optb-%')`;
  const USER_FILTER = `(SELECT id FROM users WHERE email LIKE 'optb-%')`;

  const cleanup = async () => {
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(
      `DELETE FROM security_audit_logs WHERE organization_id IN ${ORG_FILTER} OR actor_user_id IN ${USER_FILTER} OR target_user_id IN ${USER_FILTER}`,
    );
    await pool.query(`DELETE FROM verification_reviews WHERE organization_id IN ${ORG_FILTER} OR operator_user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM organizations WHERE slug LIKE 'optb-%'`);
    await pool.query(`DELETE FROM platform_operators WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'optb-%'`);
  };

  const jar: Record<string, string> = {};
  async function api(who: string, method: string, path: string, body?: unknown) {
    const cookie = jar[who] ?? "";
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sid = ((res.headers as any).getSetCookie?.() ?? []).find((c: string) =>
      c.startsWith("ksa_ledger_sid="),
    );
    if (sid) jar[who] = sid.split(";")[0];
    let json: any;
    try { json = await res.json(); } catch { json = undefined; }
    return { status: res.status, body: json };
  }

  const membershipCount = async (userId: number) =>
    Number((await pool.query(
      `SELECT count(*)::int AS n FROM organization_memberships WHERE user_id = $1`,
      [userId],
    )).rows[0].n);

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();

    tenantOrg = (await pool.query(
      `INSERT INTO organizations (name, slug, verification_status) VALUES ('OpTB Tenant','optb-tenant','approved') RETURNING id`,
    )).rows[0].id;

    const hash = await bcrypt.hash(PW, 12);
    operatorId = (await pool.query(
      `INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,'Boundary Operator',$2,'viewer',true) RETURNING id`,
      [OP_EMAIL, hash],
    )).rows[0].id;
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [operatorId]);

    tenantAdminId = (await pool.query(
      `INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,'Tenant Admin',$2,'viewer',true) RETURNING id`,
      [ADMIN_EMAIL, hash],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`,
      [tenantAdminId, tenantOrg],
    );

    const app = (await import("../app")).default;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;

    expect((await api("op", "POST", "/auth/login", { email: OP_EMAIL, password: PW })).status).toBe(200);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  it("the operator IS an operator — the reach surface answers them", async () => {
    // Anti-vacuity for everything below: if the session were simply broken,
    // every refusal would pass for the wrong reason.
    expect((await api("op", "GET", "/operator/applications")).status).toBe(200);
  });

  it("and holds NO membership anywhere — the premise M11.3 rests on", async () => {
    expect(await membershipCount(operatorId)).toBe(0);
  });

  it("🔴 CANNOT add THEMSELVES to a tenant as admin (the inversion of M11.3)", async () => {
    const r = await api("op", "POST", `/orgs/${tenantOrg}/members`, {
      userId: operatorId,
      role: "admin",
    });
    // 403 from assertOrgAdmin: the operator is not an admin of this org, and
    // operator status is not consulted there at all.
    expect(r.status).toBe(403);
    expect(await membershipCount(operatorId)).toBe(0);
  });

  it("🔴 CANNOT add anyone else to a tenant either", async () => {
    const r = await api("op", "POST", `/orgs/${tenantOrg}/members`, {
      userId: tenantAdminId,
      role: "viewer",
    });
    expect(r.status).toBe(403);
  });

  it("🔴 CANNOT list a tenant's members", async () => {
    expect((await api("op", "GET", `/orgs/${tenantOrg}/members`)).status).toBe(403);
  });

  it("🔴 CANNOT change a tenant member's role, nor remove them", async () => {
    expect((await api("op", "PATCH", `/orgs/${tenantOrg}/members/${tenantAdminId}`, { role: "viewer" })).status).toBe(403);
    expect((await api("op", "DELETE", `/orgs/${tenantOrg}/members/${tenantAdminId}`)).status).toBe(403);
  });

  it("🔴 CANNOT reach the user-administration surface (no administered org)", async () => {
    // requireAdminScope: operator status is not an admin membership anywhere.
    expect((await api("op", "GET", "/auth/users")).status).toBe(403);
    expect((await api("op", "POST", `/auth/users/${tenantAdminId}/reset-password`, { newPassword: "OwnedByOp123!" })).status).toBe(403);
    // The tenant admin's password is untouched.
    expect((await api("ta", "POST", "/auth/login", { email: ADMIN_EMAIL, password: PW })).status).toBe(200);
  });

  it("🔴 CANNOT invite into a tenant", async () => {
    const r = await api("op", "POST", `/orgs/${tenantOrg}/invitations`, {
      email: "optb-invitee@test.local",
      role: "admin",
    });
    expect(r.status).toBe(403);
  });

  it("🔴 CANNOT read the tenant's security events", async () => {
    expect((await api("op", "GET", `/orgs/${tenantOrg}/security-events`)).status).toBe(403);
  });

  it("🔴 business routes stay closed — resolveTenant has no membership to resolve", async () => {
    for (const path of ["/invoices", "/customers", "/reports/trial-balance", "/summary"]) {
      const r = await api("op", "GET", path);
      expect([403, 404], `${path} leaked to an operator with ${r.status}`).toContain(r.status);
    }
  });

  it("ANTI-VACUITY: the same calls SUCCEED for the tenant's own admin", async () => {
    // Without this, every refusal above could mean "these routes refuse
    // everyone", which would prove nothing about operator status.
    expect((await api("ta", "POST", "/auth/login", { email: ADMIN_EMAIL, password: PW })).status).toBe(200);
    expect((await api("ta", "GET", `/orgs/${tenantOrg}/members`)).status).toBe(200);
    expect((await api("ta", "GET", "/auth/users")).status).toBe(200);
  });
});
