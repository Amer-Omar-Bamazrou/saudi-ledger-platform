/**
 * 🔴 Phase 18 R-12 — DR-18 reading (c), step 2 (register §11.118): the submit route each new page control calls,
 * exercised the way the page calls it — over HTTP, as the preparer.
 *
 * For each of the five documents with a submit route and a page control (invoice, bill, payroll run, quotation,
 * purchase order): a BOOKKEEPER creates a draft and submits it (the document reads submitted); a VIEWER is refused
 * by the permission layer, by name; a second submit of the same document is refused (it is no longer a draft). The
 * three the approvals queue carries are listed there afterwards. The browser spec
 * (`e2e/phase18-r12-dr18-submit-controls.spec.ts`) walks the same five through their pages.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3224";
process.env.SESSION_SECRET ??= "r12-dr18-submit-routes-000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "R12SubmitPw123!";

describeMaybe("Phase 18 R-12 (DR-18 c) — each document's submit route, as its page control calls it", () => {
  const h = g04Harness("r12submit");
  let orgId = "";
  let customer = 0;
  let vendor = 0;
  const ok = (r: { status: number; body: any }, status: number, what: string) => { expect(r.status, `${what}: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(status); return r.body; };
  const statusOf = async (table: string, id: number) => (await pool.query(`SELECT status FROM ${table} WHERE id = $1`, [id])).rows[0]?.status;

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "R12 Co", "319191919196003");
    for (const r of ["admin", "bookkeeper", "viewer"]) await h.mkUser(r, PW, orgId, r);
    await h.start();
    for (const r of ["admin", "bookkeeper", "viewer"]) expect(await h.login(r, h.email(r), PW), `login ${r}`).toBe(200);
    customer = ok(await h.api("bookkeeper", "POST", "/customers", { name: "R12 Customer" }), 201, "customer").id;
    vendor = ok(await h.api("bookkeeper", "POST", "/vendors", { name: "R12 Supplier" }), 201, "vendor").id;
    ok(await h.api("bookkeeper", "POST", "/employees", { employeeNumber: "R12-EMP-1", name: "R12 Employee", basicSalary: 6000, status: "active", gosiRegime: "law_1421h" }), 201, "employee");
  }, 180_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  const DOCS: Array<{ name: string; path: string; table: string; queue: string | null; create: () => Promise<number> }> = [
    { name: "an invoice", path: "/invoices", table: "invoices", queue: "invoices",
      create: async () => ok(await h.api("bookkeeper", "POST", "/invoices", { invoiceNumber: `R12-INV-${Date.now()}`, date: "2026-10-05", dueDate: "2026-10-31", customerId: customer, items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] }), 201, "invoice").id },
    { name: "a bill", path: "/bills", table: "bills", queue: "bills",
      create: async () => ok(await h.api("bookkeeper", "POST", "/bills", { billNumber: `R12-B-${Date.now()}`, date: "2026-10-05", vendorId: vendor, items: [{ description: "Supply", quantity: 1, unitPrice: 500, vatRate: 0 }] }), 201, "bill").id },
    { name: "a payroll run", path: "/payroll", table: "payroll_runs", queue: "payroll",
      create: async () => ok(await h.api("bookkeeper", "POST", "/payroll", { period: "2026-09" }), 201, "payroll run").id },
    { name: "a quotation", path: "/quotations", table: "quotations", queue: null,
      create: async () => ok(await h.api("bookkeeper", "POST", "/quotations", { date: "2026-10-05", customerId: customer, items: [{ description: "Offer", quantity: 1, unitPrice: 100, vatRate: 15 }] }), 201, "quotation").id },
    { name: "a purchase order", path: "/purchase-orders", table: "purchase_orders", queue: null,
      create: async () => ok(await h.api("bookkeeper", "POST", "/purchase-orders", { date: "2026-10-05", vendorId: vendor, items: [{ description: "Order", quantity: 1, unitPrice: 100, vatRate: 15 }] }), 201, "purchase order").id },
  ];

  for (const d of DOCS) {
    it(`${d.name}: the bookkeeper submits the draft; a viewer is refused by name; a second submit is refused`, async () => {
      const id = await d.create();
      expect(await statusOf(d.table, id)).toBe("draft");
      const viewer = await h.api("viewer", "POST", `${d.path}/${id}/submit`, {});
      expect([viewer.status, viewer.body?.code], "a viewer is refused by the permission layer").toEqual([403, "requires_approval_authority"]);
      expect(await statusOf(d.table, id)).toBe("draft");
      ok(await h.api("bookkeeper", "POST", `${d.path}/${id}/submit`, {}), 200, `${d.name} submit`);
      expect(await statusOf(d.table, id)).toBe("submitted");
      expect((await h.api("bookkeeper", "POST", `${d.path}/${id}/submit`, {})).status, "no longer a draft").toBe(409);
      if (d.queue) {
        const queue = ok(await h.api("admin", "GET", "/approvals/pending"), 200, "queue") as Array<{ entity: string; id: number }>;
        expect(queue.some((r) => r.entity === d.queue && r.id === id), "the approvals queue lists it").toBe(true);
      }
    });
  }
});
