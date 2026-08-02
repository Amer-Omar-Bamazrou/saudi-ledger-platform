/**
 * Verification gate (M11.2) — the SECURITY-CRITICAL acceptance suite. Treated
 * with M3/M4 rigor: a non-`approved` organization must not be able to touch ANY
 * business data through ANY route.
 *
 * Two layers of proof:
 *   A. resolveTenant middleware — the gate short-circuits with 403 {status,reason}
 *      BEFORE next() and BEFORE the tenant transaction/GUCs are opened, for
 *      pending_review / needs_info / rejected; only `approved` calls next(). This
 *      also covers the MULTI-ORG EDGE: one user who is a member of an approved
 *      AND a pending org is gated purely by which org is active.
 *   B. End-to-end over the real Express app — a logged-in user switched to a
 *      pending org gets 403 on every representative business WRITE and a reports
 *      READ, and an owner-connection query confirms ZERO rows were written to any
 *      business table; /onboarding/status + logout still work; switching to the
 *      approved org, the SAME write now posts.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

// app.ts calls loadEnv() at import; CI's test job sets only DATABASE_URL, so
// provide the rest here (before the dynamic import of the app). `??=` never
// overrides a value the environment already set.
// PORT must pass loadEnv's positive-int check; the test server itself binds an
// ephemeral port via listen(0), independent of this value.
process.env.PORT ??= "3100";
process.env.SESSION_SECRET ??= "verification-gating-test-session-secret-key-0123456789";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { resolveTenant } from "../lib/tenant";
import { primePermissionCache } from "../lib/rbac";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[verification-gating] no real DATABASE_URL — skipping gate tests.");
}

const PASSWORD = "GatePw123!";
const REASON_PENDING = "Please upload your CR certificate.";

// Business tables that must stay at ZERO rows for a pending org after write attempts.
const BUSINESS_TABLES = ["transactions", "customers", "journal_entries"] as const;

describeMaybe("verification gate — pending orgs are fully locked out (M11.2)", () => {
  let userId = 0;
  const org: Record<"approved" | "pending" | "needsInfo" | "rejected", string> = {
    approved: "", pending: "", needsInfo: "", rejected: "",
  };
  let approvedCompanyId = "";

  const cleanup = async () => {
    const orgFilter = `(SELECT id FROM organizations WHERE slug LIKE 'vgate-%')`;
    const userFilter = `(SELECT id FROM users WHERE email LIKE 'vgate-test-%')`;
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${orgFilter}`);
    await pool.query(`DELETE FROM security_audit_logs WHERE organization_id IN ${orgFilter} OR actor_user_id IN ${userFilter} OR target_user_id IN ${userFilter}`);
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${orgFilter}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${orgFilter}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${orgFilter}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${userFilter}`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'vgate-test-%'`);
    await pool.query(`DELETE FROM organizations WHERE slug LIKE 'vgate-%'`);
  };

  const mkOrg = async (slug: string, status: string, reason: string | null) =>
    (await pool.query(
      `INSERT INTO organizations (name, slug, verification_status, verification_reason) VALUES ($1,$2,$3,$4) RETURNING id`,
      [slug, slug, status, reason],
    )).rows[0].id as string;

  beforeAll(async () => {
    await cleanup();
    userId = (await pool.query(
      `INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,'Gate Tester',$2,'admin',true) RETURNING id`,
      ["vgate-test-user@test.local", await bcrypt.hash(PASSWORD, 12)],
    )).rows[0].id;

    org.approved = await mkOrg("vgate-approved", "approved", null);
    org.pending = await mkOrg("vgate-pending", "pending_review", REASON_PENDING);
    org.needsInfo = await mkOrg("vgate-needsinfo", "needs_info", "CR number is unreadable.");
    org.rejected = await mkOrg("vgate-rejected", "rejected", "Ineligible entity type.");

    for (const id of Object.values(org)) {
      await pool.query(
        `INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`,
        [userId, id],
      );
    }
    // The approved org needs a company (transactions.company_id is NOT NULL).
    approvedCompanyId = (await pool.query(
      `INSERT INTO companies (organization_id, name) VALUES ($1,'Gate Co') RETURNING id`,
      [org.approved],
    )).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── A. resolveTenant middleware: the gate seam ────────────────────────────
  describe("resolveTenant short-circuits before opening the tenant transaction", () => {
    async function run(activeOrgId: string) {
      const result = { statusCode: 200, body: undefined as any, nextCalled: false };
      const req = { session: { userId, activeOrgId }, ip: "127.0.0.1", log: { error: () => {} } } as any;
      const res = {
        status(c: number) { result.statusCode = c; return this; },
        json(b: unknown) { result.body = b; return this; },
        on() { return this; },
      } as any;
      await resolveTenant(req, res, () => { result.nextCalled = true; });
      return { ...result, tenant: req.tenant };
    }

    it("APPROVED org → calls next() with a tenant context (no 403)", async () => {
      const r = await run(org.approved);
      expect(r.nextCalled).toBe(true);
      expect(r.statusCode).toBe(200);
      expect(r.tenant?.organizationId).toBe(org.approved);
    });

    for (const [key, status] of [
      ["pending", "pending_review"],
      ["needsInfo", "needs_info"],
      ["rejected", "rejected"],
    ] as const) {
      it(`${status} org → 403 {status,reason}, next() NOT called, no tenant context`, async () => {
        const r = await run(org[key]);
        expect(r.nextCalled).toBe(false);
        expect(r.statusCode).toBe(403);
        expect(r.body).toMatchObject({ code: "org_not_verified", status });
        expect(r.tenant).toBeUndefined();
      });
    }

    it("MULTI-ORG EDGE: same user is gated by which org is active", async () => {
      expect((await run(org.pending)).statusCode).toBe(403); // switched to pending → locked
      expect((await run(org.approved)).nextCalled).toBe(true); // switched to approved → allowed
      const pending = await run(org.pending);
      expect(pending.body).toMatchObject({ status: "pending_review", reason: REASON_PENDING });
    });
  });

  // ── B. End-to-end over the real app ───────────────────────────────────────
  describe("end-to-end: a pending org cannot write, an approved org can", () => {
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
      let json: any;
      try { json = await res.json(); } catch { json = undefined; }
      return { status: res.status, body: json };
    }

    const login = () => api("POST", "/auth/login", { email: "vgate-test-user@test.local", password: PASSWORD });
    const switchOrg = (organizationId: string) => api("POST", "/orgs/switch", { organizationId });
    const txBody = (description: string) => ({ date: "2026-03-01", description, amount: 250, currency: "SAR", type: "debit" });

    async function orgRowCounts(orgId: string): Promise<Record<string, number>> {
      const out: Record<string, number> = {};
      for (const t of BUSINESS_TABLES) {
        out[t] = Number(
          (await pool.query(`SELECT count(*)::int AS c FROM ${t} WHERE organization_id = $1`, [orgId])).rows[0].c,
        );
      }
      return out;
    }

    beforeAll(async () => {
      const app = (await import("../app")).default;
      // Prime the RBAC matrix in-memory (CI applies migrations but does not seed
      // the permissions table). Without this the approved-org write would be
      // fail-closed by requirePermission — unrelated to the verification gate.
      primePermissionCache(PERMISSION_MATRIX);
      server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("logs in and can switch to the pending org (switch is pre-gate)", async () => {
      expect((await login()).status).toBe(200);
      expect((await switchOrg(org.pending)).status).toBe(200);
    });

    it("403s every business write + a reports read while pending, writing ZERO rows", async () => {
      const before = await orgRowCounts(org.pending);

      const tx = await api("POST", "/transactions", txBody("pending must not write"));
      const cust = await api("POST", "/customers", { name: "Pending Customer" });
      const report = await api("GET", "/reports/trial-balance");

      for (const r of [tx, cust, report]) {
        expect(r.status).toBe(403);
        expect(r.body).toMatchObject({ code: "org_not_verified", status: "pending_review" });
      }
      expect(report.body.reason).toBe(REASON_PENDING);

      // The owner-connection truth: nothing was written to any business table.
      expect(await orgRowCounts(org.pending)).toEqual(before);
    });

    it("still serves /onboarding/status and logout while pending", async () => {
      const status = await api("GET", "/onboarding/status");
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ status: "pending_review", reason: REASON_PENDING, organizationId: org.pending });

      expect((await api("POST", "/auth/logout")).status).toBe(200);
    });

    it("after approval, the SAME write now posts (and reads unblock)", async () => {
      expect((await login()).status).toBe(200);
      expect((await switchOrg(org.approved)).status).toBe(200);

      const tx = await api("POST", "/transactions", txBody("approved write posts"));
      expect(tx.status).toBe(201);

      const report = await api("GET", "/reports/trial-balance");
      expect(report.status).not.toBe(403);

      const counts = await orgRowCounts(org.approved);
      expect(counts.transactions).toBeGreaterThanOrEqual(1);
    });
  });
});
