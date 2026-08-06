/**
 * Public self-service signup + applicant resubmit (M11.5).
 *
 * Proves the full onboarding loop end-to-end over the real Express app:
 *   signup (atomic org+company+user+membership, pending_review, logged in)
 *   → gated out of every business route
 *   → operator requests info → applicant resubmits → operator approves
 *   → the org now has full access.
 * Plus validation (CR/VAT format, weak password), duplicate email → 409, and
 * atomicity (a failed signup leaves NO partial rows).
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3103";
process.env.SESSION_SECRET ??= "signup-test-session-secret-key-0123456789abcdefgh";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { signupService } from "../services/signup.service";
import { __resetRateLimitsForTests } from "../routes/auth";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[signup] no real DATABASE_URL — skipping signup tests.");
}

const PW = "SignupPw123!";
const APPLICANT = "signuptest-founder@test.local";
const OPERATOR = "signuptest-operator@test.local";

describeMaybe("public signup + applicant resubmit (M11.5)", () => {
  let server: http.Server;
  let base = "";
  let operatorId = 0;
  let orgId = "";

  const ORG_FILTER = `(SELECT id FROM organizations WHERE slug LIKE 'signuptest%' OR name LIKE 'SignupTest%')`;
  const USER_FILTER = `(SELECT id FROM users WHERE email LIKE 'signuptest-%')`;

  const cleanup = async () => {
    // Business audit rows too: the post-approval transaction write is audited,
    // and audit_logs.organization_id FKs to organizations.
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM security_audit_logs WHERE organization_id IN ${ORG_FILTER} OR actor_user_id IN ${USER_FILTER} OR target_user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM verification_reviews WHERE organization_id IN ${ORG_FILTER} OR operator_user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM verification_documents WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM platform_operators WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM organizations WHERE slug LIKE 'signuptest%' OR name LIKE 'SignupTest%'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'signuptest-%'`);
  };

  // Cookie jars: the applicant and the operator hold separate sessions.
  const jar = { applicant: "", operator: "" };
  type Who = keyof typeof jar;

  async function api(who: Who | null, method: string, path: string, body?: unknown) {
    const cookie = who ? jar[who] : "";
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

  const validSignup = (over: Record<string, unknown> = {}) => ({
    email: APPLICANT, name: "Test Founder", password: PW,
    organizationName: "SignupTest Trading", companyName: "SignupTest Trading Co",
    crNumber: "1010101010", vatNumber: "300000000000003", ...over,
  });

  const orgStatus = async () =>
    (await pool.query(`SELECT verification_status AS s FROM organizations WHERE id = $1`, [orgId])).rows[0]?.s as string;

  beforeAll(async () => {
    // Suites share one process-global, IP-keyed rate-limit budget; start clean
    // so another suite\'s signups cannot 429 this one. See auth.ts.
    __resetRateLimitsForTests();
    await cleanup();
    primePermissionCache(PERMISSION_MATRIX); // CI applies migrations but doesn't seed permissions
    operatorId = (await pool.query(
      `INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,$1,$2,'viewer',true) RETURNING id`,
      [OPERATOR, await bcrypt.hash(PW, 12)],
    )).rows[0].id;
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [operatorId]);

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

  // Validation is service logic — exercised directly so these many cases don't
  // burn the deliberately strict signup rate limit (5/hour/IP) that the HTTP
  // flow below depends on. The limiter itself is asserted at the very end.
  describe("validation + atomicity (service level)", () => {
    it("rejects a bad CR number, a bad VAT number, a weak password, bad email, missing org (400)", async () => {
      for (const over of [
        { crNumber: "123" },
        { crNumber: "" },
        { vatNumber: "12345" },
        { password: "short" },
        { email: "not-an-email" },
        { organizationName: "" },
        { name: "" },
      ]) {
        await expect(signupService.signup(validSignup(over))).rejects.toMatchObject({ statusCode: 400 });
      }
    });

    it("accepts a signup with no VAT number (not every entity is VAT-registered)", async () => {
      const out = await signupService.signup(
        validSignup({ email: "signuptest-novat@test.local", organizationName: "SignupTest NoVat", vatNumber: "" }),
      );
      expect(out.organizationId).toBeTruthy();
      const row = await pool.query(`SELECT vat_number FROM companies WHERE organization_id = $1`, [out.organizationId]);
      expect(row.rows[0].vat_number).toBeNull();
    });

    it("a rejected signup leaves NO partial rows (atomic)", async () => {
      const users = await pool.query(`SELECT count(*)::int AS c FROM users WHERE email = $1`, [APPLICANT]);
      const orgs = await pool.query(`SELECT count(*)::int AS c FROM organizations WHERE name = 'SignupTest Trading'`);
      expect(users.rows[0].c).toBe(0);
      expect(orgs.rows[0].c).toBe(0);
    });
  });

  describe("the full onboarding loop", () => {
    it("signup creates org+company+user+membership atomically, in pending_review, logged in", async () => {
      const r = await api("applicant", "POST", "/auth/signup", validSignup());
      expect(r.status).toBe(201);
      expect(r.body.verificationStatus).toBe("pending_review");
      orgId = r.body.organizationId;

      const org = await pool.query(`SELECT verification_status, verification_submitted_at FROM organizations WHERE id = $1`, [orgId]);
      expect(org.rows[0].verification_status).toBe("pending_review");
      expect(org.rows[0].verification_submitted_at).not.toBeNull();

      const company = await pool.query(`SELECT name, cr_number, vat_number FROM companies WHERE organization_id = $1`, [orgId]);
      expect(company.rows[0]).toMatchObject({ cr_number: "1010101010", vat_number: "300000000000003" });

      const membership = await pool.query(
        `SELECT m.role, m.status FROM organization_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 AND m.organization_id = $2`,
        [APPLICANT, orgId],
      );
      expect(membership.rows[0]).toMatchObject({ role: "admin", status: "active" });

      // Logged in: an authenticated-only endpoint works with the signup session.
      expect((await api("applicant", "GET", "/auth/me")).status).toBe(200);
    });

    it("duplicate email → 409", async () => {
      const r = await api(null, "POST", "/auth/signup", validSignup({ organizationName: "SignupTest Other" }));
      expect(r.status).toBe(409);
    });

    it("the new org is GATED out of business routes and sees its status page", async () => {
      const tx = await api("applicant", "POST", "/transactions", {
        date: "2026-03-01", description: "should not post", amount: 100, currency: "SAR", type: "debit",
      });
      expect(tx.status).toBe(403);
      expect(tx.body).toMatchObject({ code: "org_not_verified", status: "pending_review" });

      const status = await api("applicant", "GET", "/onboarding/status");
      expect(status.body).toMatchObject({ status: "pending_review", organizationId: orgId });
    });

    it("operator requests more info; the applicant sees the reason", async () => {
      expect((await api("operator", "POST", "/auth/login", { email: OPERATOR, password: PW })).status).toBe(200);
      const req = await api("operator", "POST", `/operator/applications/${orgId}/request-info`, { reason: "CR certificate is unreadable." });
      expect(req.status).toBe(200);
      expect(req.body.status).toBe("needs_info");

      const status = await api("applicant", "GET", "/onboarding/status");
      expect(status.body).toMatchObject({ status: "needs_info", reason: "CR certificate is unreadable." });
    });

    it("applicant resubmits: needs_info → pending_review (audited); a second resubmit is 409", async () => {
      const re = await api("applicant", "POST", "/onboarding/resubmit");
      expect(re.status).toBe(200);
      expect(re.body.status).toBe("pending_review");
      expect(await orgStatus()).toBe("pending_review");

      expect((await api("applicant", "POST", "/onboarding/resubmit")).status).toBe(409);

      const events = await pool.query(`SELECT action FROM security_audit_logs WHERE organization_id = $1`, [orgId]);
      const actions = events.rows.map((r) => r.action);
      expect(actions).toContain("signup.completed");
      expect(actions).toContain("verification.resubmitted");
      expect(actions).toContain("verification.needs_info");
    });

    it("operator approves → the org gains FULL ACCESS (the same write now posts)", async () => {
      const ap = await api("operator", "POST", `/operator/applications/${orgId}/approve`);
      expect(ap.status).toBe(200);
      expect(await orgStatus()).toBe("approved");

      const tx = await api("applicant", "POST", "/transactions", {
        date: "2026-03-01", description: "now allowed", amount: 100, currency: "SAR", type: "debit",
      });
      expect(tx.status).toBe(201);
    });
  });

  // LAST: exhausting the limiter poisons this IP for the rest of the window, so
  // it must run after every other HTTP signup assertion above.
  describe("abuse protection", () => {
    it("rate-limits repeated signup attempts from one IP (429)", async () => {
      let sawTooMany = false;
      for (let i = 0; i < 8 && !sawTooMany; i++) {
        const r = await api(null, "POST", "/auth/signup", validSignup({
          email: `signuptest-flood-${i}@test.local`, organizationName: `SignupTest Flood ${i}`,
        }));
        if (r.status === 429) sawTooMany = true;
      }
      expect(sawTooMany).toBe(true);
    });
  });
});
