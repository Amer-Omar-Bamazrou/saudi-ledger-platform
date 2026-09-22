/**
 * FA-E — the Art. 17 pool over REAL REGISTER ROWS (2026-09-22).
 *
 * Record: docs/product/fixed-assets-decision-pack.md §24.
 *
 * The arithmetic is proven on its own in `income-tax-pool-arithmetic.test.ts`.
 * What this file proves is everything that arithmetic cannot see: that the
 * figures come from rows the PRODUCT wrote (an asset bought through its own
 * bill path, disposed through its own disposal path), that the four states
 * which refuse to compute actually refuse, and that a figure only appears once
 * the fact behind it exists — presence, absence, and MOVEMENT.
 *
 * 🔴 The load-bearing one is the addition DATE. Art. 17(e) says "assets IN USE
 * added to the group", so an asset bought in one tax year and put into service
 * in the next belongs to the LATER year's pool. A register that used the
 * purchase date would pass every other assertion here, so the fixture is built
 * to straddle a year end and the test names both dates.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { assetsService } from "../services/assets.service";
import { assetDisposalService } from "../services/assets/disposal.service";
import { billsService } from "../services/bills.service";
import { incomeTaxPoolService } from "../services/assets/incomeTaxPool.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("FA-E — the Income Tax Law Art. 17 pool (real rows)", () => {
  const SLUG = "fa-e";
  const EMAIL = "fa-e@test.local";
  let orgId = "", companyId = "", userId = 0, vendorId = 0, machineryCat = 0, furnitureCat = 0;
  let pressId = 0, deskId = 0;

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
      for (const t of ["asset_tax_pool_declarations", "asset_disposals", "asset_events", "asset_depreciation_schedule", "fixed_assets", "asset_categories", "bill_items", "bills", "journal_entry_lines", "journal_entries", "period_locks", "audit_logs", "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
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
  const setCompany = (sql: string, params: unknown[]) => pool.query(`UPDATE companies SET ${sql} WHERE id = $1`, [companyId, ...params]);
  /** The pool report, narrowed to one group across the years — what a working paper actually reads. */
  const chain = (report: Awaited<ReturnType<typeof incomeTaxPoolService.report>>, group: number) =>
    report.years.map((y) => {
      const g = y.groups.find((x) => x.group === group)!;
      return { year: y.taxYear, opening: g.openingBalance, addHalf: g.additionsHalf, dispHalf: g.disposalsHalf, deduction: g.depreciationDeduction, closing: g.closingBalance };
    });

  const buyAsset = async (assetId: number, number: string, date: string, subtotal: number) => {
    const bill = await inTenant(() => billsService.create({ billNumber: number, date, vendorId, subtotal, vatAmount: 0, total: subtotal, capitalisesAssetId: assetId, items: [{ description: "Asset purchase", quantity: 1, unitPrice: subtotal }] }, userId));
    return inTenant(() => billsService.approve(bill.id, {}, userId));
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('FA E','${SLUG}') RETURNING id`)).rows[0].id;
    // 🔴 The company starts with NEITHER fact declared: the report's first job is
    // to refuse, and a fixture that pre-declares them can never see it.
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'FA E Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','FA E',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Plant Supplier') RETURNING id`, [orgId])).rows[0].id;
    machineryCat = (await inTenant(() => assetsService.createCategory({ name: "Machinery", defaultUsefulLifeMonths: 60, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId))).id;
    furnitureCat = (await inTenant(() => assetsService.createCategory({ name: "Furniture", defaultUsefulLifeMonths: 120, incomeTaxGroup: 5, vatCapitalAssetClass: "movable" }, userId))).id;
  }, 60_000);
  afterAll(cleanup);

  it("🔴 four refusals before any figure: the regime, the Zakat-only case, the fiscal year and the ANCHOR — each naming the act that resolves it", async () => {
    // 1. the ownership share is NOT DECLARED. Art. 17 applies to persons subject
    //    to the Income Tax Law (Art. 2) — assuming either way invents a fact.
    let r = await inTenant(() => incomeTaxPoolService.report());
    expect(r.status).toBe("regime_not_declared");
    expect(r.years).toEqual([]);
    expect(r.reason).toMatch(/non-Saudi\/non-GCC/);

    // 2. declared ZERO: a Zakat payer. Not an error, not an empty pool — NOT APPLICABLE.
    await setCompany("foreign_ownership_pct = 0, ownership_type = 'SAUDI_GCC'", []);
    r = await inTenant(() => incomeTaxPoolService.report());
    expect(r.status).toBe("not_applicable");
    expect(r.reason).toMatch(/Zakat/);
    expect(r.years).toEqual([]);

    // 3. an income-tax payer with no fiscal year: there is no taxable year to compute over.
    await setCompany("foreign_ownership_pct = 40, ownership_type = 'MIXED'", []);
    r = await inTenant(() => incomeTaxPoolService.report());
    expect(r.status).toBe("fiscal_year_not_declared");

    // 4. the chain has no start. 🔴 The register is NOT empty by now in later
    //    tests, and it still would not help: a pool balance is not a carrying
    //    amount. Nothing is assumed to be nil.
    await setCompany("fiscal_year_start = 1, fiscal_calendar = 'gregorian'", []);
    r = await inTenant(() => incomeTaxPoolService.report());
    expect(r.status).toBe("anchor_not_declared");
    expect(r.reason).toMatch(/own return/);
    expect([r.foreignOwnershipPct, r.ownershipType]).toEqual([40, "MIXED"]);
    // the frame travels even when there are no figures
    expect(r.frameLimits.map((f) => f.article)).toEqual(["17(a)", "17(f)", "17(j)", "17(k)", "17(l)"]);
  }, 60_000);

  it("🔴 a declaration states something, names a group the Law has, and an ANCHOR is complete — three refusals by name", async () => {
    await expectRefusal(inTenant(() => incomeTaxPoolService.declare({ incomeTaxGroup: 6, taxYear: 2024, closingBalanceDeclared: 0, additionsDeclared: 0, disposalsDeclared: 0 }, userId)), 422, "income_tax_group_unknown");
    await expectRefusal(inTenant(() => incomeTaxPoolService.declare({ incomeTaxGroup: 3, taxYear: 2024, closingBalanceDeclared: 50_000 }, userId)), 422, "anchor_incomplete");
    await expectRefusal(inTenant(() => incomeTaxPoolService.declare({ incomeTaxGroup: 3, taxYear: 2024 }, userId)), 422, "declaration_empty");
    expect(await inTenant(() => incomeTaxPoolService.declarations())).toEqual([]);
  }, 60_000);

  it("🔴 the anchor makes the chain computable, and the register drives it: a bill's asset enters the pool in the year it went INTO SERVICE, not the year it was bought", async () => {
    // The anchor: group 3 closed 2024 at 80,000 with 20,000 of additions that
    // year (whose other half falls into 2025); the rest of the groups nil.
    for (const g of [1, 2, 3, 4, 5]) {
      await inTenant(() => incomeTaxPoolService.declare({
        incomeTaxGroup: g, taxYear: 2024,
        closingBalanceDeclared: g === 3 ? 80_000 : 0,
        additionsDeclared: g === 3 ? 20_000 : 0,
        disposalsDeclared: 0,
      }, userId));
    }

    // 🔴 BOUGHT 2025-12-20, IN SERVICE 2026-01-05. Art. 17(e) counts assets IN
    // USE, so this is a 2026 addition — and a register keying on the purchase
    // date would put it in 2025. The two dates are a year apart on purpose.
    const press = await inTenant(() => assetsService.create({ name: "Hydraulic press", categoryId: machineryCat, acquisitionDate: "2025-12-20", availableForUseDate: "2026-01-05", cost: 200_000 }, userId));
    pressId = press.id;

    // Before the bill it is a DRAFT — not in use, not in the pool. The absence
    // must be real, so it is asserted before the movement that removes it.
    let r = await inTenant(() => incomeTaxPoolService.report({ toYear: 2026 }));
    expect(r.status).toBe("computed");
    expect(r.anchorYear).toBe(2024);
    expect(chain(r, 3)).toEqual([
      { year: 2025, opening: 80_000, addHalf: 10_000, dispHalf: 0, deduction: 22_500, closing: 67_500 },
      { year: 2026, opening: 67_500, addHalf: 0, dispHalf: 0, deduction: 16_875, closing: 50_625 },
    ]);

    await buyAsset(pressId, "BILL-FA-E-1", "2025-12-20", 200_000);
    expect((await inTenant(() => assetsService.getById(pressId))).status).toBe("in_service");

    r = await inTenant(() => incomeTaxPoolService.report({ toYear: 2027 }));
    const g3 = chain(r, 3);
    // 2025 is UNCHANGED — the asset was not in use then, whatever the bill says.
    expect(g3[0]).toEqual({ year: 2025, opening: 80_000, addHalf: 10_000, dispHalf: 0, deduction: 22_500, closing: 67_500 });
    // 2026 takes half of 200,000; 2027 takes the other half.
    expect(g3[1]).toEqual({ year: 2026, opening: 67_500, addHalf: 100_000, dispHalf: 0, deduction: 41_875, closing: 125_625 });
    expect(g3[2]).toEqual({ year: 2027, opening: 125_625, addHalf: 100_000, dispHalf: 0, deduction: 56_406.25, closing: 169_218.75 });

    // the year's figure can be OPENED: the asset that made it, by number and date
    const items2026 = r.years.find((y) => y.taxYear === 2026)!.groups.find((g) => g.group === 3)!.additionItems;
    expect(items2026).toEqual([{ assetNumber: press.assetNumber, name: "Hydraulic press", date: "2026-01-05", cost: 200_000 }]);
    // and it is in GROUP 3 only — group 5 never saw it
    expect(r.years.every((y) => y.groups.find((g) => g.group === 5)!.additionItems.length === 0)).toBe(true);
  }, 90_000);

  it("🔴 a disposal takes 50 % of its COMPENSATION out of the pool in each of two years, and the group's own assets decide whether Art. 17(i) is even available", async () => {
    // A desk in group 5, in service 2026-03, scrapped 2026-09 for nothing.
    const desk = await inTenant(() => assetsService.create({ name: "Reception desk", categoryId: furnitureCat, acquisitionDate: "2026-03-01", availableForUseDate: "2026-03-01", cost: 12_000 }, userId));
    deskId = desk.id;
    await buyAsset(deskId, "BILL-FA-E-2", "2026-03-01", 12_000);

    let r = await inTenant(() => incomeTaxPoolService.report({ toYear: 2026 }));
    let g5 = r.years.find((y) => y.taxYear === 2026)!.groups.find((g) => g.group === 5)!;
    expect([g5.additionsCurrent, g5.additionsHalf, g5.balanceBeforeDeduction, g5.depreciationDeduction]).toEqual([12_000, 6_000, 6_000, 600]);
    // 🔴 group 5 is NOT closed: it has an asset and the asset is in service
    expect(g5.elections.groupClosed).toEqual({ available: false, amount: 0, taken: false });

    await inTenant(() => assetDisposalService.dispose(deskId, { kind: "scrapped", date: "2026-09-30", reason: "Broken beyond repair" }, userId));
    expect((await inTenant(() => assetsService.getById(deskId))).status).toBe("disposed");

    r = await inTenant(() => incomeTaxPoolService.report({ toYear: 2026 }));
    g5 = r.years.find((y) => y.taxYear === 2026)!.groups.find((g) => g.group === 5)!;
    // a scrap brings NO compensation, so the pool keeps the cost — this is the
    // whole point of a pool: the book loss and the tax balance disagree.
    expect([g5.disposalsCurrent, g5.disposalsHalf, g5.balanceBeforeDeduction]).toEqual([0, 0, 6_000]);
    // 🔴 but the GROUP is now empty of assets, so Art. 17(i) becomes available —
    // offered at 5,400 (6,000 less the 10 % deduction) and NOT taken.
    expect(g5.elections.groupClosed).toEqual({ available: true, amount: 5_400, taken: false });
    expect(g5.closingBalance).toBe(5_400);
    expect(g5.disposalItems).toEqual([{ assetNumber: desk.assetNumber, date: "2026-09-30", proceeds: 0, kind: "scrapped", deemedValueMissing: false }]);

    // taking the election is a declaration, and it moves the figure
    await inTenant(() => incomeTaxPoolService.declare({ incomeTaxGroup: 5, taxYear: 2026, electGroupClosedWriteOff: true }, userId));
    r = await inTenant(() => incomeTaxPoolService.report({ toYear: 2027 }));
    g5 = r.years.find((y) => y.taxYear === 2026)!.groups.find((g) => g.group === 5)!;
    expect([g5.elections.groupClosed.taken, g5.totalDeduction, g5.closingBalance]).toEqual([true, 6_000, 0]);
    // and the next year opens at zero — an election rewrites the chain, which is
    // exactly why the engine never takes one on the taxpayer's behalf
    expect(r.years.find((y) => y.taxYear === 2027)!.groups.find((g) => g.group === 5)!.openingBalance).toBe(0);
  }, 90_000);

  it("🔴 Art. 18 repairs are DECLARED, never derived — undeclared reads as undeclared, and declaring moves the pool and the deduction together", async () => {
    let r = await inTenant(() => incomeTaxPoolService.report({ toYear: 2026 }));
    let g3 = r.years.find((y) => y.taxYear === 2026)!.groups.find((g) => g.group === 3)!;
    expect(g3.repairsNotDeclared).toBe(true);
    expect(g3.repairs.declared).toBeNull();
    const balanceBefore = g3.balanceBeforeDeduction;
    const deductionBefore = g3.depreciationDeduction;

    // 2026 balance before repairs is 167,500 ⇒ the 4 % cap is 6,700.
    await inTenant(() => incomeTaxPoolService.declare({ incomeTaxGroup: 3, taxYear: 2026, repairsDeclared: 10_000 }, userId));
    r = await inTenant(() => incomeTaxPoolService.report({ toYear: 2026 }));
    g3 = r.years.find((y) => y.taxYear === 2026)!.groups.find((g) => g.group === 3)!;
    expect(g3.repairsNotDeclared).toBe(false);
    expect(g3.repairs).toEqual({ declared: 10_000, capBase: balanceBefore, cap: 6_700, deductibleAsExpense: 6_700, addedToPool: 3_300 });
    // 🔴 BOTH move, and by the stated amount — a cap that expensed everything or
    // an add-back that changed nothing would each pass a one-sided assertion.
    expect(g3.balanceBeforeDeduction).toBe(balanceBefore + 3_300);
    expect(g3.depreciationDeduction).toBe(deductionBefore + 825); // 25 % of 3,300
  }, 60_000);

  it("🔴 the declarations are listed and correctable, and a correction re-computes the chain from the anchor down", async () => {
    const before = await inTenant(() => incomeTaxPoolService.report({ toYear: 2026 }));
    const closing2026 = before.years.find((y) => y.taxYear === 2026)!.groups.find((g) => g.group === 3)!.closingBalance;

    const list = await inTenant(() => incomeTaxPoolService.declarations());
    const anchor3 = list.find((d) => d.incomeTaxGroup === 3 && d.taxYear === 2024)!;
    expect([anchor3.closingBalanceDeclared, anchor3.additionsDeclared, anchor3.ratePct]).toEqual([80_000, 20_000, 25]);

    // correct the anchor: the taxpayer had mis-keyed last year's balance
    await inTenant(() => incomeTaxPoolService.declare({ incomeTaxGroup: 3, taxYear: 2024, closingBalanceDeclared: 100_000, additionsDeclared: 20_000, disposalsDeclared: 0, note: "Per the filed 2024 return" }, userId));
    const after = await inTenant(() => incomeTaxPoolService.report({ toYear: 2026 }));
    expect(after.years.find((y) => y.taxYear === 2025)!.groups.find((g) => g.group === 3)!.openingBalance).toBe(100_000);
    expect(after.years.find((y) => y.taxYear === 2026)!.groups.find((g) => g.group === 3)!.closingBalance).toBeGreaterThan(closing2026);
    // 🔴 and the correction is one ROW, not a second one: an upsert, so the pool
    // can never read two different anchors for the same year.
    const relisted = await inTenant(() => incomeTaxPoolService.declarations());
    expect(relisted.filter((d) => d.incomeTaxGroup === 3 && d.taxYear === 2024)).toHaveLength(1);
    expect(relisted.find((d) => d.incomeTaxGroup === 3 && d.taxYear === 2024)!.note).toBe("Per the filed 2024 return");
  }, 60_000);

  it("🔴 the pool is COMPANY-scoped and never crosses a tenant: another org's assets are absent, and its own figures are present in its own report", async () => {
    // A second org with its own machinery, anchored nil.
    const otherSlug = `${SLUG}-other`;
    await pool.query(`DELETE FROM organizations WHERE slug = $1`, [otherSlug]);
    const otherOrg = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('FA E Other',$1) RETURNING id`, [otherSlug])).rows[0].id;
    const otherCompany = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, foreign_ownership_pct, ownership_type) VALUES ($1,'Other Co',1,100,'FOREIGN') RETURNING id`, [otherOrg])).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, otherOrg]);
    const inOther = async <T,>(fn: () => Promise<T>): Promise<T> => {
      const conn = await beginTenantConnection({ organizationId: otherOrg, companyId: otherCompany, role: "authenticated" });
      try { const out = await conn.run(() => auditContext.run({ userId, organizationId: otherOrg, ipAddress: null }, fn)); await conn.commit(); return out; }
      catch (err) { await conn.rollback(); throw err; }
    };
    try {
      const otherVendor = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Other Supplier') RETURNING id`, [otherOrg])).rows[0].id;
      const cat = await inOther(() => assetsService.createCategory({ name: "Other machinery", defaultUsefulLifeMonths: 60, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId));
      const a = await inOther(() => assetsService.create({ name: "Other lathe", categoryId: cat.id, acquisitionDate: "2026-02-01", availableForUseDate: "2026-02-01", cost: 500_000 }, userId));
      await inOther(() => incomeTaxPoolService.declare({ incomeTaxGroup: 3, taxYear: 2024, closingBalanceDeclared: 0, additionsDeclared: 0, disposalsDeclared: 0 }, userId));

      const g3Of = (r: Awaited<ReturnType<typeof incomeTaxPoolService.report>>) =>
        r.years.find((y) => y.taxYear === 2026)!.groups.find((g) => g.group === 3)!;

      // While it is a DRAFT it is in NEITHER pool — the baseline both halves move from.
      expect(a.status).toBe("draft");
      expect(g3Of(await inOther(() => incomeTaxPoolService.report({ toYear: 2026 }))).additionsCurrent).toBe(0);

      // 🔴 MOVEMENT. Capitalise it through the other org's OWN bill path, so
      // the asset really is in service and really is 500,000. Without this the
      // absence below would pass on an empty register, which is the way an
      // isolation test most often lies.
      const otherBill = await inOther(() => billsService.create({ billNumber: "BILL-OTHER-1", date: "2026-02-01", vendorId: otherVendor, subtotal: 500_000, vatAmount: 0, total: 500_000, capitalisesAssetId: a.id, items: [{ description: "Lathe", quantity: 1, unitPrice: 500_000 }] }, userId));
      await inOther(() => billsService.approve(otherBill.id, {}, userId));
      expect((await inOther(() => assetsService.getById(a.id))).status).toBe("in_service");

      const theirs = await inOther(() => incomeTaxPoolService.report({ toYear: 2026 }));
      expect(theirs.status).toBe("computed");
      // THEIR figure moved from 0 to 500,000 and names their own asset…
      expect(g3Of(theirs).additionsCurrent).toBe(500_000);
      expect(g3Of(theirs).additionItems.map((i) => i.name)).toEqual(["Other lathe"]);

      // …and OURS is untouched: 200,000, and the 500,000 appears nowhere in it.
      const ours = await inTenant(() => incomeTaxPoolService.report({ toYear: 2026 }));
      expect(g3Of(ours).additionsCurrent).toBe(200_000);
      expect(g3Of(ours).additionItems.map((i) => i.name)).toEqual(["Hydraulic press"]);
      expect(g3Of(ours).additionItems.some((i) => i.cost === 500_000)).toBe(false);
      // nor does their anchor reach us: our chain still starts at the corrected 100,000
      expect(ours.years.find((y) => y.taxYear === 2025)!.groups.find((g) => g.group === 3)!.openingBalance).toBe(100_000);
    } finally {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const org = `(SELECT id FROM organizations WHERE slug = '${otherSlug}')`;
        for (const t of ["asset_tax_pool_declarations", "asset_events", "asset_depreciation_schedule", "fixed_assets", "asset_categories", "bill_items", "bills", "journal_entry_lines", "journal_entries", "audit_logs", "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
          await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
        }
        await client.query(`DELETE FROM organizations WHERE slug = '${otherSlug}'`);
        await client.query("COMMIT");
      } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
    }
  }, 90_000);
});
