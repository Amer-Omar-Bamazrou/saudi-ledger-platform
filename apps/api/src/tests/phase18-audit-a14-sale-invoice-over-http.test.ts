/**
 * 🔴 Phase 18 audit (2026-11-11), finding A14, its contract half — an invoice that SELLS a fixed asset can be made over
 * HTTP.
 *
 * FA-C's sale invoice names the asset it sells (`disposesAssetId`): its revenue line credits the disposal gain/loss and
 * approval derecognises the asset. The service accepts the field; the contract did not — `CreateInvoiceInput` and
 * `UpdateInvoiceInput` had no `disposesAssetId`, and the controller parses the body with the generated schema, which
 * DROPS keys it does not know. So over HTTP the field vanished and an ordinary invoice was created. FA-C's tests call
 * `invoicesService.create` directly — below the layer that dropped it (CLAUDE.md §3, "a server test cannot see the
 * client's request construction"). The browser spec for A14's screen found it.
 *
 * Presence, absence, movement: a create over HTTP keeps the asset; a draft edit over HTTP sets it; an ordinary invoice
 * names none; approving the sale disposes of the asset. DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3395";
process.env.SESSION_SECRET ??= "phase18-audit-a14-sale-invoice-http1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { releaseIssuedInvoicesForTeardown } from "./helpers/issuedInvoiceFixtures";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditA14SaleOverHttpPw1!";

describeMaybe("Phase 18 audit A14 — a sale invoice keeps the asset it sells, over HTTP", () => {
  const h = g04Harness("auda14");
  let orgId = "", customerId = 0, vendorId = 0, assetId = 0, otherAssetId = 0;

  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await h.api("admin", method, path, body);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body;
  };
  const inService = async (name: string) => {
    const categoryId = (await ok("POST", "/asset-categories", { name: `${name} category`, defaultUsefulLifeMonths: 60, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" })).id;
    const asset = await ok("POST", "/assets", { name, categoryId, acquisitionDate: "2026-01-05", availableForUseDate: "2026-01-05", cost: 1000 });
    const bill = await ok("POST", "/bills", {
      vendorId, billNumber: `A14-CAP-${name}`, supplierDocumentKind: "tax_invoice", vendorReference: `A14-SUP-${name}`,
      date: "2026-01-05", dueDate: "2026-02-05", subtotal: 1000, vatAmount: 150, total: 1150, items: [], capitalisesAssetId: asset.id,
    });
    await ok("POST", `/bills/${bill.id}/approve`, {});
    expect((await ok("GET", `/assets/${asset.id}`)).status).toBe("in_service");
    return asset.id as number;
  };
  const stored = async (invoiceId: number) =>
    (await pool.query(`SELECT disposes_asset_id FROM invoices WHERE id = $1`, [invoiceId])).rows[0]?.disposes_asset_id ?? null;
  const items = [{ description: "Used equipment", quantity: 1, unitPrice: 500, vatRate: 15 }];

  beforeAll(async () => {
    await releaseIssuedInvoicesForTeardown(`organization_id IN (SELECT id FROM organizations WHERE slug LIKE 'auda14-%')`);
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Audit A14 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'A14 Buyer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'A14 Machine Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    assetId = await inService("A14-LATHE");
    otherAssetId = await inService("A14-PRESS");
  }, 180_000);

  afterAll(async () => {
    await h.stop();
    await releaseIssuedInvoicesForTeardown(`organization_id = $1`, [orgId]);
    await h.cleanup();
  });

  it("🔴 a create over HTTP keeps the asset the invoice sells — in the answer and in the row", async () => {
    const inv = await ok("POST", "/invoices", { invoiceNumber: "A14-SALE-1", date: "2026-06-01", customerId, disposesAssetId: assetId, items });
    expect(inv.disposesAssetId).toBe(assetId);
    expect(await stored(inv.id)).toBe(assetId);
  });

  it("🔴 a draft edit over HTTP sets the asset a draft sells", async () => {
    const inv = await ok("POST", "/invoices", { invoiceNumber: "A14-SALE-2", date: "2026-06-01", customerId, items });
    expect(await stored(inv.id), "absence: an ordinary invoice sells nothing").toBeNull();
    const edited = await ok("PATCH", `/invoices/${inv.id}`, { disposesAssetId: otherAssetId });
    expect(edited.disposesAssetId).toBe(otherAssetId);
    expect(await stored(inv.id)).toBe(otherAssetId);
  });

  it("🔴 movement: approving the sale made over HTTP disposes of the asset", async () => {
    const sale = (await pool.query(`SELECT id FROM invoices WHERE organization_id = $1 AND invoice_number = 'A14-SALE-1'`, [orgId])).rows[0].id as number;
    await ok("POST", `/invoices/${sale}/approve`, {});
    expect((await ok("GET", `/assets/${assetId}`)).status).toBe("disposed");
    expect((await ok("GET", `/assets/${otherAssetId}`)).status, "the other asset's draft is not approved: still in service").toBe("in_service");
  });
});
