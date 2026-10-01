/**
 * Phase 14 — the two NEW report routes over real HTTP: `GET /reports/export/:report`
 * and `GET /analytics/pnl-trend`.
 *
 * What a service test cannot see (§3 "verified below the layer that had the
 * bug"): the mount's permission gate, the verification gate, the session-bound
 * tenant, the wire format (Content-Type, Content-Disposition, the CSV BOM), and
 * the 400s the controller owns. Each negative case is paired with the positive
 * one beside it, so a refusal cannot pass because the route is simply broken.
 *
 * Isolation is asserted as PRESENCE, ABSENCE and MOVEMENT (§3): org X's export
 * carries X's figure and not Y's, and Y's export carries Y's — so the absence
 * is not vacuous. The tenant is the SESSION's: no query parameter can name
 * another organization or company (resolveTenant picks both), so there is no
 * id to tamper with — the test proves the session decides.
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
if (!REAL_DB) console.warn("[phase14-reporting-http] no real DATABASE_URL — skipping.");

const P = "p14-http";
const PASSWORD = "p14-http-pw-1";
const ORGS = { x: `${P}-x`, y: `${P}-y`, z: `${P}-z` } as const;
const EMAILS = { x: `${P}-x@test.local`, y: `${P}-y@test.local`, z: `${P}-z@test.local` } as const;
const X_SALE = "1234.56";
const Y_SALE = "6543.21";

describeMaybe("Phase 14 — report exports and the P&L trend over HTTP: gated, session-scoped, refused by name", () => {
  let server: http.Server;
  let base = "";

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug LIKE '${P}-%')`;
    const U = `(SELECT id FROM users WHERE email LIKE '${P}-%@test.local')`;
    for (const t of ["journal_entry_lines", "journal_entries"]) await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O} OR user_id IN ${U}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U} OR organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email LIKE '${P}-%@test.local'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug LIKE '${P}-%'`);
  };

  /** One cookie jar per user, so the three sessions never share a cookie. */
  function client() {
    let cookie = "";
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sid = ((res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []).find((c) => c.startsWith("ksa_ledger_sid="));
      if (sid) cookie = sid.split(";")[0];
      const buf = Buffer.from(await res.arrayBuffer());
      let json: any;
      try { json = JSON.parse(buf.toString("utf8")); } catch { json = undefined; }
      return { status: res.status, headers: res.headers, buf, text: buf.toString("utf8"), json };
    };
  }
  const anon = client();
  const asX = client(), asY = client(), asZ = client();

  async function tenant(key: keyof typeof ORGS, status: "approved" | "pending_review", sale: string | null) {
    const orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ($1,$2,$3) RETURNING id`, [`P14 HTTP ${key}`, ORGS[key], status])).rows[0].id as string;
    const companyId = (await pool.query(`INSERT INTO companies (organization_id, name, name_ar, fiscal_year_start, fiscal_calendar) VALUES ($1,$2,'شركة',1,'gregorian') RETURNING id`, [orgId, `P14 HTTP Co ${key}`])).rows[0].id as string;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'P14',$2,'viewer',true) RETURNING id`, [EMAILS[key], hash])).rows[0].id;
    // the LEAST role: a viewer may read reports (the matrix grants reports:read to every role)
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'viewer','active')`, [userId, orgId]);
    if (sale) {
      const ar = (await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = 'AR'`, [orgId])).rows[0];
      const sales = (await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = 'SALES'`, [orgId])).rows[0];
      const je = (await pool.query(`INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status) VALUES ($1,$2,'P14H-1','2026-03-15','sale','posted') RETURNING id`, [orgId, companyId])).rows[0].id;
      await pool.query(
        `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount) VALUES ($1,$2,$3,$4,$5,$7,0), ($1,$2,$3,$6,$8,0,$7)`,
        [orgId, companyId, je, ar.id, ar.name, sales.id, sale, sales.name],
      );
    }
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    await tenant("x", "approved", X_SALE);
    await tenant("y", "approved", Y_SALE);
    await tenant("z", "pending_review", null);
    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    for (const [c, k] of [[asX, "x"], [asY, "y"], [asZ, "z"]] as const) {
      expect((await c("POST", "/auth/login", { email: EMAILS[k], password: PASSWORD })).status, k).toBe(200);
    }
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await cleanup();
  });

  const TB_CSV = "/reports/export/trial-balance?format=csv&date_from=2026-01-01&date_to=2026-12-31";
  const TREND = "/analytics/pnl-trend?from=2026-01&to=2026-12";

  it("🔴 no session → 401 on both routes (and the same request with a session is 200)", async () => {
    expect([(await anon("GET", TB_CSV)).status, (await anon("GET", TREND)).status]).toEqual([401, 401]);
    expect([(await asX("GET", TB_CSV)).status, (await asX("GET", TREND)).status]).toEqual([200, 200]);
  });

  it("🔴 an organization still pending verification → 403 on both routes (the verification gate holds for the new routes)", async () => {
    const [e, t] = [await asZ("GET", TB_CSV), await asZ("GET", TREND)];
    expect([e.status, t.status]).toEqual([403, 403]);
    expect(e.text).not.toContain(X_SALE);
  });

  it("🔴 the session decides the tenant — presence, absence AND movement: X's export carries X's sale and never Y's; Y's carries Y's", async () => {
    const x = await asX("GET", TB_CSV), y = await asY("GET", TB_CSV);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(x.text).toContain(X_SALE);
    expect(x.text).not.toContain(Y_SALE);
    expect(y.text).toContain(Y_SALE);
    expect(y.text).not.toContain(X_SALE);
    // the trend too: X's March revenue is X's sale, and Y's figure is nowhere in X's answer
    const tx = await asX("GET", TREND), ty = await asY("GET", TREND);
    expect(tx.json.totals.revenue).toBe(Number(X_SALE));
    expect(ty.json.totals.revenue).toBe(Number(Y_SALE));
    expect(tx.json.points.find((p: { month: string }) => p.month === "2026-03").revenue).toBe(Number(X_SALE));
  });

  it("🔴 the wire format: a CSV attachment with a UTF-8 BOM; Arabic names when lang=ar; a PDF that IS a PDF", async () => {
    const csv = await asX("GET", TB_CSV);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.csv"$/);
    expect([...csv.buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const ar = await asX("GET", `${TB_CSV}&lang=ar`);
    expect(ar.text).toMatch(/[؀-ۿ]/);
    expect(ar.text).toContain(X_SALE);
    const pdf = await asX("GET", "/reports/export/trial-balance?format=pdf&date_from=2026-01-01&date_to=2026-12-31");
    // 503 is the renderer's honest refusal when Chromium is absent; anything else must be a real PDF
    if (pdf.status === 503) expect(pdf.json?.code).toBe("pdf_renderer_unavailable");
    else {
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("content-type")).toMatch(/^application\/pdf/);
      expect(pdf.buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  }, 120_000);

  it("🔴 refusals by name, never 'all time' or a guess: unknown report, unknown format/lang, a malformed or reversed date", async () => {
    const cases: [string, number][] = [
      ["/reports/export/journal-dump?format=csv", 400],
      ["/reports/export/trial-balance?format=xml", 400],
      ["/reports/export/trial-balance?format=csv&lang=fr", 400],
      ["/reports/export/trial-balance?format=csv&date_from=2026-13-01", 400],
      ["/reports/export/income-statement?format=csv&date_from=2026-06-01&date_to=2026-01-01", 400],
      ["/reports/export/ar-aging?format=csv&as_of=2999-01-01", 400],
      ["/analytics/pnl-trend?from=2026-06&to=2026-01", 400],
      ["/analytics/pnl-trend?from=2026-01-01&to=2026-12-31", 400],
      ["/analytics/pnl-trend?from=2020-01&to=2026-12", 400],
    ];
    const got = await Promise.all(cases.map(async ([p]) => [p, (await asX("GET", p)).status] as [string, number]));
    expect(got).toEqual(cases);
  });
});
