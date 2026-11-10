/**
 * 🔴 Phase 18 audit (2026-11-09), finding A17 — G11's "queue completeness": a submitted quotation, purchase order or
 * budget version reaches the approvers' queue.
 *
 * G11's control: "Queue completeness; approve-scoped listing; own-item flag." H-11/R-12 built the audience half
 * (DR-18: rows only for a role holding APPROVE on the resource) for seven entity types. Quotations, purchase orders
 * and budget versions each have a submitted state and their own approve, send-back and reject routes, and none of
 * them was in `/approvals/pending`: a preparer submitted, and no approver was ever shown it.
 *
 * Presence, absence, movement: an approver (admin, accountant) sees each submitted item; a bookkeeper (no APPROVE on
 * these resources) sees none of them; an approved quotation leaves the queue. DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3399";
process.env.SESSION_SECRET ??= "phase18-audit-a17-queue-completeness-001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditA17QueueCompletePw1!";

type Row = { entity: string; id: number; parentId?: number | null; status: string; label: string; own: boolean };

describeMaybe("Phase 18 audit A17 — submitted quotations, purchase orders and budgets reach the approvals queue", () => {
  const h = g04Harness("auda17");
  let orgId = "", customerId = 0, vendorId = 0;
  let quotationId = 0, orderId = 0, budgetId = 0, versionId = 0;

  const queue = async (who: string) => {
    const r = await h.api(who, "GET", "/approvals/pending");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as Row[];
  };
  const find = (rows: Row[], entity: string, id: number) => rows.find((r) => r.entity === entity && r.id === id);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Audit A17 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
    for (const [who, role] of [["admin", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"]] as const) await h.mkUser(who, PW, orgId, role);
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'A17 Buyer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'A17 Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);

    const items = [{ description: "Service", quantity: 1, unitPrice: 1_000, vatRate: 15 }];
    const q = await h.api("bookkeeper", "POST", "/quotations", { customerId, date: "2026-10-05", items });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    quotationId = q.body.id;
    expect((await h.api("bookkeeper", "POST", `/quotations/${quotationId}/submit`, {})).status).toBe(200);

    const po = await h.api("bookkeeper", "POST", "/purchase-orders", { vendorId, date: "2026-10-05", items });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    orderId = po.body.id;
    expect((await h.api("bookkeeper", "POST", `/purchase-orders/${orderId}/submit`, {})).status).toBe(200);

    const b = await h.api("bookkeeper", "POST", "/budgets", { name: "A17 Budget", nameAr: "موازنة", fiscalYearLabel: 2026, scenario: "base", notes: "" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    budgetId = b.body.id;
    versionId = b.body.versions[0].id;
    const rent = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'RENT_UTILITIES'`, [orgId])).rows[0].id;
    const lines = await h.api("bookkeeper", "PUT", `/budgets/${budgetId}/versions/${versionId}/lines`, { lines: [{ accountId: rent, annualAmount: 12_000 }] });
    expect(lines.status, JSON.stringify(lines.body)).toBe(200);
    expect((await h.api("bookkeeper", "POST", `/budgets/${budgetId}/versions/${versionId}/submit`, {})).status).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  for (const who of ["admin", "accountant"]) {
    it(`🔴 presence: ${who} (APPROVE on the resource) sees the submitted quotation, purchase order and budget version`, async () => {
      const rows = await queue(who);
      expect(find(rows, "quotations", quotationId)).toMatchObject({ status: "submitted", own: false });
      expect(find(rows, "purchase-orders", orderId)).toMatchObject({ status: "submitted", own: false });
      expect(find(rows, "budgets", versionId)).toMatchObject({ status: "submitted", parentId: budgetId, own: false });
    });
  }

  it("absence: a bookkeeper (no APPROVE on these resources) sees none of them — the queue is an approver's worklist", async () => {
    const rows = await queue("bookkeeper");
    expect(rows.filter((r) => ["quotations", "purchase-orders", "budgets"].includes(r.entity))).toEqual([]);
  });

  it("🔴 movement: the approved quotation leaves the queue; the others stay", async () => {
    expect((await h.api("accountant", "POST", `/quotations/${quotationId}/approve`, {})).status).toBe(200);
    const rows = await queue("admin");
    expect(find(rows, "quotations", quotationId)).toBeUndefined();
    expect(find(rows, "purchase-orders", orderId)).toBeDefined();
    expect(find(rows, "budgets", versionId)).toBeDefined();
  });
});
