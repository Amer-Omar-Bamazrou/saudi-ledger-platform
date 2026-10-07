/**
 * 🔴 G04 — EACH LAYER REFUSES ON ITS OWN. The services refuse a foreign or
 * missing reference BEFORE the database is asked to store it.
 *
 * The protection is layered: the service (or seam, approval, reversal) refuses
 * in words, and the database key (0122) refuses beneath every writer. A layered
 * defence hides a removed layer — the one below still holds, the API still
 * answers 422, and every end-to-end test stays green. So this file proves the
 * SERVICE layer independently: the repository write the request would make is
 * SPIED, and must NOT be called when the reference is not owned (each spy has
 * its positive control: the same call with an owned id DOES write).
 *
 * The custodian has no service layer by design: the business layer may not read
 * `organization_memberships` (CLAUDE.md §4), so the database key alone holds it
 * (`g04-tenant-keys-database` proves that key, as the app role and the owner).
 */
process.env.PORT ??= "3128";
process.env.SESSION_SECRET ??= "g04-service-refusals-secret-0000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, beginTenantConnection, db, categoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { assertLineReferencesOwned, assertProductsOwned, assertAssetOwnedByCompany } from "../services/accounting/tenantReferences";
import { __resetRateLimitsForTests } from "../routes/auth";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { assetsService } from "../services/assets.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { invoicesRepository } from "../repositories/invoices.repository";
import { billsRepository } from "../repositories/bills.repository";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G04ServicePw1!";
const TODAY = new Date().toISOString().slice(0, 10);

describeMaybe("G04 — the service layer refuses before the database is asked", () => {
  const h = g04Harness("g04v");
  const org: Record<string, string> = {};
  const co: Record<string, string> = {};
  const uid: Record<string, number> = {};
  const fx: Record<string, any> = {};
  const inX = <T,>(fn: () => Promise<T>) => h.inTenant(org.x, co.x1, uid.x, fn);
  const inX2 = <T,>(fn: () => Promise<T>) => h.inTenant(org.x, co.x2, uid.x, fn);
  const inY = <T,>(fn: () => Promise<T>) => h.inTenant(org.y, co.y1, uid.y, fn);
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ status: e?.statusCode, code: e?.payload?.code, field: e?.payload?.field }));
  const sys = async (o: string, code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [o, code])).rows[0].id as number;
  const invoiceBody = (productId?: number) => ({ invoiceNumber: `G04V-${Math.random().toString(36).slice(2, 9)}`, date: TODAY, customerId: fx.x.customer, items: [{ description: "S", quantity: 1, unitPrice: 10, vatRate: 15, ...(productId ? { productId } : {}) }] });
  const billBody = (capitalisesAssetId?: number) => ({
    supplierDocumentKind: "tax_invoice", vendorReference: `G04V-${Math.random().toString(36).slice(2, 9)}`, date: TODAY, dueDate: TODAY, vendorId: fx.x.vendor,
    items: [{ description: "Asset", quantity: 1, unitPrice: 1000, vatRate: 0 }], ...(capitalisesAssetId ? { capitalisesAssetId } : {}),
  });
  const entry = (accountId: number) => ({ entryNumber: `G04V-${Math.random().toString(36).slice(2, 9)}`, date: TODAY, description: "service layer", lines: [
    { accountId, accountName: "debit", debitAmount: 100, creditAmount: 0 },
    { accountId: fx.x.income, accountName: "credit", debitAmount: 0, creditAmount: 100 }] });

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    org.x = await h.mkOrg("x");
    org.y = await h.mkOrg("y");
    co.x1 = await h.mkCompany(org.x, "G04V x1", "307070707070703");
    co.x2 = await h.mkCompany(org.x, "G04V x2", "307070707070713");
    co.y1 = await h.mkCompany(org.y, "G04V y1", "307070707070723");
    uid.x = await h.mkUser("x", PW, org.x);
    uid.y = await h.mkUser("y", PW, org.y);
    for (const [w, run] of [["x", inX], ["y", inY]] as const) {
      fx[w] = {
        product: (await pool.query(`INSERT INTO products (organization_id, name) VALUES ($1,$2) RETURNING id`, [org[w], `G04V product ${w}`])).rows[0].id,
        customer: (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,$2) RETURNING id`, [org[w], `G04V customer ${w}`])).rows[0].id,
        vendor: (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,$2) RETURNING id`, [org[w], `G04V vendor ${w}`])).rows[0].id,
        expense: await sys(org[w], "RENT_UTILITIES"),
        income: await sys(org[w], "OTHER_INCOME"),
      };
      const cat: any = await run(() => assetsService.createCategory({ name: `G04V cat ${w}`, defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, uid[w]));
      fx[w].asset = ((await run(() => assetsService.create({ name: `G04V asset ${w}`, categoryId: cat.id, acquisitionDate: TODAY, cost: 1000 }, uid[w]))) as any).id;
    }
    const cat2: any = await inX2(() => assetsService.createCategory({ name: "G04V cat x2", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, uid.x));
    fx.x2 = { asset: ((await inX2(() => assetsService.create({ name: "G04V asset x2", categoryId: cat2.id, acquisitionDate: TODAY, cost: 1000 }, uid.x))) as any).id };
  }, 120_000);

  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await h.cleanup(); });

  it("🔴 the ownership check does NOT rely on RLS: with RLS bypassed (the owner role, X's GUCs set), another tenant's rows are still refused", async () => {
    const conn = await beginTenantConnection({ organizationId: org.x, companyId: co.x1, role: "postgres" });
    try {
      await conn.run(async () => {
        // Precondition, on THIS connection: RLS is off, so the other tenant's account is visible.
        const seen = await db.select({ id: categoriesTable.id }).from(categoriesTable).where(eq(categoriesTable.id, fx.y.expense));
        expect(seen.length, "precondition: this connection can SEE the other tenant's account").toBe(1);
        for (const refs of [{ accountId: fx.y.expense }, { customerId: fx.y.customer }, { vendorId: fx.y.vendor }]) {
          await expect(assertLineReferencesOwned([refs])).rejects.toMatchObject({ statusCode: 422 });
        }
        await expect(assertProductsOwned([{ productId: fx.y.product }])).rejects.toMatchObject({ statusCode: 422 });
        await expect(assertAssetOwnedByCompany(fx.y.asset, "capitalisesAssetId")).rejects.toMatchObject({ statusCode: 422 });
        await expect(assertAssetOwnedByCompany(fx.x2.asset, "capitalisesAssetId"), "the other company's, too").rejects.toMatchObject({ statusCode: 422 });
        // CONTROL: the tenant's own rows pass on the same connection.
        await expect(assertLineReferencesOwned([{ accountId: fx.x.expense, customerId: fx.x.customer, vendorId: fx.x.vendor }])).resolves.toBeUndefined();
        await expect(assertProductsOwned([{ productId: fx.x.product }])).resolves.toBeUndefined();
        await expect(assertAssetOwnedByCompany(fx.x.asset, "capitalisesAssetId")).resolves.toBeUndefined();
      });
    } finally {
      await conn.rollback();
    }
  });

  it("INVOICE create: another tenant's product is refused by the service — no invoice or line is written", async () => {
    const insert = vi.spyOn(invoicesRepository, "insert");
    const items = vi.spyOn(invoicesRepository, "insertItems");
    expect(await refusal(inX(() => invoicesService.create(invoiceBody(fx.y.product), uid.x)))).toEqual({ status: 422, code: "reference_not_found", field: "items[0].productId" });
    expect(insert).not.toHaveBeenCalled();
    expect(items).not.toHaveBeenCalled();
    // positive control: the spy sees the write for an owned product
    await inX(() => invoicesService.create(invoiceBody(fx.x.product), uid.x));
    expect(items).toHaveBeenCalledTimes(1);
  });

  it("INVOICE draft edit: another tenant's product is refused by the service — the draft's lines are not touched", async () => {
    const draft: any = await inX(() => invoicesService.create(invoiceBody(), uid.x));
    const del = vi.spyOn(invoicesRepository, "deleteItems");
    expect(await refusal(inX(() => invoicesService.update(draft.id, { items: invoiceBody(fx.y.product).items } as any, uid.x)))).toMatchObject({ status: 422, code: "reference_not_found", field: "items[0].productId" });
    expect(del).not.toHaveBeenCalled();
    await inX(() => invoicesService.update(draft.id, { items: invoiceBody(fx.x.product).items } as any, uid.x));
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("BILL create: the other company's asset and another tenant's are refused by the service — no bill is written", async () => {
    const insert = vi.spyOn(billsRepository, "insert");
    for (const asset of [fx.x2.asset, fx.y.asset]) {
      expect(await refusal(inX(() => billsService.create(billBody(asset) as any, uid.x)))).toEqual({ status: 422, code: "reference_not_found", field: "capitalisesAssetId" });
    }
    expect(insert).not.toHaveBeenCalled();
    await inX(() => billsService.create(billBody(fx.x.asset) as any, uid.x));
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("BILL update: another tenant's asset is refused by the service — the bill is not updated", async () => {
    const draft: any = await inX(() => billsService.create(billBody() as any, uid.x));
    const update = vi.spyOn(billsRepository, "update");
    expect(await refusal(inX(() => billsService.update(draft.id, { capitalisesAssetId: fx.y.asset } as any, uid.x)))).toMatchObject({ status: 422, code: "reference_not_found", field: "capitalisesAssetId" });
    expect(update).not.toHaveBeenCalled();
  });

  it("JOURNAL create: another tenant's account is refused by the service — no entry is written", async () => {
    const insert = vi.spyOn(journalEntriesRepository, "insertEntry");
    expect(await refusal(inX(() => journalEntriesService.create(entry(fx.y.expense) as any, uid.x)))).toEqual({ status: 422, code: "reference_not_found", field: "lines[0].accountId" });
    expect(insert).not.toHaveBeenCalled();
    await inX(() => journalEntriesService.create(entry(fx.x.expense) as any, uid.x));
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("JOURNAL reverse: a stored line on another tenant's account is refused by the service — no mirror entry is written", async () => {
    const je: any = await inX(async () => {
      const d: any = await journalEntriesService.create(entry(fx.x.expense) as any, uid.x);
      return journalEntriesService.approve(d.id, uid.x);
    });
    const lineId = (await pool.query(`SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 AND debit_amount > 0`, [je.id])).rows[0].id;
    const plant = async (accountId: number) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role = replica"); // below every check: approval/reversal tested on their own
        await c.query(`UPDATE journal_entry_lines SET account_id = $1 WHERE id = $2`, [accountId, lineId]);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
    };
    await plant(fx.y.expense);
    try {
      const insert = vi.spyOn(journalEntriesRepository, "insertEntry");
      // The per-LINE field is the service's; the database fallback names only "lines".
      expect(await refusal(inX(() => journalEntriesService.reverse(je.id, { date: TODAY })))).toEqual({ status: 422, code: "reference_not_found", field: expect.stringMatching(/^lines\[\d+\]\.accountId$/) });
      expect(insert).not.toHaveBeenCalled();
    } finally {
      await plant(fx.x.expense);
    }
  });
});
