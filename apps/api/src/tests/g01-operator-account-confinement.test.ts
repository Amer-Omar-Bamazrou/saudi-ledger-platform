/**
 * G01 (pre-Phase-18 hardening, owner decision D-0, 2026-10-07) — a tenant
 * admin must never gain control of a PLATFORM-OPERATOR account.
 *
 * 🔴 THE DEFECT. `lib/accountScope.ts` decides whether an admin may act on an
 * account by CONFINEMENT: every membership the account holds must lie inside
 * organizations the actor administers. An operator holds NO membership by
 * design (M11.3), so the rule was vacuously satisfied — the one account on the
 * platform with cross-tenant authority was the one account every tenant admin
 * could treat as "theirs": attach it to their own organization, then reach it
 * through the org-scoped user-administration surface. Operator status lives in
 * `platform_operators`, which no tenant-side guard consulted.
 *
 * THE RULE THESE TESTS HOLD: operator authority is outside every tenant's
 * reach, at three layers —
 *   1. confinement (`assertAccountConfinedTo`) treats operator status as a
 *      foothold outside every tenant, so assignment, user administration and
 *      password reset all refuse an operator target, concealed exactly like a
 *      nonexistent id;
 *   2. the invitation path refuses an operator acceptor before anything is
 *      claimed;
 *   3. the DATABASE refuses a membership row for an operator, and refuses
 *      operator status for an account that holds a membership — the M11.3
 *      premise ("an operator is a member of nothing") becomes a constraint,
 *      not a convention.
 *
 * Legitimate operator functionality is asserted alongside (the reach surface
 * and the break-glass reset still answer the operator), so no refusal here can
 * pass because the surface simply refuses everyone.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3109";
process.env.SESSION_SECRET ??= "g01-operator-confinement-test-session-secret-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { membersService } from "../services/members.service";
import { userAdminService } from "../services/userAdmin.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[g01-operator-account-confinement] no real DATABASE_URL — skipping.");
}

const PW = "G01ConfinePw123!";
const P = "g01oc";
const email = (k: string) => `${P}-${k}@test.local`;

describeMaybe("G01 — a tenant admin cannot gain control of a platform-operator account", () => {
  let server: http.Server;
  let base = "";
  let tenantOrg = "";
  let otherOrg = "";
  const ids: Record<string, number> = {};

  const ORG_FILTER = `(SELECT id FROM organizations WHERE slug LIKE '${P}-%')`;
  const USER_FILTER = `(SELECT id FROM users WHERE email LIKE '${P}-%')`;

  const cleanup = async () => {
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(
      `DELETE FROM security_audit_logs WHERE organization_id IN ${ORG_FILTER} OR actor_user_id IN ${USER_FILTER} OR target_user_id IN ${USER_FILTER}`,
    );
    await pool.query(`DELETE FROM organization_invitations WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM organizations WHERE slug LIKE '${P}-%'`);
    await pool.query(`DELETE FROM platform_operators WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM users WHERE email LIKE '${P}-%'`);
  };

  const jar: Record<string, string> = {};
  async function api(who: string, method: string, path: string, body?: unknown) {
    const cookie = jar[who] ?? "";
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sid = ((res.headers as any).getSetCookie?.() ?? []).find((c: string) => c.startsWith("ksa_ledger_sid="));
    if (sid) jar[who] = sid.split(";")[0];
    let json: any;
    try { json = await res.json(); } catch { json = undefined; }
    return { status: res.status, body: json };
  }
  const login = async (who: string, pw = PW) => {
    delete jar[who];
    return (await api(who, "POST", "/auth/login", { email: email(who), password: pw })).status;
  };

  const membershipCount = async (userId: number) =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM organization_memberships WHERE user_id = $1`, [userId])).rows[0].n);
  const passwordHashOf = async (userId: number) =>
    (await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [userId])).rows[0].password_hash as string;

  async function user(key: string, orgId: string | null, role: string) {
    const hash = await bcrypt.hash(PW, 4);
    const id = (await pool.query(
      `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`,
      [email(key), key, hash],
    )).rows[0].id as number;
    if (orgId) {
      await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,'active')`, [id, orgId, role]);
    }
    ids[key] = id;
    return id;
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    tenantOrg = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('G01 Tenant','${P}-tenant','approved') RETURNING id`)).rows[0].id;
    otherOrg = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('G01 Other','${P}-other','approved') RETURNING id`)).rows[0].id;
    await user("admin", tenantOrg, "admin");
    await user("accountant", tenantOrg, "accountant");
    await user("bookkeeper", tenantOrg, "bookkeeper");
    await user("viewer", tenantOrg, "viewer");
    await user("otheradmin", otherOrg, "admin");
    await user("othermember", otherOrg, "bookkeeper");
    await user("op", null, "viewer");
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [ids.op]);

    const app = (await import("../app")).default;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;

    for (const who of ["admin", "accountant", "bookkeeper", "viewer", "otheradmin", "op"]) {
      expect(await login(who), `login as ${who}`).toBe(200);
    }
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  it("PREMISES: the operator is an operator, holds no membership, and the tenant admin IS an admin (anti-vacuity)", async () => {
    expect((await api("op", "GET", "/operator/applications")).status).toBe(200);
    expect(await membershipCount(ids.op)).toBe(0);
    expect((await api("admin", "GET", `/orgs/${tenantOrg}/members`)).status).toBe(200);
    // The assignment surface WORKS for an ordinary account the admin may take:
    // a fresh account with no membership is assignable (201), so the refusals
    // below are about the operator, not a broken route.
    const fresh = await user("fresh", null, "viewer");
    expect((await api("admin", "POST", `/orgs/${tenantOrg}/members`, { userId: fresh, role: "viewer" })).status).toBe(201);
  });

  it("🔴 the tenant admin CANNOT attach the operator to their organization — refused exactly like a nonexistent id", async () => {
    const attempt = await api("admin", "POST", `/orgs/${tenantOrg}/members`, { userId: ids.op, role: "admin" });
    const nonexistent = await api("admin", "POST", `/orgs/${tenantOrg}/members`, { userId: 2_000_000_000, role: "admin" });
    expect(attempt.status, "operator target must be refused").toBe(404);
    expect(attempt.body, "the refusal must not distinguish an operator from a missing id").toEqual(nonexistent.body);
    expect(await membershipCount(ids.op)).toBe(0);
  });

  it("🔴 CROSS-ORG: another organization's admin cannot attach the operator either", async () => {
    const attempt = await api("otheradmin", "POST", `/orgs/${otherOrg}/members`, { userId: ids.op, role: "viewer" });
    expect(attempt.status).toBe(404);
    expect(await membershipCount(ids.op)).toBe(0);
  });

  it("non-admin roles (accountant, bookkeeper, viewer) are refused at the admin check", async () => {
    for (const who of ["accountant", "bookkeeper", "viewer"]) {
      const r = await api(who, "POST", `/orgs/${tenantOrg}/members`, { userId: ids.op, role: "admin" });
      expect(r.status, `${who} must be refused`).toBe(403);
      expect((await api(who, "POST", `/auth/users/${ids.op}/reset-password`, { newPassword: "Owned-by-tenant-123!" })).status).not.toBe(200);
    }
    expect(await membershipCount(ids.op)).toBe(0);
  });

  it("🔴 CONCURRENT: parallel attachment attempts all fail and leave no membership", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api("admin", "POST", `/orgs/${tenantOrg}/members`, { userId: ids.op, role: i % 2 ? "admin" : "viewer" }),
      ),
    );
    expect(results.map((r) => r.status).filter((s) => s === 201), "no attempt may succeed").toEqual([]);
    expect(await membershipCount(ids.op)).toBe(0);
  });

  it("🔴 the tenant admin CANNOT reset, rename or deactivate the operator's account", async () => {
    const hashBefore = await passwordHashOf(ids.op);
    const reset = await api("admin", "POST", `/auth/users/${ids.op}/reset-password`, { newPassword: "Owned-by-tenant-123!" });
    expect(reset.status).toBe(404);
    const patch = await api("admin", "PATCH", `/auth/users/${ids.op}`, { isActive: false });
    expect(patch.status).toBe(404);
    expect(await passwordHashOf(ids.op), "the operator's password is untouched").toBe(hashBefore);
    // The operator still signs in with their own password, and still operates.
    expect(await login("op")).toBe(200);
    expect((await api("op", "GET", "/operator/applications")).status).toBe(200);
  });

  it("🔴 SERVICE LAYER (direct invocation, no HTTP): assignment and reset refuse an operator target", async () => {
    await expect(membersService.assign(ids.admin, tenantOrg, ids.op, "admin")).rejects.toMatchObject({ statusCode: 404 });
    await expect(userAdminService.resetPassword(ids.admin, ids.op, "Owned-by-tenant-123!")).rejects.toMatchObject({ statusCode: 404 });
    expect(await membershipCount(ids.op)).toBe(0);
  });

  it("🔴 INVITATION: an operator cannot accept a tenant's invitation, and the invitation is not consumed", async () => {
    const sent = await api("admin", "POST", `/orgs/${tenantOrg}/invitations`, { email: email("op"), role: "admin" });
    expect(sent.status).toBe(201);
    const token = new URL(sent.body.link).searchParams.get("token")!;
    const accepted = await api("op", "POST", `/invitations/${token}/accept`, {});
    expect(accepted.status).toBe(403);
    expect(await membershipCount(ids.op)).toBe(0);
    const { rows } = await pool.query(`SELECT status FROM organization_invitations WHERE id = $1`, [sent.body.id]);
    expect(rows[0].status).toBe("pending");
  });

  it("🔴 DATABASE: a membership row for an operator is refused, whoever writes it", async () => {
    await expect(
      pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [ids.op, tenantOrg]),
    ).rejects.toMatchObject({ code: "23514" });
    // …including by re-pointing an existing membership at the operator.
    await expect(
      pool.query(`UPDATE organization_memberships SET user_id = $1 WHERE user_id = $2 AND organization_id = $3`, [ids.op, ids.viewer, tenantOrg]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await membershipCount(ids.op)).toBe(0);
  });

  it("🔴 DATABASE: operator status cannot be granted to an account that holds a membership", async () => {
    await expect(
      pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [ids.accountant]),
    ).rejects.toMatchObject({ code: "23514" });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM platform_operators WHERE user_id = $1`, [ids.accountant]);
    expect(rows[0].n).toBe(0);
  });

  it("🔴 DATABASE, CONCURRENT: a membership and an operator grant racing for ONE account cannot both commit — either order", async () => {
    const operatorCount = async (uid: number) =>
      Number((await pool.query(`SELECT count(*)::int AS n FROM platform_operators WHERE user_id = $1`, [uid])).rows[0].n);
    const race = async (first: string, second: string, uid: number) => {
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query("BEGIN");
        await a.query(first, [uid, tenantOrg].slice(0, first.includes("$2") ? 2 : 1));
        await b.query("BEGIN");
        const pending = b.query(second, [uid, tenantOrg].slice(0, second.includes("$2") ? 2 : 1));
        let settled = false;
        pending.then(() => { settled = true; }, () => { settled = true; });
        await new Promise((r) => setTimeout(r, 400));
        expect(settled, "the second writer must WAIT for the first transaction").toBe(false);
        await a.query("COMMIT");
        await expect(pending, "the second writer must see the first and be refused").rejects.toMatchObject({ code: "23514" });
        await b.query("ROLLBACK");
      } finally {
        a.release();
        b.release();
      }
    };
    const MEMBERSHIP = `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'viewer','active')`;
    const GRANT = `INSERT INTO platform_operators (user_id) VALUES ($1)`;

    const m1 = await user("race-m-first", null, "viewer");
    await race(MEMBERSHIP, GRANT, m1);
    expect(await membershipCount(m1)).toBe(1);
    expect(await operatorCount(m1)).toBe(0);

    const g1 = await user("race-g-first", null, "viewer");
    await race(GRANT, MEMBERSHIP, g1);
    expect(await operatorCount(g1)).toBe(1);
    expect(await membershipCount(g1)).toBe(0);
  });

  it("BREAK-GLASS after the failed attempts: the tenant admin cannot use it; the operator still can, on a tenant user", async () => {
    expect((await api("admin", "POST", "/operator/users/reset-password", { email: email("othermember") })).status).toBe(403);
    const r = await api("op", "POST", "/operator/users/reset-password", { email: email("othermember") });
    expect(r.status).toBe(200);
    expect(typeof r.body.temporaryPassword).toBe("string");
    expect(await login("othermember", r.body.temporaryPassword)).toBe(200);
    // The operator-to-operator refusal is unchanged.
    expect((await api("op", "POST", "/operator/users/reset-password", { email: email("op") })).status).toBe(403);
  });
});
