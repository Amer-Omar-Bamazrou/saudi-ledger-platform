/**
 * 🔴 Phase 18 H-3 — DR-37 (OD-15; F-16), asset half; DR-03's G63: "Asset
 * sales: mirror the original's account (a correction under DR-03)." DECIDED
 * 2026-10-27 — owner accepted the stated recommendation (register §11.49, the
 * scoped D-4 statement, appended before this file). IAS 16.68/16.72: the
 * disposal gain or loss, never Sales.
 *
 *  - a CREDIT note against an invoice that sold a fixed asset debits the
 *    disposal gain/loss account the original credited — Sales does not move;
 *  - a DEBIT note against it credits that account;
 *  - control: a note against an ordinary sale still moves Sales.
 *
 * Real rows through the product's own paths. DB-backed (sl_test / CI).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { releaseIssuedInvoicesForTeardown } from "./helpers/issuedInvoiceFixtures";
import { auditContext } from "../lib/auditContext";
import { assetsService } from "../services/assets.service";
import { billsService } from "../services/bills.service";
import { invoicesService } from "../services/invoices.service";
import { purgeInputVatLedger } from "./helpers/purgeInputVatLedger";
import { releasePostedJournalsForTeardown } from "./helpers/journalFixtures";
import { deleterFor } from "./helpers/replica";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Phase 18 H-3 — DR-37: a note against an asset sale mirrors the disposal account, never Sales", () => {
  const SLUG = "p18-h3-dr37";
  const EMAIL = "p18-h3-dr37@test.local";
  let orgId = "", companyId = "", userId = 0, vendorId = 0, customerId = 0, catId = 0, saleId = 0, plainId = 0, seq = 0;

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated", actorUserId: userId });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    await purgeInputVatLedger(`SELECT id FROM organizations WHERE slug IN ('${SLUG}')`);
    await releasePostedJournalsForTeardown(`organization_id IN (SELECT id FROM organizations WHERE slug = '${SLUG}')`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      await releaseIssuedInvoicesForTeardown(`organization_id IN ${org}`);
      for (const t of ["asset_disposals", "asset_events", "asset_depreciation_schedule", "bill_items", "bills", "fixed_assets", "asset_categories", "invoice_items", "einvoice_documents", "invoices", "journal_entry_lines", "journal_entries", "period_locks", "audit_logs", "organization_memberships", "customers", "vendors", "bank_accounts", "categories", "companies"]) {
        await deleterFor(client, t).query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const gl = async (code: string) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  const note = async (kind: "credit_note" | "debit_note", originalInvoiceId: number, amount: number) => {
    const draft = await inTenant(() => invoicesService.create({
      invoiceNumber: `H3-${kind === "credit_note" ? "CN" : "DN"}-${++seq}`, date: "2026-06-10", customerId,
      documentType: kind, originalInvoiceId, noteReason: kind === "credit_note" ? "Price reduced after inspection" : "Price agreed higher",
      ...(kind === "debit_note" ? { chargeSubstance: "price_change", chargeEventDate: "2026-06-10" } : {}),
      items: [{ description: "Price adjustment", quantity: 1, unitPrice: amount, vatRate: 15 }],
    }, userId));
    return inTenant(() => invoicesService.approve(draft.id, userId));
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('H3 DR-37','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number) VALUES ($1,'H3 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','H3',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'Machine Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Buyer Co') RETURNING id`, [orgId])).rows[0].id;
    catId = (await inTenant(() => assetsService.createCategory({ name: "Machines", defaultUsefulLifeMonths: 60, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId))).id;
    // a lathe bought and capitalised, then SOLD by invoice (the disposal credits ASSET_DISPOSAL_GAIN_LOSS, not Sales)
    const draft = await inTenant(() => assetsService.create({ name: "Lathe", categoryId: catId, acquisitionDate: "2026-01-01", availableForUseDate: "2026-01-01", cost: 100_000, usefulLifeMonths: 50, vatInputTaxAmount: 15_000 }, userId));
    const bill = await inTenant(() => billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: "SUP-H3", billNumber: `B-H3-${Date.now()}`, date: "2026-01-01", vendorId, subtotal: 100_000, vatAmount: 15_000, total: 115_000, capitalisesAssetId: draft.id, items: [] }, userId));
    await inTenant(() => billsService.approve(bill.id, {}, userId));
    const sale = await inTenant(() => invoicesService.create({ invoiceNumber: "H3-SELL-LATHE", date: "2026-05-20", customerId, disposesAssetId: draft.id, items: [{ description: "Lathe, used", quantity: 1, unitPrice: 95_000, vatRate: 15 }] }, userId));
    saleId = (await inTenant(() => invoicesService.approve(sale.id, userId))).id;
    const plain = await inTenant(() => invoicesService.create({ invoiceNumber: "H3-SELL-SERVICES", date: "2026-05-21", customerId, items: [{ description: "Consulting", quantity: 1, unitPrice: 10_000, vatRate: 15 }] }, userId));
    plainId = (await inTenant(() => invoicesService.approve(plain.id, userId))).id;
  }, 180_000);

  afterAll(cleanup);

  it("🔴 a CREDIT note against the asset sale debits the disposal account the original credited — Sales does not move", async () => {
    const [sales, disposal, vat] = [await gl("SALES"), await gl("ASSET_DISPOSAL_GAIN_LOSS"), await gl("VAT_OUTPUT")];
    await note("credit_note", saleId, 5_000);
    expect(await gl("SALES") - sales, "Sales untouched (IAS 16.68)").toBe(0);
    expect(await gl("ASSET_DISPOSAL_GAIN_LOSS") - disposal, "the gain falls by the note").toBe(5_000);
    expect(await gl("VAT_OUTPUT") - vat, "output VAT reversed as before").toBe(750);
  });

  it("🔴 a DEBIT note against the asset sale credits the disposal account — Sales does not move", async () => {
    const [sales, disposal] = [await gl("SALES"), await gl("ASSET_DISPOSAL_GAIN_LOSS")];
    await note("debit_note", saleId, 2_000);
    expect(await gl("SALES") - sales).toBe(0);
    expect(await gl("ASSET_DISPOSAL_GAIN_LOSS") - disposal, "the gain rises by the note").toBe(-2_000);
  });

  it("control: a note against an ORDINARY sale still moves Sales, and not the disposal account", async () => {
    const [sales, disposal] = [await gl("SALES"), await gl("ASSET_DISPOSAL_GAIN_LOSS")];
    await note("credit_note", plainId, 1_000);
    expect(await gl("SALES") - sales).toBe(1_000);
    expect(await gl("ASSET_DISPOSAL_GAIN_LOSS") - disposal).toBe(0);
  });
});
