/**
 * Q1 + Q2 (2026-10-05; pack §14.1–§14.2) over real HTTP, role by role.
 *
 * What a service test cannot see: `requirePermission("tax")` applying the
 * matrix to the new routes (GET → read; POST …/reverse and …/file → approve
 * by `rbac.ts` APPROVE_ROUTE), the generated body schemas enforced by the
 * controller, the session-bound tenant, and the error handler's codes. Every
 * refusal is paired with the same request SUCCEEDING for the role that may make
 * it, so a 403 cannot pass because the route is broken.
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
if (!REAL_DB) console.warn("[phase16-wht-correction-http] no real DATABASE_URL — skipping.");

const P = "q1q2-http";
const PASSWORD = "q1q2-http-pw-1";
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
type Role = (typeof ROLES)[number];
const email = (k: string) => `${P}-${k}@test.local`;

describeMaybe("Q1 + Q2 over HTTP — corrections and filings are an approver's acts; the determination is readable; the tenant holds", () => {
  let server: http.Server;
  let base = "";
  let orgX = "";
  const today = businessToday();
  const lastMonth = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);

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
  const as: Record<Role | "y", ReturnType<typeof client>> = { admin: client(), accountant: client(), bookkeeper: client(), viewer: client(), y: client() };

  async function org(slug: string) {
    const id = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ($1,$1,'approved') RETURNING id`, [slug])).rows[0].id as string;
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,$2,1,'gregorian','399999999999993','1010303031','SAUDI_GCC')`, [id, `${slug} co`]);
    return id;
  }
  async function user(key: string, orgId: string, role: string) {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const id = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'Q1Q2',$2,'viewer',true) RETURNING id`, [email(key), hash])).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,'active')`, [id, orgId, role]);
  }

  let bankX = 0, vendorNr = 0;
  const payBill = async (amount: number, paidAt: string, extra: Record<string, unknown> = {}) => {
    const bill = await as.admin("POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: `R-${Math.random()}`, billNumber: `Q12-${Math.random().toString(36).slice(2, 8)}`, date: paidAt, dueDate: paidAt, vendorId: vendorNr,
      items: [{ description: "Consulting", quantity: 1, unitPrice: amount, vatRate: 0 }] });
    expect(bill.status, bill.text).toBe(201);
    expect((await as.admin("POST", `/bills/${bill.json.id}/approve`, {})).status).toBe(200);
    const paid = await as.admin("POST", `/bills/${bill.json.id}/pay`, { amount, paidAt, bankAccountId: bankX, ...extra });
    expect(paid.status, paid.text).toBe(200);
    return (await pool.query(`SELECT id FROM wht_withholdings WHERE bill_id = $1`, [bill.json.id])).rows[0].id as number;
  };

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    orgX = await org(`${P}-x`);
    const orgY = await org(`${P}-y`);
    for (const r of ROLES) await user(r, orgX, r);
    await user("y", orgY, "admin");
    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    for (const k of [...ROLES, "y"] as const) expect((await as[k]("POST", "/auth/login", { email: email(k), password: PASSWORD })).status, k).toBe(200);
    bankX = (await as.admin("POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR" })).json.id;
    const v = await as.admin("POST", "/vendors", { name: "Q12 London Advisory", residency: "non_resident", whtDefaultPaymentType: "technical_consulting", country: "GB" });
    expect(v.status, v.text).toBe(201);
    vendorNr = v.json.id;
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await cleanup();
  });

  it("🔴 Q2 — the determination is READ by everyone: the preview over HTTP says a deposit is not subject and an unidentified payment is pending", async () => {
    const dep = await as.viewer("GET", `/tax/wht/preview?vendorId=${vendorNr}&amount=1000&classification=security_deposit`);
    expect([dep.status, dep.json.kind, dep.json.withheld, dep.json.determination.outcome]).toEqual([200, "not_subject", 0, "not_wht"]);
    const unk = await as.bookkeeper("GET", `/tax/wht/preview?vendorId=${vendorNr}&amount=1000&classification=unknown`);
    expect([unk.json.kind, unk.json.determination.reasonCode]).toEqual(["pending", "payment_unidentified"]);
    const ex = await as.viewer("GET", "/tax/wht/exceptions?kind=pending_classification");
    expect([ex.status, ex.json.kind]).toEqual([200, "pending_classification"]);
    // a nature declared on unidentified money is refused in words, at the API
    const sp = await as.admin("POST", "/supplier-payments", { vendorId: vendorNr, bankAccountId: bankX, amount: 500, paidAt: today, whtPaymentType: "royalty" });
    expect([sp.status, sp.json.code]).toEqual([422, "wht_unidentified_payment_declared"]);
  });

  it("🔴 Q1 — CORRECT is an approver's act: a viewer and a bookkeeper are refused at the gate (nothing written); the accountant corrects; a second correction is 409", async () => {
    const wId = await payBill(2_000, today);
    const body = { reason: "the nature was a royalty, not a consulting fee", reentry: { amount: 2_000, paidAt: today, whtPaymentType: "royalty" } };
    const before = Number((await pool.query(`SELECT count(*)::int n FROM wht_corrections WHERE organization_id = $1`, [orgX])).rows[0].n);
    expect((await as.viewer("POST", `/tax/wht/withholdings/${wId}/reverse`, body)).status).toBe(403);
    expect((await as.bookkeeper("POST", `/tax/wht/withholdings/${wId}/reverse`, body)).status).toBe(403);
    expect(Number((await pool.query(`SELECT count(*)::int n FROM wht_corrections WHERE organization_id = $1`, [orgX])).rows[0].n)).toBe(before);
    // the lineage is a READ: the viewer sees it
    expect((await as.viewer("GET", `/tax/wht/withholdings/${wId}`)).json.correction).toBeNull();
    const ok = await as.accountant("POST", `/tax/wht/withholdings/${wId}/reverse`, body);
    expect(ok.status, ok.text).toBe(200);
    expect([ok.json.correction.reason, ok.json.reentry.paymentType, ok.json.reentry.whtAmount]).toEqual([body.reason, "royalty", 300]);
    const again = await as.admin("POST", `/tax/wht/withholdings/${wId}/reverse`, { reason: "and once more for luck" });
    expect([again.status, again.json.code]).toEqual([409, "wht_already_corrected"]);
    // the body schema is enforced: a reason too short is a 400 before the service
    const w2 = await payBill(1_000, today);
    expect((await as.admin("POST", `/tax/wht/withholdings/${w2}/reverse`, { reason: "short" })).status).toBe(400);
  });

  it("🔴 Q1 — FILE is an approver's act; a correction into the filed month without a treatment is a 409 naming the two choices", async () => {
    const wId = await payBill(3_000, `${lastMonth}-05`);
    expect((await as.bookkeeper("POST", `/tax/wht/returns/${lastMonth}/file`, { zatcaReference: "BK-TRY", filedOn: today })).status).toBe(403);
    expect((await as.viewer("POST", `/tax/wht/returns/${lastMonth}/file`, { zatcaReference: "V-TRY", filedOn: today })).status).toBe(403);
    const filed = await as.accountant("POST", `/tax/wht/returns/${lastMonth}/file`, { zatcaReference: "WHT-HTTP-001", filedOn: today });
    expect([filed.status, filed.json.filing.status, filed.json.filing.latest.zatcaReference]).toEqual([200, "filed", "WHT-HTTP-001"]);
    const r = await as.accountant("POST", `/tax/wht/withholdings/${wId}/reverse`, { reason: "rate was wrong on the filed month" });
    expect([r.status, r.json.code]).toEqual([409, "wht_month_filed"]);
    expect(r.json.error).toMatch(/subsequent period/i);
    expect(r.json.error).toMatch(/amend/i);
  });

  it("🔴 the tenant holds over the wire: another organisation's admin gets 404 on the lineage and the correction, and sees none of X's filings", async () => {
    const wId = await payBill(1_500, today);
    expect((await as.y("GET", `/tax/wht/withholdings/${wId}`)).status).toBe(404);
    expect((await as.y("POST", `/tax/wht/withholdings/${wId}/reverse`, { reason: "reaching across organisations" })).status).toBe(404);
    expect((await as.y("GET", `/tax/wht/returns/${lastMonth}`)).json.filing.filings).toEqual([]);
    expect(Number((await pool.query(`SELECT count(*)::int n FROM wht_corrections WHERE withholding_id = $1`, [wId])).rows[0].n)).toBe(0);
  });
});
