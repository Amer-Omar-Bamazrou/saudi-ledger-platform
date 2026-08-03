/**
 * Platform operator + review boundary (M11.3) — the SECURITY-SENSITIVE acceptance
 * suite. Proves:
 *   A. The review state machine: approve / reject / request-info / reopen with
 *      fail-closed guards, each writing a verification_reviews row AND a
 *      security_audit_logs event (operator id + target org). `rejected` is
 *      terminal-by-default (no approve from rejected); `reopen` (rejected →
 *      needs_info) is the mistake-correction path.
 *   B. requirePlatformOperator: operator → next; non-operator → 403; anon → 401.
 *      And resolveTenant blocks an operator (no membership) from business routes.
 *   C. End-to-end boundary: an operator gets ZERO access to tenant financial data
 *      through any business route, a non-operator cannot reach /operator, and the
 *      operator surface returns only verification metadata.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

// app.ts calls loadEnv() at import; provide the vars CI's test job doesn't set.
process.env.PORT ??= "3101";
process.env.SESSION_SECRET ??= "operator-boundary-test-session-secret-key-0123456789";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import { requirePlatformOperator } from "../lib/operator";
import { resolveTenant } from "../lib/tenant";
import { operatorService } from "../services/operator.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[operator] no real DATABASE_URL — skipping operator boundary tests.");
}

const OP_PW = "OperatorPw123!";
const ADMIN_PW = "AdminPw123!";

describeMaybe("platform operator + verification review boundary (M11.3)", () => {
  let operatorId = 0;
  let adminId = 0;
  let adminOrg = "";
  let e2eAppOrg = "";
  let appSeq = 0;

  const ORG_FILTER = `(SELECT id FROM organizations WHERE slug LIKE 'optest-%')`;
  const USER_FILTER = `(SELECT id FROM users WHERE email LIKE 'optest-%')`;

  const cleanup = async () => {
    await pool.query(`DELETE FROM security_audit_logs WHERE organization_id IN ${ORG_FILTER} OR actor_user_id IN ${USER_FILTER} OR target_user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM verification_reviews WHERE organization_id IN ${ORG_FILTER} OR operator_user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM organizations WHERE slug LIKE 'optest-%'`);
    await pool.query(`DELETE FROM platform_operators WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'optest-%'`);
  };

  const mkUser = async (email: string, pw: string) =>
    (await pool.query(
      `INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,$1,$2,'viewer',true) RETURNING id`,
      [email, await bcrypt.hash(pw, 12)],
    )).rows[0].id as number;

  const mkApp = async (status = "pending_review", reason: string | null = null) => {
    const slug = `optest-app-${++appSeq}`;
    return (await pool.query(
      `INSERT INTO organizations (name, slug, verification_status, verification_reason) VALUES ($1,$1,$2,$3) RETURNING id`,
      [slug, status, reason],
    )).rows[0].id as string;
  };

  const orgStatus = async (orgId: string) =>
    (await pool.query(`SELECT verification_status AS s FROM organizations WHERE id = $1`, [orgId])).rows[0].s as string;
  const secEvents = async (orgId: string) =>
    (await pool.query(`SELECT action FROM security_audit_logs WHERE organization_id = $1`, [orgId])).rows.map((r) => r.action as string);
  const reviewCount = async (orgId: string) =>
    Number((await pool.query(`SELECT count(*)::int AS c FROM verification_reviews WHERE organization_id = $1`, [orgId])).rows[0].c);

  beforeAll(async () => {
    await cleanup();
    operatorId = await mkUser("optest-operator@test.local", OP_PW);
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [operatorId]);

    adminId = await mkUser("optest-admin@test.local", ADMIN_PW);
    adminOrg = await mkApp("approved");
    await pool.query(`INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`, [adminId, adminOrg]);

    e2eAppOrg = await mkApp("pending_review", "Please upload your CR.");
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── A. Review state machine ───────────────────────────────────────────────
  describe("review state machine (guards + audit + history)", () => {
    it("approve: pending_review → approved, with a review row + audit event", async () => {
      const org = await mkApp("pending_review");
      const out = await operatorService.approve(operatorId, org, { actorEmail: "optest-operator@test.local", ipAddress: "203.0.113.9" });
      expect(out.status).toBe("approved");
      expect(await orgStatus(org)).toBe("approved");
      expect(await reviewCount(org)).toBe(1);
      expect(await secEvents(org)).toContain("verification.approved");
    });

    it("reject: requires a reason (400), then pending_review → rejected", async () => {
      const org = await mkApp("pending_review");
      await expect(operatorService.reject(operatorId, org, "  ")).rejects.toMatchObject({ statusCode: 400 });
      const out = await operatorService.reject(operatorId, org, "Ineligible entity type.");
      expect(out.status).toBe("rejected");
      expect(await secEvents(org)).toContain("verification.rejected");
    });

    it("rejected is terminal-by-default: cannot approve from rejected (409)", async () => {
      const org = await mkApp("rejected", "was rejected");
      await expect(operatorService.approve(operatorId, org)).rejects.toMatchObject({ statusCode: 409 });
    });

    it("reopen: rejected → needs_info (mistake correction); non-rejected reopen is 409", async () => {
      const rejected = await mkApp("rejected", "mis-click");
      const out = await operatorService.reopen(operatorId, rejected, "Reopened — reviewed the wrong org.");
      expect(out.status).toBe("needs_info");
      expect(await secEvents(rejected)).toContain("verification.reopened");

      const pending = await mkApp("pending_review");
      await expect(operatorService.reopen(operatorId, pending, "nope")).rejects.toMatchObject({ statusCode: 409 });
    });

    it("request-info: pending_review → needs_info with a reason", async () => {
      const org = await mkApp("pending_review");
      const out = await operatorService.requestInfo(operatorId, org, "CR number is unreadable.");
      expect(out.status).toBe("needs_info");
      expect(await secEvents(org)).toContain("verification.needs_info");
    });

    it("getApplication returns verification metadata (company CR/VAT + reviews) and audits the view", async () => {
      const org = await mkApp("pending_review");
      await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'Applicant Co','1010101010','300000000000003')`, [org]);
      const detail = await operatorService.getApplication(operatorId, org, { actorEmail: "optest-operator@test.local" });
      expect(detail.companies[0]).toMatchObject({ crNumber: "1010101010", vatNumber: "300000000000003" });
      expect(Array.isArray(detail.reviews)).toBe(true);
      expect(await secEvents(org)).toContain("verification.application_viewed");
    });

    it("unknown application → 404", async () => {
      await expect(
        operatorService.approve(operatorId, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // ── B. Middleware boundaries ──────────────────────────────────────────────
  describe("authorization boundaries (middleware)", () => {
    function mockRes() {
      const r = { statusCode: 0, body: undefined as any };
      return {
        res: {
          status(c: number) { r.statusCode = c; return this; },
          json(b: unknown) { r.body = b; return this; },
          on() { return this; },
        } as any,
        r,
      };
    }

    it("requirePlatformOperator: operator → next; non-operator → 403; anon → 401", async () => {
      const op = mockRes(); let opNext = false;
      await requirePlatformOperator({ session: { userId: operatorId }, log: { error() {} } } as any, op.res, () => { opNext = true; });
      expect(opNext).toBe(true);

      const nonOp = mockRes(); let nonNext = false;
      await requirePlatformOperator({ session: { userId: adminId }, log: { error() {} } } as any, nonOp.res, () => { nonNext = true; });
      expect(nonNext).toBe(false);
      expect(nonOp.r.statusCode).toBe(403);

      const anon = mockRes(); let anonNext = false;
      await requirePlatformOperator({ session: {}, log: { error() {} } } as any, anon.res, () => { anonNext = true; });
      expect(anonNext).toBe(false);
      expect(anon.r.statusCode).toBe(401);
    });

    it("resolveTenant blocks an operator (no membership) from every business route", async () => {
      const { res, r } = mockRes(); let next = false;
      await resolveTenant({ session: { userId: operatorId }, ip: "127.0.0.1", log: { error() {} } } as any, res, () => { next = true; });
      expect(next).toBe(false);
      expect(r.statusCode).toBe(403); // "not a member of any organization"
    });
  });

  // ── C. End-to-end boundary over the real app ──────────────────────────────
  describe("end-to-end: operator gets zero tenant data; non-operator gets no /operator", () => {
    let server: http.Server;
    let base = "";
    let cookie = "";

    async function api(method: string, path: string, body?: unknown) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookies = (res.headers as any).getSetCookie?.() ?? [];
      const sid = setCookies.find((c: string) => c.startsWith("ksa_ledger_sid="));
      if (sid) cookie = sid.split(";")[0];
      let json: any; try { json = await res.json(); } catch { json = undefined; }
      return { status: res.status, body: json };
    }
    const login = (email: string, password: string) => { cookie = ""; return api("POST", "/auth/login", { email, password }); };

    beforeAll(async () => {
      const app = (await import("../app")).default;
      server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("an operator has ZERO access to any tenant business/financial route (resolveTenant 403)", async () => {
      expect((await login("optest-operator@test.local", OP_PW)).status).toBe(200);
      for (const path of ["/transactions", "/invoices", "/reports/trial-balance"]) {
        expect((await api("GET", path)).status).toBe(403);
      }
    });

    it("an operator CAN reach the /operator review surface", async () => {
      const apps = await api("GET", "/operator/applications");
      expect(apps.status).toBe(200);
      expect(Array.isArray(apps.body.applications)).toBe(true);
    });

    it("a non-operator (org admin) CANNOT reach /operator (403)", async () => {
      expect((await login("optest-admin@test.local", ADMIN_PW)).status).toBe(200);
      const apps = await api("GET", "/operator/applications");
      expect(apps.status).toBe(403);
      expect(apps.body).toMatchObject({ error: "Platform operator access required." });
    });

    it("an operator approves a pending application end-to-end (status flips)", async () => {
      expect((await login("optest-operator@test.local", OP_PW)).status).toBe(200);
      const approve = await api("POST", `/operator/applications/${e2eAppOrg}/approve`);
      expect(approve.status).toBe(200);
      expect(approve.body.status).toBe("approved");
      expect(await orgStatus(e2eAppOrg)).toBe("approved");
    });
  });
});
