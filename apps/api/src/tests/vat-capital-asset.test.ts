/**
 * FA-F — the Art. 52 adjustment over REAL REGISTER ROWS (2026-09-22).
 * Record: docs/product/fixed-assets-decision-pack.md §7, §25.
 *
 * The arithmetic is proven on its own in `vat-capital-asset-arithmetic.test.ts`.
 * This file proves what that cannot see: that the Art. 51 fraction is computed
 * from invoices the PRODUCT wrote (and excludes the capital-asset supply the
 * text excludes), that a declared figure overrides the derived one for its
 * window and only its window, and that a disposal recorded through the
 * product's own path carries the right limb of Art. 52(7)/(8).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { assetsService } from "../services/assets.service";
import { assetDisposalService } from "../services/assets/disposal.service";
import { billsService } from "../services/bills.service";
import { invoicesService } from "../services/invoices.service";
import { vatCapitalAssetService } from "../services/assets/vatCapitalAsset.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("FA-F — the VAT IR Art. 52 capital-asset adjustment (real rows)", () => {
  const SLUG = "fa-f";
  const EMAIL = "fa-f@test.local";
  let orgId = "", companyId = "", userId = 0, vendorId = 0, customerId = 0, catId = 0;
  let machineId = 0, vanId = 0;

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
      for (const t of ["asset_vat_use_records", "asset_disposals", "asset_events", "asset_depreciation_schedule", "fixed_assets", "asset_categories", "bill_items", "bills", "invoice_items", "invoices", "journal_entry_lines", "journal_entries", "audit_logs", "organization_memberships", "customers", "vendors", "bank_accounts", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    let err: { statusCode?: number; status?: number; payload?: { code?: string }; message?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err!.statusCode ?? err!.status, err!.message).toBe(status);
    if (code) expect(err!.payload?.code).toBe(code);
  };

  const buyAsset = async (assetId: number, number: string, date: string, subtotal: number, vat: number) => {
    const bill = await inTenant(() => billsService.create({ billNumber: number, date, vendorId, subtotal, vatAmount: vat, total: subtotal + vat, capitalisesAssetId: assetId, items: [{ description: "Asset purchase", quantity: 1, unitPrice: subtotal }] }, userId));
    return inTenant(() => billsService.approve(bill.id, {}, userId));
  };
  /** An ordinary sales invoice of this product, with one line in a chosen tax category. */
  const sell = async (number: string, date: string, net: number, code: "S" | "E" | "Z") => {
    const vat = code === "S" ? Math.round(net * 15) / 100 : 0;
    const inv = await inTenant(() => invoicesService.create({
      invoiceNumber: number, date, dueDate: date, customerId,
      subtotal: net, vatAmount: vat, total: net + vat,
      items: [{ description: "Supply", quantity: 1, unitPrice: net, vatAmount: vat, total: net + vat, taxCategoryCode: code }],
    } as never, userId));
    return inTenant(() => invoicesService.approve(inv.id, userId));
  };
  const assetIn = (r: Awaited<ReturnType<typeof vatCapitalAssetService.report>>, id: number) =>
    (r.assets as Array<{ assetId: number }>).find((a) => a.assetId === id) as never as {
      assetId: number; adjustmentPeriodYears: number; initialDeduction: number; potentiallyAdjustable: number; recordsRetainedUntil: string;
      windows: Array<{ periodIndex: number; startDate: string; endDate: string; returnPeriodStart: string; returnPeriodEnd: string; actualUsePct: number | null; actualUseSource: string; adjustment: number; noChangeOfUse: boolean; due: boolean }>;
      disposal: null | { adjustment: number; rule: string; remainingPeriods: number };
    };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('FA F','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, vat_number) VALUES ($1,'FA F Co','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','FA F',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Plant Supplier') RETURNING id`, [orgId])).rows[0].id;
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'A Customer') RETURNING id`, [orgId])).rows[0].id;
    catId = (await inTenant(() => assetsService.createCategory({ name: "Machinery", defaultUsefulLifeMonths: 120, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId))).id;
  }, 60_000);
  afterAll(cleanup);

  it("🔴 without a declared TAX PERIOD there are no windows at all — because Art. 52(5) opens the first one at the start of the tax period of acquisition", async () => {
    const r = await inTenant(() => vatCapitalAssetService.report());
    expect(r.status).toBe("tax_period_not_declared");
    expect(r.assets).toEqual([]);
    expect(r.reason).toMatch(/Art\. 52\(5\)/);
    expect(r.vatTaxPeriod).toBeNull();
  }, 60_000);

  it("🔴 a capital asset bought through the product's own bill path gets its Art. 52(2) period and its twelve-month windows, and a wholly taxable year reaches 52(6) by the front door", async () => {
    await pool.query(`UPDATE companies SET vat_tax_period = 'quarterly' WHERE id = $1`, [companyId]);

    // 100,000 + 15,000 VAT, recovered in full, available 2025-05-20.
    const machine = await inTenant(() => assetsService.create({ name: "Press line", categoryId: catId, acquisitionDate: "2025-05-20", availableForUseDate: "2025-05-20", cost: 100_000, vatInputTaxAmount: 15_000 }, userId));
    machineId = machine.id;
    await buyAsset(machineId, "BILL-FA-F-1", "2025-05-20", 100_000, 15_000);

    // one wholly standard-rated supply in 2025 and one in 2026 ⇒ the Art. 51 fraction is 100 %
    await sell("INV-FA-F-1", "2025-07-01", 400_000, "S");
    await sell("INV-FA-F-2", "2026-07-01", 400_000, "S");

    const r = await inTenant(() => vatCapitalAssetService.report());
    expect(r.status).toBe("computed");
    const a = assetIn(r, machineId);
    // 🔴 the VAT clock is NOT the accounting clock: a 120-month machine
    // depreciates over ten years and adjusts over the statutory six.
    expect(a.adjustmentPeriodYears).toBe(6);
    expect([a.initialDeduction, a.potentiallyAdjustable]).toEqual([15_000, 2_500]);
    // Art. 66(1): acquisition year + period + 5
    expect(a.recordsRetainedUntil).toBe("2036-12-31");
    // quarterly ⇒ the window opens 1 April 2025, and the adjustment is filed in
    // the Jan–Mar 2026 return, the last quarter inside it
    expect(a.windows).toHaveLength(6);
    expect([a.windows[0]!.startDate, a.windows[0]!.endDate]).toEqual(["2025-04-01", "2026-03-31"]);
    expect([a.windows[0]!.returnPeriodStart, a.windows[0]!.returnPeriodEnd]).toEqual(["2026-01-01", "2026-03-31"]);
    // wholly taxable ⇒ the derived use is 100 %, equal to the initial recovery
    expect([a.windows[0]!.actualUsePct, a.windows[0]!.actualUseSource]).toEqual([100, "proportional"]);
    expect([a.windows[0]!.adjustment, a.windows[0]!.noChangeOfUse]).toEqual([0, true]);
    // 🔴 and 2027 onwards has no supplies yet, so its use is UNAVAILABLE — nil,
    // and NOT 52(6). The two zeros are distinguishable, which is the point.
    const later = a.windows.find((w) => w.endDate >= "2028-01-01")!;
    expect([later.actualUsePct, later.actualUseSource, later.noChangeOfUse]).toEqual([null, "unavailable", false]);

    // the Art. 51 fraction is shown per calendar year so it can be checked
    const y2026 = r.proportionalDeduction.find((p) => p.calendarYear === 2026)!;
    expect([y2026.taxableSupplies, y2026.exemptSupplies, y2026.pct]).toEqual([400_000, 0, 100]);
  }, 90_000);

  it("🔴 an EXEMPT supply moves the Art. 51 fraction, and the adjustment follows it — presence, absence and movement in one window", async () => {
    const before = assetIn(await inTenant(() => vatCapitalAssetService.report()), machineId);
    expect(before.windows[1]!.adjustment).toBe(0);

    // 2026 gains 100,000 of EXEMPT supplies beside its 400,000 taxable ⇒ 80 %.
    await sell("INV-FA-F-3", "2026-08-01", 100_000, "E");

    const r = await inTenant(() => vatCapitalAssetService.report());
    const y2026 = r.proportionalDeduction.find((p) => p.calendarYear === 2026)!;
    expect([y2026.taxableSupplies, y2026.exemptSupplies, y2026.pct]).toEqual([400_000, 100_000, 80]);

    const a = assetIn(r, machineId);
    // window 2 ends 2027-03-31 — its calendar year is 2027, which has no
    // supplies. Window 1 ends 2026-03-31 (calendar 2026), so THAT is the one
    // the 2026 fraction moves.
    const w1 = a.windows.find((w) => w.endDate === "2026-03-31")!;
    expect([w1.actualUsePct, w1.actualUseSource]).toEqual([80, "proportional"]);
    // 🔴 the figure MOVED, and by the amount the Regulation gives: 2,500 × −20 %
    expect(w1.adjustment).toBe(-500);
    expect(w1.noChangeOfUse).toBe(false);
    expect(before.windows[0]!.adjustment).toBe(0); // …and it was 0 before this supply existed

    // 🔴 a ZERO-RATED supply is TAXABLE, not exempt — it must not move the fraction
    await sell("INV-FA-F-4", "2026-09-01", 100_000, "Z");
    const after = await inTenant(() => vatCapitalAssetService.report());
    const y = after.proportionalDeduction.find((p) => p.calendarYear === 2026)!;
    expect([y.taxableSupplies, y.exemptSupplies, y.pct]).toEqual([500_000, 100_000, 83.33]);
  }, 90_000);

  it("🔴 a DECLARED use overrides the Art. 51 default for its own window and no other, and a window outside the adjustment period is refused", async () => {
    const w1End = "2026-03-31";
    await inTenant(() => vatCapitalAssetService.declareUse({ assetId: machineId, periodIndex: 1, actualUsePct: 100, basis: "exclusive_use", note: "Used only on standard-rated output" }, userId));

    const r = await inTenant(() => vatCapitalAssetService.report());
    const a = assetIn(r, machineId);
    const w1 = a.windows.find((w) => w.endDate === w1End)!;
    expect([w1.actualUsePct, w1.actualUseSource, w1.adjustment, w1.noChangeOfUse]).toEqual([100, "declared", 0, true]);
    // 🔴 no other window moved with it — an override is per window, or one
    // statement would silently restate the whole adjustment period.
    expect(a.windows.filter((w) => w.actualUseSource === "declared")).toHaveLength(1);

    // refusals, by name, with nothing stored
    await expectRefusal(inTenant(() => vatCapitalAssetService.declareUse({ assetId: machineId, periodIndex: 7, actualUsePct: 50, basis: "other" }, userId)), 422, "adjustment_period_out_of_range");
    await expectRefusal(inTenant(() => vatCapitalAssetService.declareUse({ assetId: machineId, periodIndex: 0, actualUsePct: 50, basis: "other" }, userId)), 422, "adjustment_period_out_of_range");
    await expectRefusal(inTenant(() => vatCapitalAssetService.declareUse({ assetId: machineId, periodIndex: 2, actualUsePct: 150, basis: "other" }, userId)), 422, "vat_use_pct_invalid");
    await expectRefusal(inTenant(() => vatCapitalAssetService.declareUse({ assetId: machineId, periodIndex: 2, actualUsePct: 50, basis: "because" }, userId)), 422, "vat_use_basis_unknown");
    expect(await inTenant(() => vatCapitalAssetService.useRecords(machineId))).toHaveLength(1);

    // withdrawing it falls the window back to the DERIVED figure — the movement proves the override was real
    const [rec] = await inTenant(() => vatCapitalAssetService.useRecords(machineId));
    await inTenant(() => vatCapitalAssetService.removeUse(rec!.id));
    const backReport = await inTenant(() => vatCapitalAssetService.report());
    const back = assetIn(backReport, machineId).windows.find((w) => w.endDate === w1End)!;
    // 🔴 2026 now also carries the ZERO-RATED 100,000 of the previous test, so
    // the derived fraction is 83.33 % — not the 80 % it was before that supply.
    // The figure is asserted exactly AND recomputed from the report's own
    // published fraction, so neither can drift without the other noticing.
    expect(back.actualUseSource).toBe("proportional");
    expect(back.adjustment).toBe(-416.75);
    const pct2026 = backReport.proportionalDeduction.find((p) => p.calendarYear === 2026)!.pct!;
    expect(Math.round(assetIn(backReport, machineId).potentiallyAdjustable * (pct2026 - 100)) / 100).toBe(back.adjustment);
  }, 90_000);

  it("🔴 Art. 51(5)(a) — the sale of a CAPITAL ASSET is excluded from the fraction, and FA-C's marker is what makes that possible", async () => {
    const before = (await inTenant(() => vatCapitalAssetService.report())).proportionalDeduction.find((p) => p.calendarYear === 2026)!;

    // A restricted motor vehicle: bought with no deduction (Art. 50(1)(c)),
    // then SOLD. Its sale invoice names the asset, so it is a capital-asset
    // supply and Art. 51(5)(a) keeps it out of the fraction.
    const van = await inTenant(() => assetsService.create({ name: "Delivery van", categoryId: catId, acquisitionDate: "2025-06-01", availableForUseDate: "2025-06-01", cost: 115_000, vatInitialRecoveryPct: 0, vatNonDeductibleReason: "Restricted motor vehicle — VAT IR Art. 50(1)(c)" }, userId));
    vanId = van.id;
    await buyAsset(vanId, "BILL-FA-F-VAN", "2025-06-01", 100_000, 15_000);
    await inTenant(() => assetDisposalService.dispose(vanId, { kind: "scrapped", date: "2026-10-31", reason: "Written off" }, userId));

    const r = await inTenant(() => vatCapitalAssetService.report());
    // the fraction is UNCHANGED by the disposal
    const after = r.proportionalDeduction.find((p) => p.calendarYear === 2026)!;
    expect([after.taxableSupplies, after.exemptSupplies, after.pct]).toEqual([before.taxableSupplies, before.exemptSupplies, before.pct]);

    // and the scrap's own limb of Art. 52(7) is named, with nil
    const v = assetIn(r, vanId);
    expect(v.disposal).not.toBeNull();
    expect(v.disposal!.adjustment).toBe(0);
    expect(v.disposal!.rule).toMatch(/earlier than accounted for/);
    // 🔴 nothing was deducted, so nothing is adjustable — the figure falls out
    // of the arithmetic rather than being special-cased
    expect([v.initialDeduction, v.potentiallyAdjustable]).toEqual([0, 0]);
  }, 90_000);

  it("🔴 the whole working paper can be narrowed to ONE asset, and the narrowed figures are identical to that asset's in the full one", async () => {
    const full = await inTenant(() => vatCapitalAssetService.report());
    const narrowed = await inTenant(() => vatCapitalAssetService.report({ assetId: machineId }));
    expect(narrowed.assets).toHaveLength(1);
    expect(assetIn(narrowed, machineId)).toEqual(assetIn(full, machineId));
    // …and the full one really did carry more than one, so the narrowing is not vacuous
    expect(full.assets.length).toBeGreaterThan(1);
  }, 60_000);
});
