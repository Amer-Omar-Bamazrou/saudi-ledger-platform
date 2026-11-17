/**
 * 🔴 The Phase 18 walk (2026-11-17), W3 and W4 — two refusals that told the reader less, or other, than the truth.
 *
 * W3: the security trail named every event's actor but the two refusals recorded from the error handler — A1's linked-
 * approver refusal and R-9's reference refusal — which stored the actor's id and not the email the trail prints, so the
 * Users screen read "By —" beside the very refusal A1 exists to record. Each now carries the session's email.
 *
 * W4: the one permission refusal told a VIEWER "your role can prepare and edit … send it for approval" — a viewer holds
 * only `read` — and only in English. It now says "can prepare" only when the role holds create or update on that
 * resource, and every branch carries Arabic.
 *
 * Presence, absence, movement: the email present on both refusals; the false sentence absent for a viewer and kept for a
 * bookkeeper (who does hold create on journal entries); Arabic on both. DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3391";
process.env.SESSION_SECRET ??= "phase18-walk-w3-w4-refusals-secret-1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Request } from "express";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { until } from "./helpers/g08rRace";
import { recordApprovalRefusal, recordReferenceRefusal } from "../middleware/referenceRefusals";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "WalkW3W4RefusalsPw1!";

describeMaybe("Phase 18 walk W3/W4 — a refusal names who acted, and tells each role the truth in its reader's language", () => {
  const h = g04Harness("walkw34");
  let orgId = "", companyId = "", adminId = 0;

  /** A request as the error handler sees it: the tenant resolved, the session signed in. */
  const reqOf = (originalUrl: string, body: unknown = {}) => ({
    originalUrl, url: originalUrl, method: "POST", ip: "127.0.0.1", body, params: {},
    tenant: { userId: adminId, organizationId: orgId, companyId },
    session: { userId: adminId, userEmail: h.email("admin") },
  }) as unknown as Request;
  const rowOf = async (action: string, extra: string) => {
    const q = async () => (await pool.query(
      `SELECT actor_user_id, actor_email FROM security_audit_logs WHERE action = $1 AND organization_id = $2 AND ${extra} ORDER BY id DESC LIMIT 1`,
      [action, orgId])).rows[0];
    await until(`${action} recorded`, async () => !!(await q()), 5_000).catch(() => undefined);
    return q();
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "Walk W3W4 Co", "319393939393003");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("viewer", PW, orgId, "viewer");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    expect(await h.login("viewer", h.email("viewer"), PW)).toBe(200);
    expect(await h.login("bookkeeper", h.email("bookkeeper"), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 W3: A1's linked-approver refusal records the actor's EMAIL, which the trail prints", async () => {
    recordApprovalRefusal(reqOf("/api/companies/current/bank-detail-changes/424242/decision"), 409, { code: "bank_detail_approver_linked" });
    const row = await rowOf("bank_detail_change.approval_refused", `(metadata ->> 'changeId')::int = 424242`);
    expect(row, "the refusal is recorded").toBeTruthy();
    expect(row).toMatchObject({ actor_user_id: adminId, actor_email: h.email("admin") });
  });

  it("🔴 W3: R-9's reference refusal records the actor's EMAIL too", async () => {
    recordReferenceRefusal(reqOf("/api/invoices", { customerId: 737373 }), 422, { code: "reference_not_found", field: "customerId" });
    const row = await rowOf("reference.refused", `(metadata ->> 'requested') = '737373'`);
    expect(row, "the refusal is recorded").toBeTruthy();
    expect(row).toMatchObject({ actor_user_id: adminId, actor_email: h.email("admin") });
  });

  it("🔴 W4: a VIEWER is not told it can prepare and edit — it is told it reads only, in Arabic too", async () => {
    const r = await h.api("viewer", "POST", "/journal-entries/1/reverse", { reason: "walk" });
    expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([403, "requires_approval_authority"]);
    expect(r.body.error).not.toMatch(/prepare and edit/i);
    expect(r.body.error).toMatch(/read/i);
    expect(typeof r.body.errorAr, "the refusal speaks Arabic").toBe("string");
    expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
    expect(r.body.errorAr).toMatch(/للقراءة فقط/);
  });

  it("movement — a BOOKKEEPER (who holds create on journal entries) keeps the prepare-and-send sentence, with Arabic", async () => {
    const r = await h.api("bookkeeper", "POST", "/journal-entries/1/reverse", { reason: "walk" });
    expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([403, "requires_approval_authority"]);
    expect(r.body.error).toMatch(/prepare and edit/i);
    expect(typeof r.body.errorAr, "the refusal speaks Arabic").toBe("string");
    expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
    expect(r.body.errorAr).not.toMatch(/للقراءة فقط/);
  });
});
