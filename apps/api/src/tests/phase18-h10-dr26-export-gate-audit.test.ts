/**
 * 🔴 Phase 18 H-10 — DR-26 (D-12): an export is gated by its NATIVE resource,
 * and audited. DECIDED 2026-10-27 — owner accepted the stated recommendation
 * (register §11.58, the scoped D-4 statement, appended before this file).
 *
 * The seeded matrix gives every role read on all four native resources, so the
 * gate is proven by withdrawing three grants in THIS process's permission cache
 * (the viewer's read on `tax`, `budgets` and `treasury`): the exports of their
 * reports are then refused, while a `reports` export still answers and the
 * admin's exports still answer. The control proves the withdrawn grants are in
 * force: the viewer's own screens for that data are refused too.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3260";
process.env.SESSION_SECRET ??= "phase18-h10-export-gate-audit-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H10ExpPw1!";
const TB = "/reports/export/trial-balance?format=csv&date_from=2026-01-01&date_to=2026-12-31";
const WHT = "/reports/export/wht-return?format=csv&period=2026-09";
const WITHDRAWN = ["tax", "budgets", "treasury"];

describeMaybe("Phase 18 H-10 — DR-26: an export is gated by its native resource, and audited", () => {
  const h = g04Harness("p18h10exp");
  let orgId = "", adminId = 0, viewerId = 0;
  const recorded = async () => (await pool.query(
    `SELECT entity_id, user_id, after_state FROM audit_logs
      WHERE organization_id = $1 AND action = 'export' AND entity_type = 'report_export' ORDER BY created_at, id`, [orgId])).rows;

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "H10 Co", "399999999999983");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    viewerId = await h.mkUser("viewer", PW, orgId, "viewer");
    await h.start();
    // the matrix as seeded, less the viewer's read on the three native resources under test
    primePermissionCache(PERMISSION_MATRIX.filter((r) => !(r.role === "viewer" && r.action === "read" && WITHDRAWN.includes(r.resource))));
    for (const who of ["admin", "viewer"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);

  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  it("control: the withdrawn grants are in force — the viewer's own screens for that data are refused, a report screen is not", async () => {
    expect((await h.api("viewer", "GET", "/tax/wht/returns/2026-09")).status).toBe(403);
    expect((await h.api("viewer", "GET", "/budgets")).status).toBe(403);
    expect((await h.api("viewer", "GET", "/treasury/forecast")).status).toBe(403);
    expect((await h.api("viewer", "GET", "/reports/trial-balance?date_from=2026-01-01&date_to=2026-12-31")).status).toBe(200);
  });

  it("🔴 the gate: without read on its native resource, a report's export is refused, naming the resource", async () => {
    const refused: Array<[string, string]> = [
      [WHT, "tax"],
      ["/reports/export/wht-annual?format=csv&fiscal_year=2026", "tax"],
      ["/reports/export/tax-computation?format=csv&id=999999", "tax"],
      ["/reports/export/budget-vs-actual?format=csv&budget_id=999999", "budgets"],
      ["/reports/export/treasury-forecast?format=csv", "treasury"],
    ];
    for (const [path, resource] of refused) {
      const r = await h.api("viewer", "GET", path);
      expect([path, r.status, r.body?.resource, r.body?.action]).toEqual([path, 403, resource, "read"]);
    }
  });

  it("🔴 …while an export whose native resource the viewer reads still answers, and the admin's export of the same tax report answers", async () => {
    expect((await h.api("viewer", "GET", TB)).status).toBe(200);
    expect((await h.api("viewer", "GET", "/reports/export/ar-aging?format=csv")).status).toBe(200);
    expect((await h.api("admin", "GET", WHT)).status).toBe(200);
  });

  it("🔴 every export produced is recorded — who, which report, format, language, file name, row count, parameters; a refused one records nothing", async () => {
    const before = (await recorded()).length;
    expect((await h.api("admin", "GET", `${TB}&lang=ar`)).status).toBe(200);
    expect((await h.api("viewer", "GET", WHT)).status).toBe(403);
    const mine = (await recorded()).slice(before);
    expect(mine.map((r) => [r.entity_id, r.user_id])).toEqual([["trial-balance", adminId]]);
    const a = mine[0].after_state;
    expect([a.format, a.lang, a.params]).toEqual(["csv", "ar", { date_from: "2026-01-01", date_to: "2026-12-31" }]);
    expect(String(a.filename)).toMatch(/\.csv$/);
    expect(typeof a.rows).toBe("number");
  });

  it("🔴 the exports already made in this file were each recorded once — the viewer's and the admin's, none of the refused", async () => {
    const all = (await recorded()).map((r) => [r.entity_id, r.user_id]);
    expect(all).toEqual([
      ["trial-balance", viewerId],
      ["ar-aging", viewerId],
      ["wht-return", adminId],
      ["trial-balance", adminId],
    ]);
  });
});
