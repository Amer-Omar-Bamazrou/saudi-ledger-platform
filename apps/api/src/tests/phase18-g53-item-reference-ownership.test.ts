/**
 * 🔴 G53 (Phase 18, B-SMALL-3) — PROOF FIRST: G04'S SIBLING COLUMNS. A
 * document line's PRODUCT and a recognition schedule's VENDOR are proven the
 * organization's own before they are stored.
 *
 * G04 (migration 0122, `services/accounting/tenantReferences.ts`) proved every
 * journal line's account/customer/vendor and every INVOICE line's product owned
 * — explicitly, not by RLS visibility, because Postgres checks a foreign key
 * OUTSIDE RLS. Four sibling columns were not swept and still carry plain keys:
 *
 *   bill_items.product_id            POST /bills
 *   quotation_items.product_id       POST /quotations, PATCH /quotations/{id}
 *   purchase_order_items.product_id  POST /purchase-orders, PATCH /purchase-orders/{id}
 *   recognition_schedules.vendor_id  POST /recognition-schedules
 *
 * So another organization's id is STORED (the key finds the row, RLS is not
 * asked), and an id that exists nowhere fails the key as a raw 23503 — a 500,
 * and 201-vs-500 tells any tenant which ids exist on the platform.
 *
 * THE INVARIANT (G04's): foreign ≡ missing ≡ 422 `reference_not_found`, naming
 * the field, with a BYTE-IDENTICAL body for the two; nothing written; never a
 * 5xx. Asserted through the product's own HTTP path, with:
 *   - PRESENCE: the organization's own product / vendor is accepted and stored;
 *   - ABSENCE: no row of org A names org B's product or vendor afterwards;
 *   - MOVEMENT: org B uses the very same product and vendor on its own
 *     documents, so the refusal is about ownership, not a broken id;
 *   - a DETECTOR that is shown to see a planted edge in each of the four
 *     columns before its zero is believed.
 */
process.env.PORT ??= "3216";
process.env.SESSION_SECRET ??= "g53-item-reference-ownership-secret-00001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { __resetRateLimitsForTests } from "../routes/auth";
import { g04Harness, type Res } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G53ProofPw1!";
const MISSING = 2_000_000_000;
const TODAY = businessToday();

type Who = "a" | "b";
const ZERO = { bill_items: 0, quotation_items: 0, purchase_order_items: 0, recognition_schedules: 0 };

describeMaybe("G53 — a line's product and a schedule's vendor are the organization's own", () => {
  const h = g04Harness("g53p");
  const { api } = h;
  const org: Record<string, string> = {};
  const fx: Record<string, Record<string, number>> = {};
  const ctl: Record<string, number> = {};
  let n = 0;

  const ok = (r: Res, what: string) => {
    if (r.status < 200 || r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  };
  const sys = async (who: Who, code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [org[who], code])).rows[0].id as number;

  const billBody = (who: Who, productId: number) => ({
    supplierDocumentKind: "tax_invoice", vendorReference: `G53-VR${++n}`, billNumber: `G53-B${n}`, date: TODAY, dueDate: TODAY, vendorId: fx[who].vendor,
    items: [{ description: "Supply", quantity: 1, unitPrice: 100, vatRate: 15, productId }],
  });
  const quoteItems = (productId: number) => [{ description: "Quoted", quantity: 1, unitPrice: 10, productId }];
  const quoteBody = (who: Who, productId: number) => ({ date: TODAY, customerId: fx[who].customer, items: quoteItems(productId) });
  const poItems = (productId: number) => [{ description: "Ordered", quantity: 1, unitPrice: 10, productId }];
  const poBody = (who: Who, productId: number) => ({ date: TODAY, vendorId: fx[who].vendor, items: poItems(productId) });
  const scheduleBody = (who: Who, vendorId: number) => ({
    kind: "accrual", description: "G53 accrual", totalAmount: 300, periods: 3, startPeriod: TODAY.slice(0, 7),
    expenseAccountId: fx[who].expense, balanceAccountId: fx[who].accrued, vendorId, reference: `G53-RS${++n}`,
  });

  /** Every row of org A that names ANOTHER organization's product or vendor, per column. */
  const crossEdges = async (c: { query: typeof pool.query } = pool) => (await c.query(
    `SELECT
       (SELECT count(*)::int FROM bill_items i JOIN products p ON p.id = i.product_id WHERE i.organization_id = $1 AND p.organization_id <> $1) AS bill_items,
       (SELECT count(*)::int FROM quotation_items i JOIN products p ON p.id = i.product_id WHERE i.organization_id = $1 AND p.organization_id <> $1) AS quotation_items,
       (SELECT count(*)::int FROM purchase_order_items i JOIN products p ON p.id = i.product_id WHERE i.organization_id = $1 AND p.organization_id <> $1) AS purchase_order_items,
       (SELECT count(*)::int FROM recognition_schedules s JOIN vendors v ON v.id = s.vendor_id WHERE s.organization_id = $1 AND v.organization_id <> $1) AS recognition_schedules`,
    [org.a],
  )).rows[0];

  /** What org A holds: row counts of every table these requests write, and the control drafts' lines exactly. */
  const written = async () => {
    const count = async (t: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id = $1`, [org.a])).rows[0].n);
    const out: Record<string, unknown> = {};
    for (const t of ["bills", "bill_items", "quotations", "quotation_items", "purchase_orders", "purchase_order_items", "recognition_schedules"]) out[t] = await count(t);
    out.controlQuotationLines = (await pool.query(`SELECT id, product_id, description FROM quotation_items WHERE quotation_id = $1 ORDER BY id`, [ctl.quotation])).rows;
    out.controlOrderLines = (await pool.query(`SELECT id, product_id, description FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY id`, [ctl.order])).rows;
    return out;
  };

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    await h.start();
    org.a = await h.mkOrg("a");
    org.b = await h.mkOrg("b");
    await h.mkCompany(org.a, "G53 A", "309090909090903");
    await h.mkCompany(org.b, "G53 B", "309090909090913");
    for (const w of ["a", "b"] as const) {
      await h.mkUser(w, PW, org[w]);
      expect(await h.login(w, h.email(w), PW)).toBe(200);
      fx[w] = {
        product: ok(await api(w, "POST", "/products", { name: `G53 product ${w}`, unitPrice: 10 }), `${w} product`).id,
        vendor: ok(await api(w, "POST", "/vendors", { name: `G53 vendor ${w}`, residency: "resident" }), `${w} vendor`).id,
        customer: ok(await api(w, "POST", "/customers", { name: `G53 customer ${w}` }), `${w} customer`).id,
        expense: await sys(w, "RENT_UTILITIES"),
        accrued: await sys(w, "ACCRUED_LIABILITIES"),
      };
    }
  }, 120_000);
  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("CONTROL (presence + movement) — each organization's OWN product and vendor are accepted and stored", async () => {
    // Org A, its own ids — the drafts the PATCH cases below edit.
    const bill = ok(await api("a", "POST", "/bills", billBody("a", fx.a.product)), "A bill");
    ctl.quotation = ok(await api("a", "POST", "/quotations", quoteBody("a", fx.a.product)), "A quotation").id;
    ctl.order = ok(await api("a", "POST", "/purchase-orders", poBody("a", fx.a.product)), "A order").id;
    const schedule = ok(await api("a", "POST", "/recognition-schedules", scheduleBody("a", fx.a.vendor)), "A schedule");
    expect((await pool.query(`SELECT product_id FROM bill_items WHERE bill_id = $1`, [bill.id])).rows).toEqual([{ product_id: fx.a.product }]);
    expect((await pool.query(`SELECT product_id FROM quotation_items WHERE quotation_id = $1`, [ctl.quotation])).rows).toEqual([{ product_id: fx.a.product }]);
    expect((await pool.query(`SELECT product_id FROM purchase_order_items WHERE purchase_order_id = $1`, [ctl.order])).rows).toEqual([{ product_id: fx.a.product }]);
    expect((await pool.query(`SELECT vendor_id FROM recognition_schedules WHERE id = $1`, [schedule.id])).rows).toEqual([{ vendor_id: fx.a.vendor }]);
    ctl.billItem = (await pool.query(`SELECT id FROM bill_items WHERE bill_id = $1`, [bill.id])).rows[0].id;
    ctl.schedule = schedule.id;

    // Org B uses the very ids org A will be refused: they are real, and usable by their owner.
    for (const [path, body] of [
      ["/bills", billBody("b", fx.b.product)],
      ["/quotations", quoteBody("b", fx.b.product)],
      ["/purchase-orders", poBody("b", fx.b.product)],
      ["/recognition-schedules", scheduleBody("b", fx.b.vendor)],
    ] as const) {
      expect((await api("b", "POST", path, body)).status, `org B, its own id, POST ${path}`).toBe(201);
    }
    expect(await crossEdges()).toEqual(ZERO);
  });

  it("the detector SEES a planted edge in each of the four columns (anti-vacuity)", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`UPDATE bill_items SET product_id = $1 WHERE id = $2`, [fx.b.product, ctl.billItem]);
      await c.query(`UPDATE quotation_items SET product_id = $1 WHERE quotation_id = $2`, [fx.b.product, ctl.quotation]);
      await c.query(`UPDATE purchase_order_items SET product_id = $1 WHERE purchase_order_id = $2`, [fx.b.product, ctl.order]);
      await c.query(`UPDATE recognition_schedules SET vendor_id = $1 WHERE id = $2`, [fx.b.vendor, ctl.schedule]);
      expect(await crossEdges(c)).toEqual({ bill_items: 1, quotation_items: 1, purchase_order_items: 1, recognition_schedules: 1 });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    expect(await crossEdges()).toEqual(ZERO);
  });

  const cases: Array<{ name: string; field: string; foreign: () => number; send: (id: number) => Promise<Res> }> = [
    { name: "POST /bills", field: "items[0].productId", foreign: () => fx.b.product, send: (id) => api("a", "POST", "/bills", billBody("a", id)) },
    { name: "POST /quotations", field: "items[0].productId", foreign: () => fx.b.product, send: (id) => api("a", "POST", "/quotations", quoteBody("a", id)) },
    { name: "PATCH /quotations/{id}", field: "items[0].productId", foreign: () => fx.b.product, send: (id) => api("a", "PATCH", `/quotations/${ctl.quotation}`, { items: quoteItems(id) }) },
    { name: "POST /purchase-orders", field: "items[0].productId", foreign: () => fx.b.product, send: (id) => api("a", "POST", "/purchase-orders", poBody("a", id)) },
    { name: "PATCH /purchase-orders/{id}", field: "items[0].productId", foreign: () => fx.b.product, send: (id) => api("a", "PATCH", `/purchase-orders/${ctl.order}`, { items: poItems(id) }) },
    { name: "POST /recognition-schedules", field: "vendorId", foreign: () => fx.b.vendor, send: (id) => api("a", "POST", "/recognition-schedules", scheduleBody("a", id)) },
  ];

  for (const c of cases) {
    it(`🔴 PROOF — ${c.name}: another organization's id ≡ a missing one ≡ 422 reference_not_found on ${c.field}; nothing written`, async () => {
      const before = await written();
      const foreign = await c.send(c.foreign());
      expect({ status: foreign.status, code: foreign.body?.code, field: foreign.body?.field }, JSON.stringify(foreign.body).slice(0, 300))
        .toEqual({ status: 422, code: "reference_not_found", field: c.field });
      const missing = await c.send(MISSING);
      expect({ status: missing.status, body: missing.body }, "the missing id's refusal is byte-identical to the foreign one's")
        .toEqual({ status: foreign.status, body: foreign.body });
      expect(await written(), "nothing written by either refusal").toEqual(before);
      expect(await crossEdges()).toEqual(ZERO);
    });
  }
});
