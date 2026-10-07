/**
 * 🔴 G04 — THE DATABASE REFUSES A CROSS-TENANT REFERENCE ITSELF, for the three
 * columns the sweep proved vulnerable beside the journal line (whose own suite
 * is `g04-journal-line-references`): the invoice line's product, the asset's
 * custodian, and the bill's asset to capitalise (migration 0122).
 *
 * Every refusal is tested by writing the reference DIRECTLY — as the app role
 * under RLS and as the owner with no RLS — so no service check can be what
 * passes the test. Each has its CONTROL (the tenant's own row is accepted) and,
 * where the model shares the entity across the organization's companies, a
 * SHARING control (the other company's write is accepted too):
 *   - products are ORGANIZATION-level: any company of the organization uses them;
 *   - a custodian must hold a MEMBERSHIP in the asset's organization — any
 *     status: whether an inactive member may stay a custodian is an OPEN
 *     decision, so neither status is refused here (owner, 2026-10-07);
 *   - a bill capitalises an asset of its OWN COMPANY only.
 */
process.env.PORT ??= "3127";
process.env.SESSION_SECRET ??= "g04-tenant-keys-database-secret-000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { assetsService } from "../services/assets.service";
import { invoicesService } from "../services/invoices.service";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G04KeysPw1!";
const MISSING = 2_000_000_000;
const TODAY = new Date().toISOString().slice(0, 10);

describeMaybe("G04 — composite tenant keys refuse a cross-tenant reference from every writer", () => {
  const h = g04Harness("g04k");
  const { api, inTenant } = h;
  const org: Record<string, string> = {};
  const co: Record<string, string> = {};
  const uid: Record<string, number> = {};
  const fx: Record<string, any> = {};

  /** UPDATE one column of one row, as the app role (under RLS, the row's own tenant) or as the owner; rolled back. */
  const write = async (asAppRole: boolean, tenant: { org: string; co: string }, sql: string, params: unknown[]) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      if (asAppRole) {
        await c.query("SET LOCAL ROLE authenticated");
        await c.query("SELECT set_config('app.current_org_id', $1, true), set_config('app.current_company_id', $2, true)", [tenant.org, tenant.co]);
      }
      const r = await c.query(sql, params);
      return r.rowCount === 1 ? "accepted" : `no row (${r.rowCount})`;
    } catch (e: any) {
      return `refused:${e.code}:${e.constraint}`;
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  };

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    org.x = await h.mkOrg("x");
    org.y = await h.mkOrg("y");
    co.x1 = await h.mkCompany(org.x, "G04K x1", "306060606060603");
    co.x2 = await h.mkCompany(org.x, "G04K x2", "306060606060613");
    co.y1 = await h.mkCompany(org.y, "G04K y1", "306060606060623");
    uid.x = await h.mkUser("x", PW, org.x);
    uid.y = await h.mkUser("y", PW, org.y);
    uid.xInactive = await h.mkUser("x-inactive", PW, org.x, "viewer", "inactive");
    uid.none = await h.mkUser("none", PW, null);
    uid.op = await h.mkUser("op", PW, null);
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [uid.op]);
    await h.start();
    for (const k of ["x", "y"]) expect(await h.login(k, h.email(k), PW)).toBe(200);
    for (const w of ["x", "y"] as const) {
      fx[w] = {
        product: (await pool.query(`INSERT INTO products (organization_id, name) VALUES ($1,$2) RETURNING id`, [org[w], `G04K product ${w}`])).rows[0].id,
        customer: (await api(w, "POST", "/customers", { name: `G04K customer ${w}` })).body.id,
        vendor: (await api(w, "POST", "/vendors", { name: `G04K vendor ${w}`, residency: "resident" })).body.id,
      };
      fx[w].category = (await api(w, "POST", "/asset-categories", { name: `G04K cat ${w}`, defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" })).body.id;
      fx[w].asset = (await api(w, "POST", "/assets", { name: `G04K asset ${w}`, categoryId: fx[w].category, acquisitionDate: TODAY, cost: 1000 })).body.id;
      const inv = await api(w, "POST", "/invoices", { invoiceNumber: `G04K-${w}`, date: TODAY, customerId: fx[w].customer, items: [{ description: "S", quantity: 1, unitPrice: 10, vatRate: 15 }] });
      expect(inv.status).toBe(201);
      fx[w].invoiceItem = (await pool.query(`SELECT id FROM invoice_items WHERE invoice_id = $1`, [inv.body.id])).rows[0].id;
      const bill = await api(w, "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: `G04K-${w}`, billNumber: `G04K-B-${w}`, date: TODAY, dueDate: TODAY, vendorId: fx[w].vendor, items: [{ description: "S", quantity: 1, unitPrice: 1000, vatRate: 0 }] });
      expect(bill.status).toBe(201);
      fx[w].bill = bill.body.id;
    }
    fx.x2 = {
      category: (await inTenant(org.x, co.x2, uid.x, () => assetsService.createCategory({ name: "G04K x2 cat", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, uid.x))).id,
    };
    fx.x2.asset = (await inTenant(org.x, co.x2, uid.x, () => assetsService.create({ name: "G04K x2 asset", categoryId: fx.x2.category, acquisitionDate: TODAY, cost: 1000 }, uid.x)) as any).id;
    const x2inv: any = await inTenant(org.x, co.x2, uid.x, () => invoicesService.create({ invoiceNumber: "G04K-x2", date: TODAY, customerId: fx.x.customer, items: [{ description: "S", quantity: 1, unitPrice: 10, vatRate: 15 }] }, uid.x));
    fx.x2.invoiceItem = (await pool.query(`SELECT id FROM invoice_items WHERE invoice_id = $1`, [x2inv.id])).rows[0].id;
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  const X1 = () => ({ org: org.x, co: co.x1 });
  const X2 = () => ({ org: org.x, co: co.x2 });
  for (const asAppRole of [true, false]) {
    const who = asAppRole ? "the app role, under RLS" : "the OWNER, with no RLS";

    it(`🔴 INVOICE LINE → PRODUCT: another organization's product, and a missing one, are refused — ${who}`, async () => {
      const set = (item: number, product: number, t = X1()) => write(asAppRole, t, `UPDATE invoice_items SET product_id = $1 WHERE id = $2`, [product, item]);
      expect(await set(fx.x.invoiceItem, fx.y.product)).toBe("refused:23503:invoice_items_product_tenant_fk");
      expect(await set(fx.x.invoiceItem, MISSING)).toBe("refused:23503:invoice_items_product_tenant_fk");
      expect(await set(fx.x.invoiceItem, fx.x.product), "CONTROL: its own product").toBe("accepted");
      expect(await set(fx.x2.invoiceItem, fx.x.product, X2()), "SHARING: the other company's line uses the organization's product").toBe("accepted");
    });

    it(`🔴 ASSET → CUSTODIAN: a user with no membership in the asset's organization is refused — ${who}`, async () => {
      const set = (asset: number, user: number, t = X1()) => write(asAppRole, t, `UPDATE fixed_assets SET custodian_user_id = $1 WHERE id = $2`, [user, asset]);
      expect(await set(fx.x.asset, uid.y), "another organization's member").toBe("refused:23503:fixed_assets_custodian_member_fk");
      expect(await set(fx.x.asset, uid.none), "an account with no membership").toBe("refused:23503:fixed_assets_custodian_member_fk");
      expect(await set(fx.x.asset, uid.op), "a platform operator (a member of nothing)").toBe("refused:23503:fixed_assets_custodian_member_fk");
      expect(await set(fx.x.asset, MISSING), "a missing user").toBe("refused:23503:fixed_assets_custodian_member_fk");
      expect(await set(fx.x.asset, uid.x), "CONTROL: an active member").toBe("accepted");
      expect(await set(fx.x.asset, uid.xInactive), "OPEN DECISION: an inactive member is NOT refused").toBe("accepted");
      expect(await set(fx.x2.asset, uid.x, X2()), "SHARING: a member of the organization is custodian of its other company's asset").toBe("accepted");
    });

    it(`🔴 BILL → ASSET TO CAPITALISE: another company's asset, another organization's, and a missing one are refused — ${who}`, async () => {
      const set = (bill: number, asset: number) => write(asAppRole, X1(), `UPDATE bills SET capitalises_asset_id = $1 WHERE id = $2`, [asset, bill]);
      expect(await set(fx.x.bill, fx.x2.asset), "the same organization's OTHER company").toBe("refused:23503:bills_capitalises_asset_tenant_fk");
      expect(await set(fx.x.bill, fx.y.asset), "another organization").toBe("refused:23503:bills_capitalises_asset_tenant_fk");
      expect(await set(fx.x.bill, MISSING), "missing").toBe("refused:23503:bills_capitalises_asset_tenant_fk");
      expect(await set(fx.x.bill, fx.x.asset), "CONTROL: its own company's asset").toBe("accepted");
    });
  }

  it("deleting a product still works and clears ONLY the reference — the line keeps its organization", async () => {
    const p = (await pool.query(`INSERT INTO products (organization_id, name) VALUES ($1,'G04K to delete') RETURNING id`, [org.x])).rows[0].id;
    await pool.query(`UPDATE invoice_items SET product_id = $1 WHERE id = $2`, [p, fx.x.invoiceItem]);
    await pool.query(`DELETE FROM products WHERE id = $1`, [p]);
    expect((await pool.query(`SELECT organization_id, product_id FROM invoice_items WHERE id = $1`, [fx.x.invoiceItem])).rows[0]).toEqual({ organization_id: org.x, product_id: null });
  });

  it("removing a member (status inactive) keeps it valid as a custodian — nothing existing is invalidated", async () => {
    await pool.query(`UPDATE fixed_assets SET custodian_user_id = $1 WHERE id = $2`, [uid.x, fx.x.asset]);
    await pool.query(`UPDATE organization_memberships SET status = 'inactive' WHERE user_id = $1 AND organization_id = $2`, [uid.x, org.x]);
    try {
      expect((await pool.query(`SELECT custodian_user_id FROM fixed_assets WHERE id = $1`, [fx.x.asset])).rows[0].custodian_user_id).toBe(uid.x);
    } finally {
      await pool.query(`UPDATE organization_memberships SET status = 'active' WHERE user_id = $1 AND organization_id = $2`, [uid.x, org.x]);
    }
  });

  it("🔴 API: the refusals surface as ONE controlled 422 reference_not_found — never a raw 500 or a database sentence", async () => {
    const custodian = (v: number) => api("x", "POST", "/assets", { name: "G04K api", categoryId: fx.x.category, acquisitionDate: TODAY, cost: 100, custodianUserId: v });
    const foreign = await custodian(uid.y);
    const missing = await custodian(MISSING);
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(422);
    expect(foreign.body.code).toBe("reference_not_found");
    expect(missing.body).toEqual(foreign.body);
    expect(JSON.stringify(foreign.body)).not.toMatch(/violates|foreign key|organization_memberships|Key \(/i);
    expect(Number((await pool.query(`SELECT count(*)::int AS n FROM fixed_assets WHERE organization_id = $1 AND name = 'G04K api'`, [org.x])).rows[0].n), "no asset written").toBe(0);
  });
});
