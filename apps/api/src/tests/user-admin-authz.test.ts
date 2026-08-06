/**
 * M11.5.1 SECURITY HOTFIX — regression suite for CRITICAL-1.
 *
 * THE VULNERABILITY (found in the post-M11.5 audit, confirmed three times):
 * public `/auth/signup` wrote `users.role = "admin"` and stamped
 * `session.userRole = "admin"`. `/auth/*` is mounted BEFORE resolveTenant, and
 * its user-administration endpoints were guarded only by that ambient GLOBAL
 * role with NO organization filter — so ANY anonymous person could sign up and
 * then:
 *   - GET /auth/users                     → dump every user on the platform
 *   - POST /auth/users/:id/reset-password → take over ANY account (incl. other
 *                                           tenants' admins and the operator)
 *   - PATCH /auth/users/:id               → rewrite any user's global role
 *
 * These tests assert the fix from BOTH directions:
 *   A. a self-signup user is DENIED the user-administration surface, and
 *   B. even a LEGITIMATE org admin is confined to their OWN organization
 *      (the cross-tenant half of the flaw, which predated signup).
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3104";
process.env.SESSION_SECRET ??= "user-admin-authz-test-session-secret-0123456789ab";
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
  console.warn("[user-admin-authz] no real DATABASE_URL — skipping.");
}

const PW = "AuthzTestPw123!";
const MEMBER_NEW_PW = "FreshPw12345!";
const SIGNUP_EMAIL = "authztest-attacker@test.local";
const VICTIM_EMAIL = "authztest-victim-admin@test.local";
const VICTIM_MEMBER_EMAIL = "authztest-victim-member@test.local";

describeMaybe("M11.5.1 — user-administration authorization (CRITICAL-1 regression)", () => {
  let server: http.Server;
  let base = "";
  let victimAdminId = 0;
  let victimMemberId = 0;
  let victimOrg = "";
  let attackerUserId = 0;

  const ORG_FILTER = `(SELECT id FROM organizations WHERE slug LIKE 'authztest%' OR name LIKE 'AuthzTest%')`;
  const USER_FILTER = `(SELECT id FROM users WHERE email LIKE 'authztest-%')`;

  const cleanup = async () => {
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM security_audit_logs WHERE organization_id IN ${ORG_FILTER} OR actor_user_id IN ${USER_FILTER} OR target_user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM verification_reviews WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM organizations WHERE slug LIKE 'authztest%' OR name LIKE 'AuthzTest%'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'authztest-%'`);
  };

  const jar: Record<string, string> = {};
  async function api(who: string | null, method: string, path: string, body?: unknown) {
    const cookie = who ? jar[who] ?? "" : "";
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sid = ((res.headers as any).getSetCookie?.() ?? []).find((c: string) => c.startsWith("ksa_ledger_sid="));
    if (sid && who) jar[who] = sid.split(";")[0];
    let json: any; try { json = await res.json(); } catch { json = undefined; }
    return { status: res.status, body: json };
  }
  const login = (who: string, email: string) => api(who, "POST", "/auth/login", { email, password: PW });

  beforeAll(async () => {
    // Suites share one process-global, IP-keyed rate-limit budget; start clean
    // so another suite\'s signups cannot 429 this one. See auth.ts.
    __resetRateLimitsForTests();
    await cleanup();

    // A legitimate, APPROVED victim organization with an admin and a member.
    victimOrg = (await pool.query(
      `INSERT INTO organizations (name, slug, verification_status) VALUES ('AuthzTest Victim','authztest-victim','approved') RETURNING id`,
    )).rows[0].id;
    const hash = await bcrypt.hash(PW, 12);
    victimAdminId = (await pool.query(
      `INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,'Victim Admin',$2,'admin',true) RETURNING id`,
      [VICTIM_EMAIL, hash],
    )).rows[0].id;
    victimMemberId = (await pool.query(
      `INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,'Victim Member',$2,'viewer',true) RETURNING id`,
      [VICTIM_MEMBER_EMAIL, hash],
    )).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`, [victimAdminId, victimOrg]);
    await pool.query(`INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'bookkeeper','active')`, [victimMemberId, victimOrg]);

    const app = (await import("../app")).default;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  // ── A. The attacker: a fresh self-service signup ──────────────────────────
  describe("a self-signup user CANNOT reach the user-administration surface", () => {
    it("signs up successfully (the org is pending_review)", async () => {
      const r = await api("attacker", "POST", "/auth/signup", {
        email: SIGNUP_EMAIL, name: "Attacker", password: PW,
        organizationName: "AuthzTest Attacker", crNumber: "1010303030",
      });
      expect(r.status).toBe(201);
      attackerUserId = r.body.user.id;
    });

    it("does NOT receive the global admin role (the root cause)", async () => {
      const row = await pool.query(`SELECT role FROM users WHERE email = $1`, [SIGNUP_EMAIL]);
      expect(row.rows[0].role).not.toBe("admin");

      // ...but IS an admin of their OWN organization — that is where their real
      // authority lives, and it must be preserved.
      const m = await pool.query(
        `SELECT m.role FROM organization_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
        [SIGNUP_EMAIL],
      );
      expect(m.rows[0].role).toBe("admin");
    });

    it("CRITICAL: is DENIED GET /auth/users (no platform-wide identity dump)", async () => {
      const r = await api("attacker", "GET", "/auth/users");
      expect(r.status).toBe(403);
    });

    it("CRITICAL: is DENIED POST /auth/users/:id/reset-password (no account takeover)", async () => {
      const r = await api("attacker", "POST", `/auth/users/${victimAdminId}/reset-password`, { newPassword: "AttackerOwned123!" });
      expect(r.status).toBe(403);

      // Prove the victim's password was NOT changed — they can still log in.
      expect((await login("victim", VICTIM_EMAIL)).status).toBe(200);
    });

    it("CRITICAL: is DENIED PATCH /auth/users/:id (no role rewrite)", async () => {
      const r = await api("attacker", "PATCH", `/auth/users/${victimAdminId}`, { role: "viewer", isActive: false });
      expect(r.status).toBe(403);

      const row = await pool.query(`SELECT role, is_active FROM users WHERE id = $1`, [victimAdminId]);
      expect(row.rows[0]).toMatchObject({ role: "admin", is_active: true });
    });

    it("is DENIED even for its OWN organization while unverified (no email squatting)", async () => {
      // The attacker IS an admin of their own org — but that org is pending
      // review, so the user-administration surface stays closed to them.
      const r = await api("attacker", "GET", "/auth/users");
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/verified organization/i);
    });

    it("is DENIED POST /auth/register (cannot mint accounts)", async () => {
      const r = await api("attacker", "POST", "/auth/register", {
        email: "authztest-minted@test.local", name: "Minted", password: PW, role: "admin",
      });
      expect(r.status).toBe(403);
    });
  });

  // ── B. A legitimate org admin is confined to their own organization ───────
  describe("a legitimate org admin is ORG-SCOPED (the cross-tenant half)", () => {
    it("can list users — but ONLY their own organization's members", async () => {
      expect((await login("victim", VICTIM_EMAIL)).status).toBe(200);
      const r = await api("victim", "GET", "/auth/users");
      expect(r.status).toBe(200);

      const emails = (r.body as Array<{ email: string }>).map((u) => u.email);
      expect(emails).toContain(VICTIM_EMAIL);
      expect(emails).toContain(VICTIM_MEMBER_EMAIL);
      // The attacker belongs to a DIFFERENT org — must not be visible.
      expect(emails).not.toContain(SIGNUP_EMAIL);
    });

    it("CANNOT reset the password of a user outside their organization (404)", async () => {
      const r = await api("victim", "POST", `/auth/users/${attackerUserId}/reset-password`, { newPassword: "NotYours123!" });
      expect(r.status).toBe(404); // 404 not 403 — don't confirm out-of-scope users exist

      expect((await login("attacker2", SIGNUP_EMAIL)).status).toBe(200); // password unchanged
    });

    it("CANNOT modify a user outside their organization (404)", async () => {
      const r = await api("victim", "PATCH", `/auth/users/${attackerUserId}`, { isActive: false });
      expect(r.status).toBe(404);
    });

    it("CAN manage a user inside their own organization", async () => {
      const r = await api("victim", "PATCH", `/auth/users/${victimMemberId}`, { role: "accountant" });
      expect(r.status).toBe(200);
      expect(r.body.role).toBe("accountant");

      const reset = await api("victim", "POST", `/auth/users/${victimMemberId}/reset-password`, { newPassword: MEMBER_NEW_PW });
      expect(reset.status).toBe(200);
      // The reset really took effect (and the old password no longer works).
      expect((await api("member", "POST", "/auth/login", { email: VICTIM_MEMBER_EMAIL, password: PW })).status).toBe(401);
    });

    it("rejects an invalid role on PATCH (enum validation)", async () => {
      const r = await api("victim", "PATCH", `/auth/users/${victimMemberId}`, { role: "superuser" });
      expect(r.status).toBe(400);
    });

    it("a user with NO admin membership is denied entirely", async () => {
      // Log in with the password the admin just set (proves the reset worked).
      const r = await api("member", "POST", "/auth/login", { email: VICTIM_MEMBER_EMAIL, password: MEMBER_NEW_PW });
      expect(r.status).toBe(200);
      // This account is an 'accountant' in its org, not an admin.
      expect((await api("member", "GET", "/auth/users")).status).toBe(403);
    });
  });
});
