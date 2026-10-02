/**
 * Phase 15 — the budget routes over real HTTP, role by role (D15-12).
 *
 * What a service test cannot see: the permission matrix as `requirePermission`
 * applies it (GET read · POST create · PUT/PATCH update · DELETE delete ·
 * POST …/approve|send-back|reject → approve, rbac.ts APPROVE_ROUTE), the
 * verification gate, the session-bound tenant, the controller's 400s, and the
 * error handler's translation of a database refusal. Every refusal is paired
 * with the same request succeeding for the role that may make it — so a 403
 * cannot pass because the route is broken.
 */
process.env.PORT ??= "3000";
process.env.SESSION_SECRET ??= "test-secret-value-at-least-32-chars!!";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { __resetRateLimitsForTests } from "../routes/auth";
import { errorHandler } from "../middleware/errorHandler";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase15-budgets-http] no real DATABASE_URL — skipping.");

const P = "p15-http";
const PASSWORD = "p15-http-pw-1";
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
type Role = (typeof ROLES)[number];
const email = (k: string) => `${P}-${k}@test.local`;

describeMaybe("Phase 15 — budgets over HTTP: the approver split, the gate, the tenant, refusals by name", () => {
  let server: http.Server;
  let base = "";
  let orgX = "", orgY = "";
  let salesX = 0;

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug LIKE '${P}-%')`;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica"); // approved versions are immutable (0112)
      for (const t of ["budget_lines", "budget_versions", "budgets", "audit_logs", "organization_memberships", "categories", "companies"]) await c.query(`DELETE FROM ${t} WHERE organization_id IN ${O}`);
      await c.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${P}-%@test.local')`);
      await c.query(`DELETE FROM organization_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${P}-%@test.local')`);
      await c.query(`DELETE FROM users WHERE email LIKE '${P}-%@test.local'`);
      await c.query(`DELETE FROM organizations WHERE slug LIKE '${P}-%'`);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  };

  function client() {
    let cookie = "";
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sid = ((res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []).find((c) => c.startsWith("ksa_ledger_sid="));
      if (sid) cookie = sid.split(";")[0];
      const text = await res.text();
      let json: any;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: res.status, json, text, headers: res.headers };
    };
  }
  const as: Record<Role | "y" | "pending" | "anon", ReturnType<typeof client>> = {
    admin: client(), accountant: client(), bookkeeper: client(), viewer: client(), y: client(), pending: client(), anon: client(),
  };

  async function org(slug: string, status: string) {
    const id = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ($1,$1,$2) RETURNING id`, [slug, status])).rows[0].id as string;
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,$2,1,'gregorian')`, [id, `${slug} co`]);
    return id;
  }
  async function user(key: string, orgId: string, role: string) {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const id = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'P15',$2,'viewer',true) RETURNING id`, [email(key), hash])).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,'active')`, [id, orgId, role]);
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    orgX = await org(`${P}-x`, "approved");
    orgY = await org(`${P}-y`, "approved");
    const orgZ = await org(`${P}-z`, "pending_review");
    for (const r of ROLES) await user(r, orgX, r);
    await user("y", orgY, "admin");
    await user("pending", orgZ, "admin");
    salesX = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'SALES'`, [orgX])).rows[0].id;
    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    for (const k of [...ROLES, "y", "pending"] as const) expect((await as[k]("POST", "/auth/login", { email: email(k), password: PASSWORD })).status, k).toBe(200);
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await cleanup();
  });

  const LINES = { lines: [{ accountId: 0, periods: Array(12).fill(1000) }] };
  let budgetId = 0, versionId = 0;

  it("🔴 no session → 401; an unverified organisation → 403 — on reads and writes alike", async () => {
    expect([(await as.anon("GET", "/budgets")).status, (await as.anon("POST", "/budgets", { name: "x", fiscalYearLabel: 2026 })).status]).toEqual([401, 401]);
    expect([(await as.pending("GET", "/budgets")).status, (await as.pending("POST", "/budgets", { name: "x", fiscalYearLabel: 2026 })).status]).toEqual([403, 403]);
  });

  it("🔴 a VIEWER reads and never writes; a BOOKKEEPER drafts and submits but never approves, sends back, rejects or deletes", async () => {
    expect((await as.viewer("GET", "/budgets")).status).toBe(200);
    expect((await as.viewer("POST", "/budgets", { name: "Viewer budget", fiscalYearLabel: 2026 })).status).toBe(403);

    const created = await as.bookkeeper("POST", "/budgets", { name: "Bookkeeper budget", fiscalYearLabel: 2026 });
    expect(created.status).toBe(201);
    budgetId = created.json.id; versionId = created.json.version.id;
    LINES.lines[0]!.accountId = salesX;
    expect((await as.viewer("PUT", `/budgets/${budgetId}/versions/${versionId}/lines`, LINES)).status).toBe(403);
    expect((await as.bookkeeper("PUT", `/budgets/${budgetId}/versions/${versionId}/lines`, LINES)).status).toBe(200);
    expect((await as.bookkeeper("POST", `/budgets/${budgetId}/versions/${versionId}/submit`)).status).toBe(200);
    for (const act of ["approve", "send-back", "reject"]) {
      expect((await as.bookkeeper("POST", `/budgets/${budgetId}/versions/${versionId}/${act}`)).status, `bookkeeper ${act}`).toBe(403);
    }
    expect((await as.bookkeeper("DELETE", `/budgets/${budgetId}`)).status).toBe(403);
  });

  it("🔴 an ACCOUNTANT sends back and approves; only an ADMIN deletes — and not an approved budget", async () => {
    const back = await as.accountant("POST", `/budgets/${budgetId}/versions/${versionId}/send-back`, { note: "Check March" });
    expect([back.status, back.json.version.status, back.json.version.sendBackNote]).toEqual([200, "draft", "Check March"]);
    expect((await as.bookkeeper("POST", `/budgets/${budgetId}/versions/${versionId}/submit`)).status).toBe(200);
    const ok = await as.accountant("POST", `/budgets/${budgetId}/versions/${versionId}/approve`);
    expect([ok.status, ok.json.approvedVersionId]).toEqual([200, versionId]);
    // an approved version's lines: 409 with the code the UI keys on
    const locked = await as.bookkeeper("PUT", `/budgets/${budgetId}/versions/${versionId}/lines`, LINES);
    expect([locked.status, locked.json.code]).toEqual([409, "budget_version_locked"]);
    expect((await as.accountant("DELETE", `/budgets/${budgetId}`)).status).toBe(403);
    const ever = await as.admin("DELETE", `/budgets/${budgetId}`);
    expect([ever.status, ever.json.code]).toEqual([409, "budget_ever_approved"]);
    // a never-approved budget IS deletable by an admin
    const scratch = await as.admin("POST", "/budgets", { name: "Scratch", fiscalYearLabel: 2026 });
    expect((await as.admin("DELETE", `/budgets/${scratch.json.id}`)).status).toBe(204);
  });

  it("🔴 the session decides the tenant: another organisation's budget is a 404 on every route — and its own budgets are listed (presence, absence, movement)", async () => {
    const y = await as.y("POST", "/budgets", { name: "Y budget", fiscalYearLabel: 2026 });
    expect(y.status).toBe(201);
    for (const [m, p] of [["GET", `/budgets/${budgetId}`], ["GET", `/budgets/${budgetId}/vs-actual`], ["POST", `/budgets/${budgetId}/versions`], ["POST", `/budgets/${budgetId}/versions/${versionId}/approve`]] as const) {
      expect((await as.y(m, p)).status, `${m} ${p}`).toBe(404);
    }
    const listY = (await as.y("GET", "/budgets")).json as Array<{ id: number }>;
    const listX = (await as.admin("GET", "/budgets")).json as Array<{ id: number }>;
    expect(listY.map((b) => b.id)).toEqual([y.json.id]);
    expect(listX.map((b) => b.id)).toContain(budgetId);
    expect(listX.map((b) => b.id)).not.toContain(y.json.id);
  });

  it("🔴 refusals by name: malformed ids and periods are 400s; a foreign account is a 422 naming it; vs-actual and its export answer", async () => {
    const cases: [string, string, unknown, number][] = [
      ["GET", `/budgets/${budgetId}/vs-actual?through_period=abc`, undefined, 400],
      ["GET", `/budgets/${budgetId}/vs-actual?through_period=13`, undefined, 400],
      ["GET", `/budgets/${budgetId}?version_id=x`, undefined, 400],
      ["GET", "/budgets?as_of=2026-13", undefined, 400],
      ["POST", "/budgets", { name: "", fiscalYearLabel: 2026 }, 400],
      ["PUT", `/budgets/${budgetId}/versions/abc/lines`, LINES, 400],
      ["GET", `/budgets/${budgetId}/vs-actual?version_id=99999999999`, undefined, 400],
    ];
    for (const [m, p, b, s] of cases) expect((await as.admin(m, p, b)).status, `${m} ${p}`).toBe(s);

    const draft = await as.admin("POST", `/budgets/${budgetId}/versions`);
    expect([draft.status, draft.json.version.versionNo]).toEqual([201, 2]);
    const ySales = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'SALES'`, [orgY])).rows[0].id;
    const foreign = await as.admin("PUT", `/budgets/${budgetId}/versions/${draft.json.version.id}/lines`, { lines: [{ accountId: ySales, annualAmount: 10 }] });
    expect([foreign.status, foreign.json.code, foreign.json.accountIds]).toEqual([422, "budget_account_invalid", [ySales]]);

    // an amount numeric(15,2) cannot hold is a 400 naming the bound — never an overflow 500
    const huge = await as.admin("PUT", `/budgets/${budgetId}/versions/${draft.json.version.id}/lines`, { lines: [{ accountId: salesX, annualAmount: 1e14 }] });
    expect([huge.status, huge.json.error]).toEqual([400, expect.stringContaining("9,999,999,999,999.99")]);
    const vs = await as.viewer("GET", `/budgets/${budgetId}/vs-actual?through_period=3`);
    expect([vs.status, vs.json.throughPeriod, vs.json.lines[0].ytd.budget]).toEqual([200, 3, 3000]);
    const csv = await as.viewer("GET", `/reports/export/budget-vs-actual?format=csv&budget_id=${budgetId}&through_period=3`);
    expect(csv.status, csv.text).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(csv.text).toContain("3000.00");
    expect((await as.viewer("GET", "/reports/export/budget-vs-actual?format=csv")).status, "budget_id is required").toBe(400);
  });

  it("🔴 a database refusal reaching the error handler is translated once: a lifecycle trigger → 409, an account/tenant trigger → 422, each with its constraint as the code", () => {
    const run = (err: unknown) => {
      let status = 0; let body: any;
      const res = { headersSent: false, status(s: number) { status = s; return this; }, json(b: unknown) { body = b; return this; } };
      errorHandler(err, { log: { warn() {}, error() {} } } as never, res as never, (() => {}) as never);
      return [status, body?.code];
    };
    expect(run({ code: "23514", constraint: "budget_line_locked", message: "budget version 1 (v1) is approved: its lines are locked" })).toEqual([409, "budget_line_locked"]);
    expect(run({ code: "23514", constraint: "budget_line_account", message: "budget line: account 9 is not an income or expense posting account" })).toEqual([422, "budget_line_account"]);
    expect(run({ cause: { code: "23514", constraint: "budget_version_tenant", message: "x" }, message: "wrapped" })).toEqual([422, "budget_version_tenant"]);
    expect(run({ code: "23505", constraint: "budget_versions_one_open_unq", message: "dup" })).toEqual([409, "budget_conflict"]);
    // an EXACT allow-list: an unrelated constraint, a plain CHECK on a budget table, or a primary-key
    // fault is a bug — a logged 500, never translated into a refusal the caller is told to fix
    expect(run({ code: "23514", constraint: "invoices_total_chk", message: "x" })).toEqual([500, undefined]);
    expect(run({ code: "23514", constraint: "budget_lines_amount_chk", message: "x" })).toEqual([500, undefined]);
    expect(run({ code: "23505", constraint: "budgets_pkey", message: "x" })).toEqual([500, undefined]);
  });
});
