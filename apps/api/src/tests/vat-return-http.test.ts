/**
 * M16.1 (design Q0) — the VAT return is REACHABLE, and files from DOCUMENTS.
 *
 * The finding this pins: `/reports/vat-return` — the box-structured return
 * built from invoices and bills — was routed and consumed by NOTHING, while
 * the page named "VAT Report" read the transaction-derived guess. The correct
 * source was a shape without a consumer, applied to a whole report; a user
 * would have filed from the weaker of two sources.
 *
 * Two properties, both over real HTTP (the finding was about reachability, so
 * the test must reach):
 *   1. GET /api/reports/vat-return serves the box structure the UI now renders.
 *   2. THE TWO SOURCES STAY TWO SOURCES: a VAT-carrying bank transaction shows
 *      up in /summary/vat (the reconciliation side) and moves NOTHING on
 *      /reports/vat-return (the filing side). If someone ever points the
 *      return at transactions — or the summary at documents — this fails.
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

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[vat-return-http] no real DATABASE_URL — skipping.");

const SLUG = "m16-vat-http";
const EMAIL = "m16-vat-http@test.local";
const PASSWORD = "vat-return-http-pw-1";

describeMaybe("M16.1 — /reports/vat-return over HTTP: reachable, documents-only", () => {
  let orgId = "";
  let server: http.Server;
  let base = "";
  let cookie = "";

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const sid = setCookies.find((c) => c.startsWith("ksa_ledger_sid="));
    if (sid) cookie = sid.split(";")[0];
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, body: json as never };
  }

  beforeAll(async () => {
    // C1: the rate-limit store is now SHARED (Postgres), so a suite that
    // logs in repeatedly consumes the SAME budget as every parallel suite —
    // the per-fork privacy MemoryStore accidentally provided is gone.
    await __resetRateLimitsForTests();
    await cleanup();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status) VALUES ('VAT HTTP Org','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
    const companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'VH','1010101012','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','VH',$1,'viewer',true) RETURNING id`,
        [hash],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );

    // One ACCEPTED, VAT-carrying bank transaction. The filing side must never
    // see it; the reconciliation side must.
    await pool.query(
      `INSERT INTO transactions (organization_id, company_id, date, description, amount, currency, type, vat_rate, vat_amount, review_status)
       VALUES ($1,$2,'2026-05-10','SADAD PAYMENT - STC',862.50,'SAR','debit',15,112.50,'accepted')`,
      [orgId, companyId],
    );

    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;

    expect((await api("POST", "/auth/login", { email: EMAIL, password: PASSWORD })).status).toBe(200);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  it("🔴 serves the box-structured return the UI renders", async () => {
    const r = await api("GET", "/reports/vat-return?period_from=2026-05&period_to=2026-05");
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body.salesSection).toMatchObject({ box8_totalOutputVat: expect.any(Number) });
    expect(body.purchasesSection).toMatchObject({ box13_recoverableInputVat: expect.any(Number) });
    expect(body).toMatchObject({ netVatDue: expect.any(Number), invoiceCount: expect.any(Number) });
  });

  it("🔴 the filing side reads DOCUMENTS ONLY: the bank line moves nothing on the return", async () => {
    const ret = await api("GET", "/reports/vat-return?period_from=2026-05&period_to=2026-05");
    const body = ret.body as { netVatDue: number; invoiceCount: number; billCount: number };
    // This org has documents: none. Its bank activity carries SAR 112.50 of
    // input VAT. The return must be all-zero regardless.
    expect(body.invoiceCount).toBe(0);
    expect(body.billCount).toBe(0);
    expect(body.netVatDue).toBe(0);
  });

  it("the reconciliation side DOES see the bank line — the gap the UI itemises is real", async () => {
    const sum = await api("GET", "/summary/vat?date_from=2026-05-01&date_to=2026-05-31");
    expect(sum.status).toBe(200);
    const body = sum.body as { vatPaid: number; netVatPosition: number };
    expect(body.vatPaid).toBe(112.5);
    expect(body.netVatPosition).toBe(-112.5);
  });
});
