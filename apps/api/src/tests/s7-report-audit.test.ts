/**
 * 🔴 19B 19.18 (control 19B-S7C) — THE AUDIT TRAIL OF REPORTS: creating, changing, sharing and archiving a saved report,
 * making and ending a schedule, each run (on screen and scheduled) and each open of a delivered copy.
 *
 * Owner, 2026-11-26: "actor, company, resource, action, time, request id, never a field's value. Test that a retry
 * doesn't record twice, tenant isolation, and that no ordinary route can change an entry."
 *
 *  - every act above writes ONE entry in `audit_logs` — the audit trail the product already has (append-only for every
 *    role, the actor taken from the connection, the time and the order set by the database) — carrying the company (in
 *    the entry's own state: the trail stays organization-wide, as it is for every entry) and the id of the request
 *    that did it (the `X-Request-Id` the caller was sent);
 *  - an entry says WHAT was asked for — the dataset, the column names, which filters were used, the period, the
 *    grouping, the counts — and never a value: not a row's figure or text, not a filter's value, not the report's name;
 *  - a refused act writes no entry here (refusals have their own record, D6);
 *  - the same request cannot record the same act twice (a unique key in the database), and a scheduled run records once
 *    however many times, or in however many processes, the job runs for that period;
 *  - another organization sees none of it, by the reader and by the database's own policy;
 *  - nothing changes or removes an entry: the database refuses the request's role, and the audit routes only read.
 * DB-backed; skips on the placeholder.
 */
process.env.PORT ??= "3249";
process.env.SESSION_SECRET ??= "s7-report-audit-00000000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool, PERMISSION_MATRIX } from "@workspace/db";
import { sql } from "drizzle-orm";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s7-report-audit-password-2026-x";
const h = g04Harness("s7aud");
const WINDOW = "date_from=2026-10-01&date_to=2026-10-31";
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
const CUSTOMER = "S7AUD-Customer-Zeta";
const REPORT_NAME = "S7AUD-Report-Name-Omega";
const TYPES = ["report_definition", "report_schedule", "report_run", "report_scheduled_run", "report_delivery"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Entry { id: string; organization_id: string; user_id: number | null; action: string; entity_type: string; entity_id: string; request_id: string | null; before_state: any; after_state: any; created_at: Date; seq: number }

describeDb("19B 19.18 — the audit trail of reports", () => {
  let orgId = "";
  let companyId = "";
  let otherOrgId = "";
  let accountId = 0;
  const ids: Record<string, number> = {};
  const ok = (r: { status: number; text: string; body: any }, status = 200) => { expect(r.status, r.text).toBe(status); return r.body; };
  const entries = async (org = orgId): Promise<Entry[]> =>
    (await pool.query(`SELECT * FROM audit_logs WHERE organization_id = $1 AND entity_type = ANY($2) ORDER BY seq`, [org, TYPES])).rows;
  const of = async (entityType: string, action: string, entityId?: string | number) =>
    (await entries()).filter((e) => e.entity_type === entityType && e.action === action && (entityId == null || e.entity_id === String(entityId)));
  /** The one entry a request wrote: found by the request id the caller was sent. */
  const byRequest = async (r: { headers: Record<string, string> }) => {
    const id = r.headers["x-request-id"]!;
    expect(id).toMatch(UUID);
    return (await entries()).filter((e) => e.request_id === id);
  };
  const body = (extra: Record<string, unknown> = {}) => ({
    name: REPORT_NAME, dataset: "sales_documents", columns: ["customerName", "documentNumber", "signedTotal"],
    period: { kind: "fixed", from: "2026-10-01", to: "2026-10-31" }, filters: {}, sort: "-documentNumber", groupBy: "customerName", ...extra,
  });
  const job = async (now: Date) => (await import("../services/reporting/reportSchedules.job")).reportSchedulesJob.runOnce(now, orgId);

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S7 Audit Co", "319898989899007");
    companyId = (await pool.query(`SELECT id FROM companies WHERE organization_id = $1`, [orgId])).rows[0].id;
    for (const role of ROLES) ids[role] = await h.mkUser(role, PW, orgId, role);
    for (const role of ROLES) expect(await h.login(role, h.email(role), PW)).toBe(200);
    otherOrgId = await h.mkOrg("other");
    await h.mkCompany(otherOrgId, "S7 Audit Other Co", "319898989899015");
    ids.outsider = await h.mkUser("outsider", PW, otherOrgId, "admin");
    expect(await h.login("outsider", h.email("outsider"), PW)).toBe(200);
    const customer = ok(await h.api("admin", "POST", "/customers", { name: CUSTOMER }), 201);
    const inv = ok(await h.api("admin", "POST", "/invoices", { date: "2026-10-05", dueDate: "2026-10-31", customerId: customer.id, items: [{ description: "S7AUD", quantity: 1, unitPrice: 4242.42, vatRate: 15 }] }), 201);
    ok(await h.api("admin", "POST", `/invoices/${inv.id}/submit`));
    ok(await h.api("admin", "POST", `/invoices/${inv.id}/approve`));
    accountId = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'AR' AND is_posting`, [orgId])).rows[0].id;
  }, 180_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  let definitionId = 0;
  let scheduleId = 0;

  it("🔴 creating, changing, sharing and archiving a saved report: one entry each — actor, company, the request's id, the act — and what was asked for, never a value", async () => {
    const created = await h.api("accountant", "POST", "/report-definitions", body());
    definitionId = ok(created, 201).id;
    const [c] = await byRequest(created);
    expect((await byRequest(created)).length).toBe(1);
    expect([c!.entity_type, c!.action, c!.entity_id, c!.user_id, c!.after_state.companyId, c!.organization_id]).toEqual(["report_definition", "create", String(definitionId), ids.accountant, companyId, orgId]);
    // the time is the database's (0159), compared where it was written: the column carries no zone of its own
    const age = (await pool.query(`SELECT abs(extract(epoch FROM (localtimestamp - created_at)))::float AS s FROM audit_logs WHERE id = $1`, [c!.id])).rows[0].s;
    expect(age).toBeLessThan(120);
    expect(c!.after_state).toMatchObject({ dataset: "sales_documents", columns: ["customerName", "documentNumber", "signedTotal"], period: { kind: "fixed", from: "2026-10-01", to: "2026-10-31" }, sort: "-documentNumber", groupBy: "customerName", filters: [] });
    expect(c!.before_state).toBeNull();

    // a change: before and after; a filter is recorded by NAME (its value is a field's value)
    const jl = { name: `${REPORT_NAME} 2`, dataset: "journal_lines", columns: ["date", "debit"], period: { kind: "this_month" }, filters: { account_id: String(accountId) }, sort: null, groupBy: null };
    const changed = await h.api("accountant", "PUT", `/report-definitions/${definitionId}`, jl);
    ok(changed);
    const [u] = await byRequest(changed);
    expect([u!.entity_type, u!.action, u!.entity_id, u!.user_id]).toEqual(["report_definition", "update", String(definitionId), ids.accountant]);
    expect(u!.before_state).toMatchObject({ dataset: "sales_documents", groupBy: "customerName" });
    expect(u!.after_state).toMatchObject({ dataset: "journal_lines", columns: ["date", "debit"], period: { kind: "this_month", from: null, to: null }, filters: ["account_id"], sort: null, groupBy: null });
    expect(JSON.stringify(u)).not.toContain(`"${accountId}"`);
    ok(await h.api("accountant", "PUT", `/report-definitions/${definitionId}`, body())); // back to the sales report

    const shared = await h.api("accountant", "PUT", `/report-definitions/${definitionId}/share`, { roles: ["viewer", "bookkeeper"] });
    ok(shared);
    const [s] = await byRequest(shared);
    expect([s!.entity_type, s!.action, s!.entity_id]).toEqual(["report_definition", "share", String(definitionId)]);
    expect([s!.before_state, s!.after_state]).toEqual([{ sharedRoles: [] }, { sharedRoles: ["bookkeeper", "viewer"], companyId }]);

    // refused acts write nothing here: a viewer may not share; a stranger's change is refused
    const n = (await entries()).length;
    expect((await h.api("viewer", "PUT", `/report-definitions/${definitionId}/share`, { roles: ["viewer"] })).status).toBe(403);
    expect((await h.api("bookkeeper", "PUT", `/report-definitions/${definitionId}`, body())).status).toBe(403);
    expect((await h.api("accountant", "POST", "/report-definitions", body({ groupBy: "documentNumber" }))).status).toBe(400);
    expect((await entries()).length).toBe(n);

    const throwaway = ok(await h.api("accountant", "POST", "/report-definitions", body({ name: "S7AUD throwaway" })), 201).id;
    const archived = await h.api("accountant", "DELETE", `/report-definitions/${throwaway}`);
    expect(archived.status).toBeLessThan(300);
    const [a] = await byRequest(archived);
    expect([a!.entity_type, a!.action, a!.entity_id, a!.user_id]).toEqual(["report_definition", "archive", String(throwaway), ids.accountant]);
  });

  it("🔴 each run on screen is one entry: who, which data, which columns, the period, the page and the counts — one per request, none for a refused run", async () => {
    const first = await h.api("viewer", "GET", `/reports/datasets/sales_documents/rows?${WINDOW}&columns=customerName,signedTotal&group=customerName&limit=1&offset=0`);
    ok(first);
    const [r] = await byRequest(first);
    expect((await byRequest(first)).length).toBe(1);
    expect([r!.entity_type, r!.action, r!.entity_id, r!.user_id, r!.after_state.companyId]).toEqual(["report_run", "run", "sales_documents", ids.viewer, companyId]);
    expect(r!.after_state).toMatchObject({ dataset: "sales_documents", columns: ["customerName", "signedTotal"], window: { from: "2026-10-01", to: "2026-10-31" }, filters: [], sort: null, groupBy: "customerName", limit: 1, offset: 0, rows: 1, total: 1, withheld: [] });
    const second = await h.api("viewer", "GET", `/reports/datasets/sales_documents/rows?${WINDOW}&limit=1&offset=0`);
    expect((await byRequest(second)).length).toBe(1);
    expect((await byRequest(second))[0]!.request_id).not.toBe(r!.request_id);
    // what a role was NOT shown is named (paths), so the trail says who saw which figures
    const jl = await h.api("accountant", "GET", `/reports/datasets/journal_lines/rows?${WINDOW}&account_id=${accountId}`);
    expect((await byRequest(jl))[0]!.after_state).toMatchObject({ dataset: "journal_lines", filters: ["account_id"] });
    const n = (await entries()).length;
    expect((await h.api("viewer", "GET", `/reports/datasets/cash_movements/rows?${WINDOW}`)).status).toBe(403);
    expect((await h.api("viewer", "GET", `/reports/datasets/sales_documents/rows?${WINDOW}&group=documentNumber`)).status).toBe(400);
    expect((await entries()).length).toBe(n);
  });

  it("🔴 making and ending a schedule; a scheduled run records ONCE — however often, and in however many processes, the job runs for that period — with each recipient's outcome", async () => {
    const made = await h.api("bookkeeper", "POST", "/report-schedules", { definitionId, cadence: "daily", recipientUserIds: [ids.bookkeeper, ids.viewer] });
    scheduleId = ok(made, 201).id;
    const [m] = await byRequest(made);
    expect([m!.entity_type, m!.action, m!.entity_id, m!.user_id, m!.after_state.companyId]).toEqual(["report_schedule", "create", String(scheduleId), ids.bookkeeper, companyId]);
    expect(m!.after_state).toMatchObject({ definitionId, cadence: "daily", recipients: [ids.bookkeeper, ids.viewer].sort((a, b) => a - b) });

    const day = new Date("2026-11-02T09:00:00Z");
    // two instances at once, then the job again: one claimed run, one entry
    const [a, b] = await Promise.all([job(day), job(day)]);
    expect(a.delivered + b.delivered).toBe(2);
    await job(day);
    await job(new Date("2026-11-02T15:00:00Z"));
    const runs = await of("report_scheduled_run", "run");
    expect(runs.length).toBe(1);
    const run = runs[0]!;
    const runRow = (await pool.query(`SELECT id FROM report_runs WHERE schedule_id = $1`, [scheduleId])).rows;
    expect(runRow.length).toBe(1);
    expect([run.entity_id, run.request_id, run.user_id, run.after_state.companyId]).toEqual([String(runRow[0].id), `scheduled-run:${runRow[0].id}`, null, companyId]);
    expect(run.after_state).toMatchObject({ scheduleId, definitionId, ownerUserId: ids.bookkeeper, dataset: "sales_documents", status: "delivered", outcomeCode: null, window: { from: "2026-10-01", to: "2026-10-31" }, delivered: 2, skipped: 0 });
    expect(run.after_state.recipients.map((x: any) => [x.userId, x.outcome]).sort()).toEqual([[ids.bookkeeper, "delivered"], [ids.viewer, "delivered"]].sort());
    // the next day is another run: another entry
    await job(new Date("2026-11-03T09:00:00Z"));
    expect((await of("report_scheduled_run", "run")).length).toBe(2);

    const ended = await h.api("bookkeeper", "DELETE", `/report-schedules/${scheduleId}`);
    expect(ended.status).toBeLessThan(300);
    const [e] = await byRequest(ended);
    expect([e!.entity_type, e!.action, e!.entity_id, e!.user_id]).toEqual(["report_schedule", "end", String(scheduleId), ids.bookkeeper]);
  });

  it("🔴 each open of a delivered copy is one entry, by its recipient; an open that is refused or not found writes none", async () => {
    const copy = (ok(await h.api("viewer", "GET", "/report-deliveries")).items as { id: number }[])[0]!;
    const one = await h.api("viewer", "GET", `/report-deliveries/${copy.id}`);
    const two = await h.api("viewer", "GET", `/report-deliveries/${copy.id}`);
    ok(one); ok(two);
    const opens = await of("report_delivery", "open", copy.id);
    expect(opens.length).toBe(2);
    expect(new Set(opens.map((o) => o.request_id))).toEqual(new Set([one.headers["x-request-id"], two.headers["x-request-id"]]));
    expect([opens[0]!.user_id, opens[0]!.after_state.companyId]).toEqual([ids.viewer, companyId]);
    expect(opens[0]!.after_state).toMatchObject({ dataset: "sales_documents", definitionId, status: "available", rows: 1, withheld: [] });
    const n = (await entries()).length;
    expect((await h.api("accountant", "GET", `/report-deliveries/${copy.id}`)).status).toBe(404);
    expect((await h.api("outsider", "GET", `/report-deliveries/${copy.id}`)).status).toBe(404);
    expect((await entries()).length).toBe(n);
  });

  it("🔴 never a field's value: no entry holds a customer's name, an amount, a report's name or a filter's value", async () => {
    const all = await entries();
    expect(all.length).toBeGreaterThan(8);
    const text = JSON.stringify(all.map((e) => [e.before_state, e.after_state, e.entity_id]));
    for (const planted of [CUSTOMER, "Zeta", REPORT_NAME, "Omega", "4242.42", "4878.78", "636.36", "INV-"]) expect([planted, text.includes(planted)]).toEqual([planted, false]);
    // and the figures WERE served to the readers these entries name (the absence above is not an empty report)
    const seen = ok(await h.api("viewer", "GET", `/reports/datasets/sales_documents/rows?${WINDOW}`));
    expect(JSON.stringify(seen.rows)).toContain(CUSTOMER);
    expect(JSON.stringify(seen.rows)).toContain("4878.78");
    // every entry carries its company and a request id
    for (const e of all) expect([e.entity_type, e.action, e.after_state.companyId, !!e.request_id]).toEqual([e.entity_type, e.action, companyId, true]);
  });

  it("🔴 a retry does not record twice: the same request cannot write the same act again — the database's own key, whatever the caller does", async () => {
    const { reportAuditService } = await import("../services/reporting/reportAudit.service");
    const { auditContext } = await import("../lib/auditContext");
    const { beginTenantConnection } = await import("@workspace/db");
    const requestId = "11111111-2222-4333-8444-555555555555";
    const write = async () => {
      const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated", actorUserId: ids.accountant });
      try {
        const out = await conn.run(() => auditContext.run({ userId: ids.accountant, organizationId: orgId, ipAddress: null, requestId, companyId }, () =>
          reportAuditService.record({ action: "create", entityType: "report_definition", entityId: 987654321, after: { dataset: "sales_documents" } })));
        await conn.commit();
        return out;
      } catch (err) { await conn.rollback(); throw err; }
    };
    expect(await write()).toBe(true);
    expect(await write()).toBe(false);
    expect(await write()).toBe(false);
    expect((await entries()).filter((e) => e.request_id === requestId).length).toBe(1);
    // the key is the database's: a second row for the same request and act is refused outright
    await expect(pool.query(
      `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, request_id) VALUES ($1, 'create', 'report_definition', '987654321', $2)`,
      [orgId, requestId],
    )).rejects.toThrow(/audit_logs_request_event_unq/);
    // a different act in the same request is its own entry
    await pool.query(`INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, request_id, after_state) VALUES ($1, 'share', 'report_definition', '987654321', $2, $3)`, [orgId, requestId, JSON.stringify({ companyId })]);
    expect((await entries()).filter((e) => e.request_id === requestId).length).toBe(2);
    // and a row with NO request id is outside the key (every other audit entry, before and since)
    for (let i = 0; i < 2; i++) await pool.query(`INSERT INTO audit_logs (organization_id, action, entity_type, entity_id) VALUES ($1, 'create', 's7aud_plain', '1')`, [orgId]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND entity_type = 's7aud_plain'`, [orgId])).rows[0].n).toBe(2);
    // a recorder with no request to name refuses to write (an entry without its request id is not this trail's)
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated", actorUserId: ids.accountant });
    await expect(conn.run(() => auditContext.run({ userId: ids.accountant, organizationId: orgId, ipAddress: null }, () =>
      reportAuditService.record({ action: "create", entityType: "report_definition", entityId: 1, after: {} })))).rejects.toThrow(/request id/);
    await conn.rollback();
  });

  it("🔴 tenant isolation: another organization reads none of these entries — through the audit reader, and under the database's own policy", async () => {
    const mine = ok(await h.api("admin", "GET", "/audit-logs?limit=200"));
    const theirs = ok(await h.api("outsider", "GET", "/audit-logs?limit=200"));
    const reportEntries = (logs: any[]) => logs.filter((l) => TYPES.includes(l.entityType));
    // what the reader serves: the admin reads an entry's state (the company with it); the request id is in the trail
    expect(reportEntries(mine.logs).length).toBeGreaterThan(5);
    expect(reportEntries(theirs.logs)).toEqual([]);
    expect(theirs.logs.every((l: any) => l.organizationId === otherOrgId)).toBe(true);
    // the outsider's own act is theirs alone
    const own = await h.api("outsider", "POST", "/report-definitions", body({ name: "S7AUD outsider" }));
    ok(own, 201);
    expect((await entries(otherOrgId)).map((e) => e.request_id)).toEqual([own.headers["x-request-id"]]);
    expect((await entries()).some((e) => e.request_id === own.headers["x-request-id"])).toBe(false);
    // the policy itself: the request's role, scoped to the other organization, sees none of this organization's rows
    const seenByOther = await h.inTenant(otherOrgId, (await pool.query(`SELECT id FROM companies WHERE organization_id = $1`, [otherOrgId])).rows[0].id, ids.outsider!, async () =>
      (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = ${orgId}`)).rows[0]!.n);
    expect(seenByOther).toBe(0);
  });

  it("🔴 no ordinary route can change an entry: the database refuses the request's role an UPDATE or a DELETE, and the audit routes only read", async () => {
    const [target] = await of("report_definition", "create", definitionId);
    for (const stmt of [
      sql`UPDATE audit_logs SET after_state = '{}'::jsonb WHERE id = ${target!.id}`,
      sql`UPDATE audit_logs SET request_id = 'x' WHERE id = ${target!.id}`,
      sql`DELETE FROM audit_logs WHERE id = ${target!.id}`,
    ]) {
      await expect(h.inTenant(orgId, companyId, ids.admin!, async () => { await db.execute(stmt); })).rejects.toThrow();
    }
    const after = (await pool.query(`SELECT after_state, request_id FROM audit_logs WHERE id = $1`, [target!.id])).rows[0];
    expect([after.after_state, after.request_id]).toEqual([target!.after_state, target!.request_id]);
    // the contract: every operation under /audit-logs is a GET
    const spec = readFileSync(join(__dirname, "../../../../packages/api-spec/openapi.yaml"), "utf8").split(/\r?\n/);
    const methods: string[] = [];
    let inAudit = false;
    for (const line of spec) {
      const path = /^  (\/[^:]*):\s*$/.exec(line);
      if (path) inAudit = path[1]!.startsWith("/audit-logs");
      const m = /^    (get|post|put|patch|delete):\s*$/.exec(line);
      if (inAudit && m) methods.push(m[1]!);
    }
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m) => m === "get")).toBe(true);
    // and on the wire: a write to an entry is not a route
    for (const method of ["PUT", "PATCH", "DELETE", "POST"]) {
      const r = await h.api("admin", method, `/audit-logs/${target!.id}`, method === "DELETE" ? undefined : { afterState: {} });
      // refused for want of a grant, or simply not a route — never carried out
      expect([method, r.status, [403, 404, 405].includes(r.status)]).toEqual([method, r.status, true]);
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE id = $1`, [target!.id])).rows[0].n).toBe(1);
  });
});
