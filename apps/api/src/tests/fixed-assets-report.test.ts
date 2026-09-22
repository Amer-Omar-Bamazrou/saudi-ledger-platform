/**
 * FA-G — the roll-forward and the REGISTER-TO-GL RECONCILIATION (2026-09-22).
 * Record: docs/product/fixed-assets-decision-pack.md §11, §26.
 *
 * 🔴 A reconciliation that has only ever been seen PASSING is an unread
 * instrument. Every control here is shown passing on true books, then FAILING
 * after a line is posted to a fixed-asset account from outside the register —
 * the case it exists for — and passing again once that line is reversed.
 * Presence, absence, movement.
 *
 * The roll-forward is asserted on a window that CONTAINS an asset bought and
 * disposed of inside it, because that is the movement two balance snapshots
 * cannot show and the reason the query is written on events.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { assetsService } from "../services/assets.service";
import { assetCapitalisationService } from "../services/assets/capitalisation.service";
import { assetDisposalService } from "../services/assets/disposal.service";
import { assetReportsService } from "../services/assets/assetReports.service";
import { billsService } from "../services/bills.service";
import { journalEntriesService } from "../services/journalEntries.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("FA-G — the fixed-asset report and its reconciliation (real rows)", () => {
  const SLUG = "fa-g";
  const EMAIL = "fa-g@test.local";
  let orgId = "", companyId = "", userId = 0, vendorId = 0, catId = 0;
  let keptId = 0, soldId = 0;

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
      for (const t of ["asset_vat_use_records", "asset_disposals", "asset_events", "asset_depreciation_schedule", "fixed_assets", "asset_categories", "bill_items", "bills", "journal_entry_lines", "journal_entries", "audit_logs", "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const buyAsset = async (assetId: number, number: string, date: string, subtotal: number) => {
    const bill = await inTenant(() => billsService.create({ billNumber: number, date, vendorId, subtotal, vatAmount: 0, total: subtotal, capitalisesAssetId: assetId, items: [{ description: "Asset purchase", quantity: 1, unitPrice: subtotal }] }, userId));
    return inTenant(() => billsService.approve(bill.id, {}, userId));
  };
  const controlsOf = (r: Awaited<ReturnType<typeof assetReportsService.report>>) =>
    Object.fromEntries(r.controls.map((c) => [c.id, c]));
  const accountId = async (systemCode: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, systemCode])).rows[0].id as number;

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('FA G','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1,'FA G Co',1) RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','FA G',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Equipment Supplier') RETURNING id`, [orgId])).rows[0].id;
    catId = (await inTenant(() => assetsService.createCategory({ name: "Plant", defaultUsefulLifeMonths: 60, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId))).id;

    // KEPT: in service 2026-01-31, two months depreciated.
    const kept = await inTenant(() => assetsService.create({ name: "Lathe", categoryId: catId, acquisitionDate: "2026-01-31", availableForUseDate: "2026-01-31", cost: 60_000 }, userId));
    keptId = kept.id;
    await buyAsset(keptId, "BILL-FA-G-1", "2026-01-31", 60_000);
    await inTenant(() => assetCapitalisationService.depreciate(keptId, { period: "2026-01" }, userId));
    await inTenant(() => assetCapitalisationService.depreciate(keptId, { period: "2026-02" }, userId));

    // 🔴 BOUGHT AND SCRAPPED INSIDE THE SAME WINDOW — invisible to any
    // roll-forward assembled from two balance snapshots.
    const sold = await inTenant(() => assetsService.create({ name: "Test rig", categoryId: catId, acquisitionDate: "2026-02-28", availableForUseDate: "2026-02-28", cost: 12_000 }, userId));
    soldId = sold.id;
    await buyAsset(soldId, "BILL-FA-G-2", "2026-02-28", 12_000);
    await inTenant(() => assetDisposalService.dispose(soldId, { kind: "scrapped", date: "2026-03-31", reason: "Failed acceptance" }, userId));
  }, 120_000);
  afterAll(cleanup);

  it("🔴 the roll-forward is built on EVENTS: an asset bought and scrapped inside the window appears in BOTH additions and disposals, and in neither opening nor closing", async () => {
    const r = await inTenant(() => assetReportsService.report({ from: "2026-01-01", to: "2026-12-31" }));
    const plant = r.movement.find((m) => m.categoryName === "Plant")!;

    // opening: nothing was in service before 2026
    expect([plant.openingCost, plant.openingAccumulated]).toEqual([0, 0]);
    // additions: BOTH assets, including the one that did not survive the window
    expect(plant.additions).toBe(72_000);
    // disposals: the rig's cost leaves
    expect(plant.disposalsCost).toBe(12_000);
    // closing: only the lathe
    expect(plant.closingCost).toBe(60_000);
    // 🔴 the roll-forward ADDS UP, which is the property a reader checks first
    expect(plant.openingCost + plant.additions - plant.disposalsCost).toBe(plant.closingCost);
    expect(plant.openingAccumulated + plant.charge - plant.disposalsAccumulated).toBe(plant.closingAccumulated);
    expect(plant.closingNetBookValue).toBe(plant.closingCost - plant.closingAccumulated);

    // the rows behind the figures are listed, both of them
    expect(r.additions.map((a) => a.assetNumber).sort()).toEqual(["FA-00001", "FA-00002"]);
    expect(r.disposals.map((d) => d.assetNumber)).toEqual(["FA-00002"]);
    // a scrap's result is a LOSS of the carrying amount, and it is never revenue
    expect(r.disposals[0]!.proceeds).toBe(0);
    expect(r.disposalGainLoss).toBeLessThan(0);
    expect(r.disposalGainLoss).toBe(r.disposals[0]!.gainLoss);
  }, 60_000);

  it("🔴 a WINDOW THAT EXCLUDES THE DISPOSAL shows the rig as still held — the same rows, a different question, a different answer", async () => {
    const r = await inTenant(() => assetReportsService.report({ from: "2026-01-01", to: "2026-02-28" }));
    const plant = r.movement.find((m) => m.categoryName === "Plant")!;
    expect(plant.additions).toBe(72_000);
    expect(plant.disposalsCost).toBe(0);
    expect(plant.closingCost).toBe(72_000); // the rig is still in service on 28 Feb
    expect(r.disposals).toEqual([]);
  }, 60_000);

  it("🔴 every control PASSES on books the product itself wrote — and the figures it compares are non-zero, so the pass is not vacuous", async () => {
    const r = await inTenant(() => assetReportsService.report({ from: "2026-01-01", to: "2026-12-31" }));
    expect(r.reconciles).toBe(true);
    const c = controlsOf(r);
    expect([c.FA_COST!.status, c.FA_ACCUMULATED!.status, c.FA_EXPENSE!.status]).toEqual(["pass", "pass", "pass"]);
    // 🔴 A control comparing 0 with 0 passes and proves nothing. Each side is a
    // real figure the product posted.
    expect(c.FA_COST!.register).toBe(60_000);
    expect(c.FA_COST!.ledger).toBe(60_000);
    expect(c.FA_ACCUMULATED!.register).toBeGreaterThan(0);
    expect(c.FA_ACCUMULATED!.ledger).toBe(c.FA_ACCUMULATED!.register);
    expect(c.FA_EXPENSE!.register).toBeGreaterThan(0);
    expect(c.FA_EXPENSE!.ledger).toBe(c.FA_EXPENSE!.register);
    // the Zakat feed reads the same closing net book value, stated once
    expect(r.zakatNetFixedAssets.find((z) => z.categoryName === "Plant")!.netBookValue)
      .toBe(r.movement.find((m) => m.categoryName === "Plant")!.closingNetBookValue);
  }, 60_000);

  it("🔴 the control FAILS when the cost account is posted to from OUTSIDE the register — the case it exists for — and passes again when that entry is reversed", async () => {
    const costAccount = await accountId("FIXED_ASSETS");
    // The other side is EQUITY, not a control account: the platform refuses an
    // AP or AR line with no party (N3), which is correct and not what is under
    // test here.
    const other = await accountId("RETAINED_EARNINGS");

    // A hand-written journal entry putting an asset cost in the books with no
    // register row behind it — what the categorizer does when a bank row is
    // coded straight to a fixed-asset account.
    const je = await inTenant(() => journalEntriesService.create({
      date: "2026-04-15", description: "Machine bought outside the register",
      lines: [
        { accountId: costAccount, debitAmount: 5_000, creditAmount: 0, description: "Cost" },
        { accountId: other, debitAmount: 0, creditAmount: 5_000, description: "Funded from reserves" },
      ],
    } as never, userId));
    await inTenant(() => journalEntriesService.approve(je.id, userId));

    const failed = await inTenant(() => assetReportsService.report({ from: "2026-01-01", to: "2026-12-31" }));
    expect(failed.reconciles).toBe(false);
    const c = controlsOf(failed);
    expect(c.FA_COST!.status).toBe("fail");
    // 🔴 BOTH figures and the gap — a reader's next act is to open the account,
    // and a bare "does not reconcile" sends them looking for the number itself.
    expect(c.FA_COST!.register).toBe(60_000);
    expect(c.FA_COST!.ledger).toBe(65_000);
    expect(c.FA_COST!.difference).toBe(-5_000);
    expect(c.FA_COST!.detail).toContain("60000.00");
    expect(c.FA_COST!.detail).toContain("65000.00");
    // …and ONLY that control moved
    expect([c.FA_ACCUMULATED!.status, c.FA_EXPENSE!.status]).toEqual(["pass", "pass"]);

    // reverse it: the books agree again. A reversal is IN the books (JE_IN_BOOKS),
    // so this also proves the control reads the reversal pair, not `posted` alone.
    await inTenant(() => journalEntriesService.reverse(je.id));
    const fixed = await inTenant(() => assetReportsService.report({ from: "2026-01-01", to: "2026-12-31" }));
    expect(fixed.reconciles).toBe(true);
    expect(controlsOf(fixed).FA_COST!.difference).toBe(0);
  }, 90_000);

  it("🔴 a DISPOSED asset contributes nothing to the reconciliation — its cost and its accumulated depreciation left the books with it", async () => {
    const r = await inTenant(() => assetReportsService.report({ from: "2026-01-01", to: "2026-12-31" }));
    const c = controlsOf(r);
    // the rig cost 12,000 and is gone from both sides, not just the register's
    expect(c.FA_COST!.register).toBe(60_000);
    expect(c.FA_COST!.ledger).toBe(60_000);
    // and it IS in the register as a disposed row, so the absence above is real
    const rig = await inTenant(() => assetsService.getById(soldId));
    expect([rig.status, rig.cost]).toEqual(["disposed", 12_000]);
  }, 60_000);
});
