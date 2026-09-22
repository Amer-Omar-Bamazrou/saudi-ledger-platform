/**
 * FIXED ASSETS — FA-C: DISPOSAL (2026-09-22), on real rows.
 * Record: docs/product/fixed-assets-decision-pack.md §9, §22; the expected
 * results are the pack's own §17 test matrix, rows 10 and 11.
 *
 *   · row 10 — a SALE through the invoice path: the invoice's entry carries
 *     `Dr AR gross / Cr VAT_OUTPUT / Cr DISPOSAL GAIN-LOSS (net proceeds)`
 *     AND the derecognition `Dr accumulated · Dr gain/loss (carrying) / Cr
 *     cost`, all one entry; the net gain lands in OTHER INCOME and 🔴 SALES
 *     DOES NOT MOVE; the VAT return's box 1 and box 6 do move (it is a
 *     taxable supply, Art. 3(5));
 *   · row 11 — a SCRAP: the derecognition alone, the loss = the carrying
 *     amount, no proceeds, no VAT;
 *   · a WITHDRAWAL computes and STORES the Art. 52(8) nominal-supply value;
 *   · a RESTRICTED MOTOR VEHICLE (Art. 50(3)) may not be sold with VAT — the
 *     refusal is named and nothing posts;
 *   · depreciation runs up to the disposal month FIRST (IAS 16.55) and the
 *     unposted tail is gone afterwards;
 *   · a disposal is TERMINAL: the asset is frozen, a second disposal is
 *     refused, and the row cannot be edited.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { assetsService } from "../services/assets.service";
import { assetCapitalisationService } from "../services/assets/capitalisation.service";
import { assetDisposalService, nominalSupplyValue } from "../services/assets/disposal.service";
import { billsService } from "../services/bills.service";
import { invoicesService } from "../services/invoices.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describe("VAT IR Art. 52(8) — the nominal-supply value of a withdrawal", () => {
  const asset = { cost: 120_000, vatInitialRecoveryPct: 100, vatCapitalAssetClass: "movable", usefulLifeMonths: 120, acquisitionDate: "2026-01-15" };
  it("🔴 purchase value × recovery % × remaining ÷ adjustment period, in WHOLE years (52(2): part years count as one); zero past the period", () => {
    // movable, 10-year accounting life ⇒ the adjustment period is 6 years (52(2) takes the shorter of 6 and the life)
    expect(nominalSupplyValue(asset, "2026-06-30")).toBe(100_000); // 1 part-year elapsed of 6 → 5/6 remaining
    expect(nominalSupplyValue(asset, "2027-06-30")).toBe(80_000); // 2 part-years elapsed of 6 → 4/6
    expect(nominalSupplyValue(asset, "2031-06-30")).toBe(0); // 6 part-years elapsed
    expect(nominalSupplyValue({ ...asset, vatInitialRecoveryPct: 0 }, "2027-06-30")).toBe(0);
    expect(nominalSupplyValue({ ...asset, vatCapitalAssetClass: "not_capital" }, "2027-06-30")).toBe(0);
    // immovable: 10 years, and a 10-year life does not shorten it
    expect(nominalSupplyValue({ ...asset, vatCapitalAssetClass: "immovable" }, "2027-06-30")).toBe(96_000); // 8/10
  });
});

describeMaybe("FA-C — disposal (real rows)", () => {
  const SLUG = "fa-c";
  const EMAIL = "fa-c@test.local";
  let orgId = "", companyId = "", userId = 0, vendorId = 0, customerId = 0, catId = 0;

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of ["asset_disposals", "asset_events", "asset_depreciation_schedule", "fixed_assets", "asset_categories", "bill_items", "bills", "invoice_items", "einvoice_documents", "invoices", "journal_entry_lines", "journal_entries", "period_locks", "audit_logs", "organization_memberships", "customers", "vendors", "bank_accounts", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    let err: { statusCode?: number; status?: number; payload?: { code?: string }; body?: { code?: string }; code?: string; message?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err!.statusCode ?? err!.status, err!.message).toBe(status);
    if (code) expect(err!.payload?.code ?? err!.body?.code ?? err!.code).toBe(code);
  };
  const gl = async (code: string) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  const entryLines = async (entryId: number) =>
    (await pool.query(
      `SELECT coalesce(c.system_code, c.name) AS acct, l.debit_amount::text d, l.credit_amount::text c FROM journal_entry_lines l
         JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.id`, [entryId])).rows.map((r) => [r.acct, r.d, r.c]);
  /** A draft asset bought and capitalised through the product's own paths. */
  const buyAsset = async (name: string, cost: number, life: number, opts: { vatRecovery?: number; reason?: string; available: string } ) => {
    const vat = opts.vatRecovery === 0 ? 0 : Math.round(cost * 0.15 * 100) / 100;
    const draft = await inTenant(() => assetsService.create({
      name, categoryId: catId, acquisitionDate: opts.available, availableForUseDate: opts.available,
      cost, usefulLifeMonths: life, vatInputTaxAmount: vat,
      ...(opts.vatRecovery === 0 ? { vatInitialRecoveryPct: 0, vatNonDeductibleReason: opts.reason ?? "Restricted motor vehicle — Art. 50(1)(c)" } : {}),
    }, userId));
    const net = opts.vatRecovery === 0 ? Math.round((cost / 1.15) * 100) / 100 : cost;
    const billVat = opts.vatRecovery === 0 ? Math.round((cost - net) * 100) / 100 : Math.round(cost * 0.15 * 100) / 100;
    const bill = await inTenant(() => billsService.create({ billNumber: `B-${name}-${Date.now()}`, date: opts.available, vendorId, subtotal: net, vatAmount: billVat, total: Math.round((net + billVat) * 100) / 100, capitalisesAssetId: draft.id, items: [] }, userId));
    await inTenant(() => billsService.approve(bill.id, {}, userId));
    return inTenant(() => assetsService.getById(draft.id));
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('FA C','${SLUG}') RETURNING id`)).rows[0].id;
    // an issuing company: a tax invoice needs the seller's VAT registration
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number) VALUES ($1,'FA C Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','FA C',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Machine Supplier') RETURNING id`, [orgId])).rows[0].id;
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Buyer Co') RETURNING id`, [orgId])).rows[0].id;
    catId = (await inTenant(() => assetsService.createCategory({ name: "Machines", defaultUsefulLifeMonths: 60, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId))).id;
  }, 120_000);
  afterAll(cleanup);

  it("🔴 row 10 — a SALE: one entry carries the invoice AND the derecognition; the gain is OTHER INCOME and SALES DOES NOT MOVE; the VAT return files it as a taxable supply", async () => {
    // 100,000 over 50 months from 2026-01; depreciate 2026-01..2026-04 (4 × 2,000 = 8,000)
    const a = await buyAsset("Lathe", 100_000, 50, { available: "2026-01-01" });
    for (const p of ["2026-01", "2026-02", "2026-03", "2026-04"]) await inTenant(() => assetCapitalisationService.depreciate(a.id, { period: p }, userId));
    const mid = await inTenant(() => assetsService.getById(a.id));
    expect([mid.accumulatedDepreciation, mid.carryingAmount]).toEqual([8_000, 92_000]);

    const salesBefore = await gl("SALES");
    const disposalBefore = await gl("ASSET_DISPOSAL_GAIN_LOSS");
    const vatBefore = await gl("VAT_OUTPUT");
    // sold for 95,000 + VAT in MAY: the act depreciates May first (IAS 16.55), then derecognises
    const inv = await inTenant(() => invoicesService.create({
      invoiceNumber: "SELL-LATHE-1", date: "2026-05-20", customerId, disposesAssetId: a.id,
      items: [{ description: "Lathe, used", quantity: 1, unitPrice: 95_000, vatRate: 15 }],
    }, userId));
    const issued = await inTenant(() => invoicesService.approve(inv.id, userId));
    expect(issued.status).toBe("sent");

    const after = await inTenant(() => assetsService.getById(a.id));
    expect([after.status, after.disposalDate, after.plannedPeriods]).toEqual(["disposed", "2026-05-20", 0]);
    expect(after.accumulatedDepreciation).toBe(10_000); // May ran first: 5 × 2,000
    expect(after.carryingAmount).toBe(0); // derecognised
    expect(after.disposal).toMatchObject({ kind: "sold", proceeds: 95_000, accumulatedAtDisposal: 10_000, carryingAmountAtDisposal: 90_000, gainLoss: 5_000, vatTreatment: "taxable_supply", nominalSupplyValue: null });
    // ONE entry: the invoice and the derecognition together
    const je = (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number = 'GL-SELL-LATHE-1'`, [orgId])).rows[0];
    expect(await entryLines(je.id)).toEqual([
      ["AR", "109250.00", "0.00"],
      ["ASSET_DISPOSAL_GAIN_LOSS", "0.00", "95000.00"],
      ["VAT_OUTPUT", "0.00", "14250.00"],
      ["ACCUMULATED_DEPRECIATION", "10000.00", "0.00"],
      ["ASSET_DISPOSAL_GAIN_LOSS", "90000.00", "0.00"],
      ["FIXED_ASSETS", "0.00", "100000.00"],
    ]);
    // 🔴 SALES does not move — a disposal is not revenue (IAS 16.68). The gain is 5,000 of other income.
    expect(await gl("SALES")).toBe(salesBefore);
    expect(await gl("ASSET_DISPOSAL_GAIN_LOSS")).toBe(disposalBefore + 90_000 - 95_000); // debit − credit = −5,000 ⇒ a 5,000 credit balance: the gain
    expect(await gl("VAT_OUTPUT")).toBe(vatBefore - 14_250);
    // it IS a taxable supply: the VAT return files the proceeds in box 1 and its VAT in box 6
    const vatReturn = await inTenant(() => reportsService.vatReturn("2026-04-01", "2026-06-30"));
    expect(vatReturn.salesSection.box1_standardRatedDomesticSales).toBe(95_000);
    expect(vatReturn.salesSection.box6_vatOnStandardRatedSales).toBe(14_250);
    // terminal: a second sale and a scrap are both refused, and the row cannot be edited
    await expectRefusal(inTenant(() => assetDisposalService.dispose(a.id, { date: "2026-06-01", kind: "scrapped", reason: "x" }, userId)), 409, "asset_not_in_service");
    await expect(pool.query(`UPDATE asset_disposals SET proceeds = 1 WHERE asset_id = $1`, [a.id])).rejects.toThrow(/is a terminal record/);
    await expect(pool.query(`UPDATE fixed_assets SET name = 'x' WHERE id = $1`, [a.id])).rejects.toThrow(/is disposed and frozen/);
  }, 180_000);

  it("🔴 row 11 — a SCRAP: the derecognition alone, the loss is the carrying amount, no proceeds and no VAT; depreciation runs to the disposal month first and the tail is gone", async () => {
    const a = await buyAsset("Press", 60_000, 60, { available: "2026-02-01" });
    const disposalBefore = await gl("ASSET_DISPOSAL_GAIN_LOSS");
    const vatBefore = await gl("VAT_OUTPUT");
    const out = await inTenant(() => assetDisposalService.dispose(a.id, { date: "2026-04-10", kind: "scrapped", reason: "Damaged beyond repair; scrap certificate 2026-113" }, userId));
    // Feb, Mar and Apr ran first — IAS 16.55
    expect(out.depreciatedFirst.map((d) => d.period)).toEqual(["2026-02", "2026-03", "2026-04"]);
    expect(out.depreciatedFirst.every((d) => d.amount === 1_000)).toBe(true);
    expect(out.disposal).toMatchObject({ kind: "scrapped", proceeds: 0, accumulatedAtDisposal: 3_000, carryingAmountAtDisposal: 57_000, gainLoss: -57_000, vatTreatment: "no_adjustment", nominalSupplyValue: null });
    expect(await entryLines(out.disposal.journalEntryId)).toEqual([
      ["ACCUMULATED_DEPRECIATION", "3000.00", "0.00"],
      ["ASSET_DISPOSAL_GAIN_LOSS", "57000.00", "0.00"],
      ["FIXED_ASSETS", "0.00", "60000.00"],
    ]);
    expect(await gl("ASSET_DISPOSAL_GAIN_LOSS")).toBe(disposalBefore + 57_000); // a 57,000 LOSS
    expect(await gl("VAT_OUTPUT")).toBe(vatBefore); // Art. 52(7): destroyed/scrapped attracts no adjustment
    expect([out.asset.status, out.asset.plannedPeriods, out.asset.carryingAmount]).toEqual(["disposed", 0, 0]);
    expect(out.asset.events.map((e) => e.kind)).toEqual(["created", "capitalised", "depreciated", "depreciated", "depreciated", "disposed"]);
  }, 180_000);

  it("🔴 a WITHDRAWAL stores the Art. 52(8) nominal-supply value; a sale is refused as an act (it is an invoice); a date before service and a bad kind are refused", async () => {
    const a = await buyAsset("Generator", 24_000, 24, { available: "2026-03-01" });
    await expectRefusal(inTenant(() => assetDisposalService.dispose(a.id, { date: "2026-03-10", kind: "sold", reason: "x" }, userId)), 422, "sale_is_an_invoice");
    await expectRefusal(inTenant(() => assetDisposalService.dispose(a.id, { date: "2026-02-01", kind: "scrapped", reason: "x" }, userId)), 422, "disposal_before_in_service");
    await expectRefusal(inTenant(() => assetDisposalService.dispose(a.id, { date: "2026-03-10", kind: "given_away", reason: "x" }, userId)), 400);
    await expectRefusal(inTenant(() => assetDisposalService.dispose(a.id, { date: "2026-03-10", kind: "withdrawn", reason: "" }, userId)), 400);
    const out = await inTenant(() => assetDisposalService.dispose(a.id, { date: "2026-05-15", kind: "withdrawn", reason: "Taken into the owner's private use" }, userId));
    // 24,000 cost, recovery 100 %, movable with a 2-year life ⇒ the adjustment period is 2 years; 1 part-year elapsed ⇒ 1/2 remaining
    expect(out.disposal).toMatchObject({ kind: "withdrawn", vatTreatment: "nominal_supply", nominalSupplyValue: 12_000 });
    const stored = await inTenant(() => assetsService.getById(a.id));
    expect(stored.disposal).toMatchObject({ vatTreatment: "nominal_supply", nominalSupplyValue: 12_000, gainLoss: -21_000 });
  }, 180_000);

  it("🔴 a RESTRICTED MOTOR VEHICLE (Art. 50(3)) cannot be sold with VAT: the refusal is named and NOTHING posts; sold at zero VAT it is out of scope and SALES still does not move", async () => {
    const van = await buyAsset("Van", 115_000, 60, { available: "2026-01-01", vatRecovery: 0 });
    expect([van.vatInitialRecoveryPct, van.cost]).toEqual([0, 115_000]);
    const jeBefore = (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n;
    const bad = await inTenant(() => invoicesService.create({ invoiceNumber: "SELL-VAN-BAD", date: "2026-03-05", customerId, disposesAssetId: van.id, items: [{ description: "Van", quantity: 1, unitPrice: 50_000, vatRate: 15 }] }, userId));
    await expectRefusal(inTenant(() => invoicesService.approve(bad.id, userId)), 422, "restricted_vehicle_sale_out_of_scope");
    expect((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(jeBefore);
    expect((await inTenant(() => assetsService.getById(van.id))).status).toBe("in_service");
    const salesBefore = await gl("SALES");
    const vatBefore = await gl("VAT_OUTPUT");
    const ok = await inTenant(() => invoicesService.create({ invoiceNumber: "SELL-VAN-OK", date: "2026-03-05", customerId, disposesAssetId: van.id, items: [{ description: "Van, used", quantity: 1, unitPrice: 50_000, vatRate: 0 }] }, userId));
    await inTenant(() => invoicesService.approve(ok.id, userId));
    const after = await inTenant(() => assetsService.getById(van.id));
    expect(after.disposal).toMatchObject({ kind: "sold", proceeds: 50_000, vatTreatment: "out_of_scope_restricted_vehicle" });
    expect(await gl("VAT_OUTPUT")).toBe(vatBefore);
    expect(await gl("SALES")).toBe(salesBefore);
  }, 180_000);
});
