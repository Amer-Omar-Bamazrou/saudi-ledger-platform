/**
 * Phase 16 + 17 — the tax and treasury routes over real HTTP, role by role.
 *
 * What a service test cannot see: the permission matrix as `requirePermission`
 * applies it (GET read · POST create · PUT/PATCH update · DELETE delete ·
 * POST …/approve|pay|reject|reverse|send-back → approve, rbac.ts
 * APPROVE_ROUTE), the verification gate, the session-bound tenant, and the
 * error handler's translation of a database refusal.
 *
 * 🔴 The platform rule, asserted over the wire (recovery audit 2026-10-04):
 * DELETE is admin-only and a bookkeeper never approves. 0114 had granted
 * treasury `delete` to the accountant and the bookkeeper; 0115 corrected it.
 *
 * Every refusal is paired with the same request SUCCEEDING (or reaching the
 * service, past the gate) for the role that may make it — so a 403 cannot pass
 * because the route is broken.
 */
process.env.PORT ??= "3000";
process.env.SESSION_SECRET ??= "test-secret-value-at-least-32-chars!!";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { primePermissionCache } from "../lib/rbac";
import { __resetRateLimitsForTests } from "../routes/auth";
import { addDays } from "../services/tax/taxComputations.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-17-http] no real DATABASE_URL — skipping.");

const P = "p1617-http";
const PASSWORD = "p1617-http-pw-1";
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
type Role = (typeof ROLES)[number];
const email = (k: string) => `${P}-${k}@test.local`;

describeMaybe("Phase 16 + 17 — tax and treasury over HTTP: delete is admin-only, a bookkeeper never approves, the tenant holds", () => {
  let server: http.Server;
  let base = "";
  let orgX = "", orgY = "";
  const today = businessToday();

  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const O = `(SELECT id FROM organizations WHERE slug LIKE '${P}-%')`;
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${O}`);
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
      return { status: res.status, json, text };
    };
  }
  const as: Record<Role | "y" | "pending" | "anon", ReturnType<typeof client>> = {
    admin: client(), accountant: client(), bookkeeper: client(), viewer: client(), y: client(), pending: client(), anon: client(),
  };

  async function org(slug: string, status: string) {
    const id = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ($1,$1,$2) RETURNING id`, [slug, status])).rows[0].id as string;
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,$2,1,'gregorian','399999999999993','1010303031','SAUDI_GCC')`, [id, `${slug} co`]);
    return id;
  }
  async function user(key: string, orgId: string, role: string) {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const id = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'P1617',$2,'viewer',true) RETURNING id`, [email(key), hash])).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,'active')`, [id, orgId, role]);
  }

  let bankX = 0, billX = 0;

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    orgX = await org(`${P}-x`, "approved");
    orgY = await org(`${P}-y`, "approved");
    const orgZ = await org(`${P}-z`, "pending_review");
    for (const r of ROLES) await user(r, orgX, r);
    await user("y", orgY, "admin");
    await user("pending", orgZ, "admin");
    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    for (const k of [...ROLES, "y", "pending"] as const) expect((await as[k]("POST", "/auth/login", { email: email(k), password: PASSWORD })).status, k).toBe(200);

    // the fixture through the product's own routes: a bank, a resident supplier, an approved bill
    bankX = (await as.admin("POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR" })).json.id;
    const vendor = (await as.admin("POST", "/vendors", { name: "HTTP Supplier", residency: "resident" })).json.id;
    const bill = await as.admin("POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: "S-1", billNumber: "HTTP-B-1", date: addDays(today, -3), dueDate: addDays(today, 20), vendorId: vendor,
      items: [{ description: "Supply", quantity: 1, unitPrice: 5000, vatRate: 0 }] });
    expect(bill.status, bill.text).toBe(201);
    expect((await as.admin("POST", `/bills/${bill.json.id}/approve`, {})).status).toBe(200);
    billX = bill.json.id;
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await cleanup();
  });

  it("🔴 no session → 401; an unverified organisation → 403 — on reads and writes of both resources", async () => {
    expect([(await as.anon("GET", "/tax/obligations")).status, (await as.anon("GET", "/treasury/dashboard")).status, (await as.anon("POST", "/treasury/assumptions", {})).status]).toEqual([401, 401, 401]);
    expect([(await as.pending("GET", "/tax/obligations")).status, (await as.pending("GET", "/treasury/dashboard")).status, (await as.pending("POST", "/tax/computations", {})).status]).toEqual([403, 403, 403]);
  });

  it("🔴 the grants as the database holds them: treasury and tax `delete` admin-only; no bookkeeper approve or delete (0115)", async () => {
    const { rows } = await pool.query(`SELECT role, resource, action FROM permissions WHERE resource IN ('tax','treasury','treasury_settings') ORDER BY 1,2,3`);
    const held = (resource: string, action: string) => rows.filter((r) => r.resource === resource && r.action === action).map((r) => r.role).sort();
    expect(held("treasury", "delete")).toEqual(["admin"]);
    expect(held("tax", "delete")).toEqual(["admin"]);
    expect(held("treasury", "approve")).toEqual(["accountant", "admin"]);
    expect(held("tax", "approve")).toEqual(["accountant", "admin"]);
    expect(held("treasury_settings", "update")).toEqual(["accountant", "admin"]);
    expect(rows.filter((r) => r.role === "bookkeeper" && (r.action === "approve" || r.action === "delete"))).toEqual([]);
    expect(rows.filter((r) => r.role === "viewer" && r.action !== "read")).toEqual([]);
    // presence: the bookkeeper does hold create/update on both (drafting is their work)
    expect(held("treasury", "create")).toContain("bookkeeper");
    expect(held("tax", "update")).toContain("bookkeeper");
  });

  it("🔴 treasury — a VIEWER reads; a BOOKKEEPER plans and edits but never approves, pays, cancels or deletes; DELETE is the ADMIN's alone", async () => {
    expect((await as.viewer("GET", "/treasury/dashboard")).status).toBe(200);
    expect((await as.viewer("GET", "/treasury/payment-plans")).status).toBe(200);
    expect((await as.viewer("POST", "/treasury/payment-plans", { billId: billX, amount: 100, plannedDate: addDays(today, 5) })).status).toBe(403);

    const plan = await as.bookkeeper("POST", "/treasury/payment-plans", { billId: billX, amount: 1000, plannedDate: addDays(today, 5) });
    expect(plan.status, plan.text).toBe(201);
    expect((await as.bookkeeper("PATCH", `/treasury/payment-plans/${plan.json.id}`, { amount: 1200 })).json.amount).toBe(1200);
    for (const [m, path, body] of [
      ["POST", `/treasury/payment-plans/${plan.json.id}/approve`, {}],
      ["POST", `/treasury/payment-plans/${plan.json.id}/pay`, { bankAccountId: bankX }],
      ["POST", `/treasury/payment-plans/${plan.json.id}/reject`, { reason: "not needed" }],
      ["DELETE", `/treasury/payment-plans/${plan.json.id}`, undefined],
    ] as const) expect((await as.bookkeeper(m, path, body)).status, `${m} ${path}`).toBe(403);
    // 🔴 the accountant APPROVES but does not DELETE
    expect((await as.accountant("DELETE", `/treasury/payment-plans/${plan.json.id}`)).status).toBe(403);
    // pair: the ADMIN deletes the never-approved plan
    expect((await as.admin("DELETE", `/treasury/payment-plans/${plan.json.id}`)).status).toBe(204);
    expect((await as.admin("GET", "/treasury/payment-plans")).json.find((p: { id: number }) => p.id === plan.json.id)).toBeUndefined();

    // an approver approves and pays (through the bill pay path — one payment, the bill moves)
    const p2 = (await as.bookkeeper("POST", "/treasury/payment-plans", { billId: billX, amount: 2000, plannedDate: addDays(today, 5), bankAccountId: bankX })).json;
    expect((await as.accountant("POST", `/treasury/payment-plans/${p2.id}/approve`, {})).json.status).toBe("approved");
    const paid = await as.accountant("POST", `/treasury/payment-plans/${p2.id}/pay`, {});
    expect(paid.status, paid.text).toBe(200);
    expect([paid.json.plan.status, paid.json.payment.amount, paid.json.payment.cashPaid]).toEqual(["paid", 2000, 2000]);
    // a paid plan is a record: even the admin cannot delete it (the database refuses beneath the service)
    expect((await as.admin("DELETE", `/treasury/payment-plans/${p2.id}`)).status).toBe(409);
  });

  it("🔴 treasury assumptions and the cash buffer — the bookkeeper records but does not delete; the buffer is an approver's policy", async () => {
    const a = await as.bookkeeper("POST", "/treasury/assumptions", { entryDate: addDays(today, 10), direction: "inflow", amount: 5000, category: "financing", description: "Shareholder loan" });
    expect(a.status, a.text).toBe(201);
    expect((await as.bookkeeper("PATCH", `/treasury/assumptions/${a.json.id}`, { amount: 6000 })).json.amount).toBe(6000);
    expect((await as.bookkeeper("DELETE", `/treasury/assumptions/${a.json.id}`)).status).toBe(403);
    expect((await as.accountant("DELETE", `/treasury/assumptions/${a.json.id}`)).status).toBe(403);
    expect((await as.viewer("DELETE", `/treasury/assumptions/${a.json.id}`)).status).toBe(403);
    expect((await as.admin("DELETE", `/treasury/assumptions/${a.json.id}`)).status).toBe(204);

    expect((await as.viewer("GET", "/treasury/settings")).status).toBe(200);
    expect((await as.bookkeeper("PUT", "/treasury/settings", { minimumCashBalance: 10000 })).status).toBe(403);
    const s = await as.accountant("PUT", "/treasury/settings", { minimumCashBalance: 10000, forecastHorizonWeeks: 8 });
    expect([s.status, s.json.minimumCashBalance, s.json.forecastHorizonWeeks]).toEqual([200, 10000, 8]);
  });

  it("🔴 tax — a VIEWER reads; a BOOKKEEPER drafts a computation but never approves it, remits WHT or deletes; DELETE is the ADMIN's", async () => {
    for (const path of ["/tax/obligations", "/tax/wht/overview", "/tax/wht/rates", "/tax/computations", "/tax/zakat/classifications"]) expect((await as.viewer("GET", path)).status, path).toBe(200);
    expect((await as.viewer("POST", "/tax/computations", { kind: "zakat", fiscalYearLabel: 2025 })).status).toBe(403);

    // the CURRENT fiscal year: its computation is a live projection and cannot be approved until the year ends
    const year = Number(today.slice(0, 4));
    const c = await as.bookkeeper("POST", "/tax/computations", { kind: "zakat", fiscalYearLabel: year });
    expect(c.status, c.text).toBe(201);
    const id = c.json.id, vid = c.json.version.id;
    // the approver's acts are refused to the bookkeeper AT THE GATE …
    for (const path of [`/tax/computations/${id}/versions/${vid}/approve`, `/tax/computations/${id}/versions/${vid}/send-back`, `/tax/computations/${id}/versions/${vid}/reject`, `/tax/wht/periods/${today.slice(0, 7)}/pay`])
      expect((await as.bookkeeper("POST", path, { reason: "x".repeat(12) })).status, path).toBe(403);
    // … and the accountant passes the gate: the service answers on the merits, BY NAME — never 403
    const acc = await as.accountant("POST", `/tax/computations/${id}/versions/${vid}/approve`, {});
    expect([acc.status, acc.json?.code]).toEqual([422, "tax_year_not_ended"]);
    expect((await as.accountant("POST", `/tax/wht/periods/${today.slice(0, 7)}/pay`, { bankAccountId: bankX, paidAt: today })).status).not.toBe(403);
    // DELETE: bookkeeper and accountant refused; the admin deletes the never-approved computation
    expect((await as.bookkeeper("DELETE", `/tax/computations/${id}`)).status).toBe(403);
    expect((await as.accountant("DELETE", `/tax/computations/${id}`)).status).toBe(403);
    expect((await as.admin("DELETE", `/tax/computations/${id}`)).status).toBe(204);
  });

  it("🔴 the tenant holds over the wire: another organisation's admin sees none of X's plans or computations and cannot touch them", async () => {
    const plan = (await as.bookkeeper("POST", "/treasury/payment-plans", { billId: billX, amount: 500, plannedDate: addDays(today, 6) })).json;
    const comp = (await as.bookkeeper("POST", "/tax/computations", { kind: "income_tax", fiscalYearLabel: 2025 })).json;
    // presence in X
    expect((await as.admin("GET", "/treasury/payment-plans")).json.some((p: { id: number }) => p.id === plan.id)).toBe(true);
    expect((await as.admin("GET", `/tax/computations/${comp.id}`)).status).toBe(200);
    // absence in Y — and Y's own reads WORK (empty, not broken)
    const yPlans = await as.y("GET", "/treasury/payment-plans");
    expect([yPlans.status, yPlans.json.length]).toEqual([200, 0]);
    expect((await as.y("GET", `/tax/computations/${comp.id}`)).status).toBe(404);
    expect((await as.y("DELETE", `/treasury/payment-plans/${plan.id}`)).status).toBe(404);
    expect((await as.y("POST", "/treasury/payment-plans", { billId: billX, amount: 1, plannedDate: addDays(today, 6) })).status).toBe(404);
    expect((await as.y("DELETE", `/tax/computations/${comp.id}`)).status).toBe(404);
    // and X's rows are untouched
    expect((await as.admin("GET", "/treasury/payment-plans")).json.some((p: { id: number }) => p.id === plan.id)).toBe(true);
    // movement: Y's own dashboard shows Y's own (empty) cash — the absence is not a broken read
    const yDash = await as.y("GET", "/treasury/dashboard");
    expect([yDash.status, yDash.json.position.totalCash]).toEqual([200, 0]);
  });
});
