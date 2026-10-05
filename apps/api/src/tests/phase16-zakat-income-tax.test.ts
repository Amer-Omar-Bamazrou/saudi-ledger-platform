/**
 * PHASE 16B/16C/16D — Zakat and income-tax computations
 * (docs/product/phase-16-17-tax-treasury-decision-pack.md §3–§5, §10).
 *
 * Pure: every branch of the 1445H Regulations' Arts 21–28 and Art. 15, and the
 * income-tax engine's Art. 21 cap and Art. 6(a) share.
 * Real rows: a ledger the product posted (journal entries through create +
 * approve), classified by a person, computed, approved through the ONE
 * approval engine — and the database locks attacked directly.
 *
 * The Zakat fixture (fiscal year 2025, Gregorian, 365 days), by hand:
 *   assets  fixed 600,000 − acc. dep. 60,000 (deducted, Art. 26(4)) · raw materials 50,000 (deducted current, Art. 52)
 *           · inventory 500,000 (not deducted)                                 total 1,090,000
 *   liab.   loan 200,000 + end-of-service 20,000 (non-current, 29(1)) · payables 150,000 (current) · provision 10,000 (as equity, Art. 24)
 *   equity  capital 600,000 + the year's result 110,000
 *   D = 590,000 · CL added for the deducted raw materials = 50,000 ÷ 550,000 × 150,000 = 13,636.36 (Art. 25(2))
 *   base = 710,000 + 10,000 + (220,000 + 13,636.36) − 590,000 = 363,636.36
 *   Zakat = 363,636.36 × 2.5 % ÷ 354 × 365 = 9,373.39
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";
import { reportsService } from "../services/reports.service";
import { treasuryService } from "../services/treasury/treasury.service";
import { taxObligationsService } from "../services/tax/taxObligations.service";
import { GetTaxComputationResponse, ListTaxComputationsResponse, ListZakatClassificationsResponse } from "@workspace/api-zod";
import { exportReport } from "../services/reporting/reportExport.service";
import { expectConforms } from "./helpers/conforms";
import { taxComputationsService } from "../services/tax/taxComputations.service";
import { zakatClassificationService } from "../services/tax/zakatClassification.service";
import { incomeTaxPoolService } from "../services/assets/incomeTaxPool.service";
import { computeZakat, type ZakatInputs } from "../services/tax/zakatEngine";
import { computeIncomeTax } from "../services/tax/incomeTaxEngine";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-zakat-income-tax] no real DATABASE_URL — skipping.");

// ── pure: the Zakat engine ─────────────────────────────────────────────────
const L = (zakatClass: ZakatInputs["lines"][number]["zakatClass"], amount: number, name: string = zakatClass) => ({ accountId: null, key: name, name, nameAr: name, zakatClass, amountH: Math.round(amount * 100) });
const base = (lines: ZakatInputs["lines"], bookNp: number, adj: ZakatInputs["adjustments"] = [], cal: "gregorian" | "hijri" = "hijri", days = 354): ZakatInputs => ({
  lines, totalAssetsH: lines.filter((l) => String(l.zakatClass).includes("asset")).reduce((s, l) => s + l.amountH, 0),
  bookNetProfitH: Math.round(bookNp * 100), adjustments: adj, calendar: cal, fiscalYearDays: days,
});

describe("Phase 16 — the Zakat engine (pure, Arts 15, 21–29)", () => {
  it("🔴 the hand-worked fixture: Art. 25(2) adds the deducted current asset's share of current liabilities; Gregorian rate × 365 ÷ 354", () => {
    const r = computeZakat(base([
      L("equity", 600_000, "capital"), L("equity_computed", 110_000, "result"), L("provision_as_equity", 10_000),
      L("noncurrent_asset_deducted", 600_000, "fixed"), L("noncurrent_asset_deducted", -60_000, "accdep"),
      L("current_asset_deducted", 50_000, "raw"), L("current_asset_not_deducted", 500_000, "inventory"),
      L("noncurrent_liability", 200_000, "loan"), L("noncurrent_liability", 20_000, "eosb"), L("current_liability", 150_000, "payables"),
    ], 110_000, [], "gregorian", 365));
    expect(r.deductionsH).toBe(59_000_000);
    expect(r.clAddedForDeductedH).toBe(1_363_636);
    expect(r.liabilitiesAddedH).toBe(23_363_636);
    expect(r.baseByMethodH).toBe(36_363_636);
    expect(r.minimumRule).toBe("not_applied");
    expect(r.zakatBaseH).toBe(36_363_636);
    expect(r.zakatH, "363,636.36 × 2.5 % ÷ 354 × 365 = 9,373.39").toBe(937_339);
  });

  it("Art. 15(1): a Hijri zakat year is 2.5 % flat; Art. 15(2) a 366-day Gregorian year scales by 366 ÷ 354", () => {
    const lines = [L("equity", 100_000), L("current_asset_not_deducted", 100_000)];
    expect(computeZakat(base(lines, 0, [], "hijri", 355)).zakatH).toBe(250_000);
    expect(computeZakat(base(lines, 0, [], "gregorian", 366)).zakatH).toBe(258_475); // 2,500 × 366/354 = 2,584.745… → 2,584.75
  });

  it("🔴 Art. 25(1): an UNDEDUCTED non-current asset takes its share of non-current liabilities out — capped at the asset", () => {
    const r = computeZakat(base([
      L("equity", 1_000), L("noncurrent_asset_deducted", 900), L("noncurrent_asset_not_deducted", 100), L("noncurrent_liability", 500),
    ], 0));
    expect(r.nclExcludedH).toBe(5_000); // 100 ÷ 1,000 × 500 = 50
    expect(r.liabilitiesAddedH).toBe(45_000);
    const capped = computeZakat(base([
      L("equity", 1_000), L("noncurrent_asset_deducted", 900), L("noncurrent_asset_not_deducted", 100), L("noncurrent_liability", 5_000),
    ], 0));
    expect(capped.nclExcluded[0]!.excludedH, "the share (500) is capped at the asset (100)").toBe(10_000);
    expect(capped.liabilitiesAddedH, "and liabilities added never exceed the deductions (Art. 25(4))").toBe(90_000);
  });

  it("🔴 Art. 27(2): below adjusted net profit, the base is the LOWER of adjusted NP and undeducted assets + the difference — both arms", () => {
    // equity 400 (incl. the year's 300) · current liabilities 1,000 · deducted 900 · current assets 500 → by method 0
    const lines = [L("equity", 100), L("equity_computed", 300), L("current_liability", 1_000), L("noncurrent_asset_deducted", 900), L("current_asset_not_deducted", 500)];
    const a = computeZakat(base(lines, 300));
    expect([a.baseByMethodH, a.minimumRule, a.undeductedAssetsH, a.zakatBaseH]).toEqual([0, "27(2)", 50_000, 30_000]); // min(300, 500)
    const b = computeZakat(base(lines, 300, [{ target: "adjusted_net_profit", effect: "increase", amountH: 30_000 }]));
    // adjusted NP 600, difference 300 → min(600, 500 + 300) = 600 … then Art. 28's ceiling (400 + 300 = 700) does not bind
    expect([b.adjustedNetProfitH, b.differenceH, b.minimumRule, b.zakatBaseH]).toEqual([60_000, 30_000, "27(2)", 60_000]);
  });

  it("🔴 Art. 28 binds only after the floor raised the base above equity + the difference — and says so (Z-4)", () => {
    // The ceiling can bind only when equity is BELOW the year's book profit (accumulated losses): otherwise
    // the floor ≤ adjusted NP = equity + the difference = the ceiling. Equity: losses −200 + the year's 100.
    // deducted 900 · current assets 1,000 · current liabilities 1,800 · an add-back of 500 → adjusted NP 600
    const r = computeZakat(base([L("equity", -200), L("equity_computed", 100), L("noncurrent_asset_deducted", 900), L("current_asset_not_deducted", 1_000), L("current_liability", 1_800)], 100,
      [{ target: "adjusted_net_profit", effect: "increase", amountH: 50_000 }]));
    expect([r.baseByMethodH, r.minimumRule, r.baseAfterMinimumH]).toEqual([30_000, "27(2)", 60_000]); // −100 + 800 + 500 − 900 = 300 < 600 → min(600, 1,000 + 500)
    expect(r.maximumH).toBe(40_000); // −100 + 500
    expect([r.maximumApplied, r.floorAboveCeiling, r.zakatBaseH]).toEqual([true, true, 40_000]);
  });

  it("Art. 27(3)/(4): no adjusted profit — a negative base is no base; a positive one stands", () => {
    const neg = computeZakat(base([L("equity_computed", -500), L("noncurrent_asset_deducted", 900), L("current_liability", 400)], -500));
    expect([neg.minimumRule, neg.zakatBaseH, neg.zakatH]).toEqual(["27(3)", 0, 0]);
    const pos = computeZakat(base([L("equity", 2_000), L("equity_computed", -100), L("noncurrent_asset_deducted", 900), L("current_asset_not_deducted", 1_000)], -100));
    expect([pos.minimumRule, pos.zakatBaseH]).toEqual(["27(4)", 100_000]);
  });
});

describe("Phase 16 — the income-tax engine (pure)", () => {
  const inp = { profitBeforeTaxesH: 0, bookDepreciationH: 0, bookDisposalResultH: 0, poolDeductionH: 0, poolExcessIncomeH: 0, repairsOverCapH: 0, adjustments: [], lossCarryforwardAvailableH: 0, foreignShareBp: 10000 };
  it("book depreciation is replaced by the Art. 17 pool; 20 % of the non-Saudi share", () => {
    const r = computeIncomeTax({ ...inp, profitBeforeTaxesH: 10_000_000, bookDepreciationH: 2_000_000, poolDeductionH: 2_500_000 });
    expect([r.taxableIncomeH, r.incomeTaxH]).toEqual([9_500_000, 1_900_000]);
    const mixed = computeIncomeTax({ ...inp, profitBeforeTaxesH: 10_000_000, foreignShareBp: 2550 });
    expect([mixed.taxableShareH, mixed.incomeTaxH]).toEqual([2_550_000, 510_000]);
  });
  it("🔴 Art. 21: losses used never exceed 25 % of the year's income (rounded DOWN), nor what is available", () => {
    const r = computeIncomeTax({ ...inp, profitBeforeTaxesH: 1_000_003, lossCarryforwardAvailableH: 9_999_999 });
    expect([r.lossCapH, r.lossUsedH, r.taxableIncomeAfterLossesH]).toEqual([250_000, 250_000, 750_003]);
    const small = computeIncomeTax({ ...inp, profitBeforeTaxesH: 1_000_000, lossCarryforwardAvailableH: 10_000 });
    expect(small.lossUsedH).toBe(10_000);
    const loss = computeIncomeTax({ ...inp, profitBeforeTaxesH: -400_000, lossCarryforwardAvailableH: 50_000 });
    expect([loss.lossUsedH, loss.incomeTaxH, loss.lossOfTheYearH]).toEqual([0, 0, 400_000]);
  });
});

// ── real rows ────────────────────────────────────────────────────────────────
describeMaybe("Phase 16 — Zakat and income-tax computations on real rows", () => {
  const SLUG = "p16-zit", EMAIL = "p16-zit@test.local";
  let orgId = "", coZ = "", coF = "", coM = "", userId = 0;
  const a: Record<string, number> = {};
  let seq = 0;

  const inCo = async <T,>(co: string, fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const inZ = <T,>(fn: () => Promise<T>) => inCo(coZ, fn);
  const inF = <T,>(fn: () => Promise<T>) => inCo(coF, fn);
  const inM = <T,>(fn: () => Promise<T>) => inCo(coM, fn);
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const ORGS = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return e as { statusCode?: number; payload?: { code?: string }; message: string; constraint?: string }; }
    throw new Error("expected a refusal");
  };
  const cat = async (name: string, type: string, liquidity: string | null) =>
    (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable, liquidity_class) VALUES ($1,$2,$2,$3,false,$4) RETURNING id`, [orgId, name, type, liquidity])).rows[0].id as number;
  const post = async (inX: <T>(fn: () => Promise<T>) => Promise<T>, date: string, lines: [number, number, number][]) =>
    inX(async () => {
      const e = (await journalEntriesService.create({ entryNumber: `P16Z-${++seq}`, date, description: `p16 ${seq}`,
        lines: lines.map(([accountId, debitAmount, creditAmount]) => ({ accountId, debitAmount, creditAmount })) }, userId)) as { id: number };
      await journalEntriesService.approve(e.id, userId);
    });
  const glBySystem = async (co: string, code: string) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN categories c ON c.id = l.account_id WHERE e.company_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [co, code])).rows[0].v);

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P16 ZIT','${SLUG}','approved') RETURNING id`)).rows[0].id;
    coZ = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, ownership_type, foreign_ownership_pct) VALUES ($1,'Zakat Co',1,'gregorian','SAUDI_GCC',0) RETURNING id`, [orgId])).rows[0].id;
    await new Promise((r) => setTimeout(r, 20));
    coF = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, ownership_type, foreign_ownership_pct) VALUES ($1,'Foreign Co',1,'gregorian','FOREIGN',100) RETURNING id`, [orgId])).rows[0].id;
    coM = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, ownership_type, foreign_ownership_pct) VALUES ($1,'Mixed Co',1,'gregorian','MIXED',40) RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P16Z',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    a.capital = await cat("Share capital", "equity", null);
    a.fixed = await cat("Machinery", "asset", "non_current");
    a.accdep = await cat("Acc. dep. machinery", "asset", "non_current");
    a.raw = await cat("Raw materials", "asset", "current");
    a.inv = await cat("Finished goods", "asset", "current");
    a.loan = await cat("Long-term loan", "liability", "non_current");
    a.pay = await cat("Trade payables", "liability", "current");
    a.eosb = await cat("End-of-service provision", "liability", "non_current");
    a.prov = await cat("General provision", "liability", "current");
    a.sales = await cat("P16 sales", "income", null);
    a.exp = await cat("P16 expenses", "expense", null);
    // the year 2025, posted through the product
    await post(inZ, "2025-01-01", [[a.fixed!, 600_000, 0], [a.capital!, 0, 600_000]]);
    await post(inZ, "2025-01-02", [[a.inv!, 300_000, 0], [a.loan!, 0, 200_000], [a.pay!, 0, 100_000]]);
    await post(inZ, "2025-01-03", [[a.raw!, 50_000, 0], [a.pay!, 0, 50_000]]);
    await post(inZ, "2025-06-01", [[a.inv!, 500_000, 0], [a.sales!, 0, 500_000]]);
    await post(inZ, "2025-06-02", [[a.exp!, 300_000, 0], [a.inv!, 0, 300_000]]);
    await post(inZ, "2025-12-31", [[a.exp!, 60_000, 0], [a.accdep!, 0, 60_000]]);
    await post(inZ, "2025-12-31", [[a.exp!, 20_000, 0], [a.eosb!, 0, 20_000]]);
    await post(inZ, "2025-12-31", [[a.exp!, 10_000, 0], [a.prov!, 0, 10_000]]);
    // the foreign company: profit 200,000 in 2025
    await post(inF, "2025-03-01", [[a.inv!, 200_000, 0], [a.sales!, 0, 200_000]]);
  }, 180_000);
  afterAll(cleanup);

  it("🔴 scope: Zakat refuses a foreign company and a year before the 1445H Regulations; income tax refuses a Saudi-owned one", async () => {
    expect((await refusal(inZ(() => taxComputationsService.create({ kind: "zakat", fiscalYearLabel: 2023 }, userId)))).payload?.code).toBe("zakat_regulations_not_in_force");
    const fz = await inF(() => taxComputationsService.create({ kind: "zakat", fiscalYearLabel: 2025 }, userId));
    expect(fz.live!.blockers.map((b) => b.code)).toContain("zakat_not_eligible");
    const zi = await inZ(() => taxComputationsService.create({ kind: "income_tax", fiscalYearLabel: 2025 }, userId));
    expect(zi.live!.blockers.map((b) => b.code)).toContain("income_tax_not_applicable");
    // a blocked computation cannot be submitted
    expect((await refusal(inZ(() => taxComputationsService.submit(zi.id, zi.version!.id, userId)))).payload?.code).toBe("tax_computation_blocked");
  });

  let compId = 0, v1 = 0;
  it("🔴 an UNCLASSIFIED account with a balance blocks the base — named, never assumed; suggestions are offered, not applied", async () => {
    const c = await inZ(() => taxComputationsService.create({ kind: "zakat", fiscalYearLabel: 2025 }, userId));
    compId = c.id; v1 = c.version!.id;
    const blk = c.live!.blockers.find((b) => b.code === "zakat_unclassified_accounts")!;
    expect(blk.accounts!.map((x) => x.name).sort()).toEqual(["Acc. dep. machinery", "End-of-service provision", "Finished goods", "General provision", "Long-term loan", "Machinery", "Raw materials", "Trade payables"].sort());
    expect(c.live!.amount).toBeNull();
    const list = await inZ(() => zakatClassificationService.list());
    const inv = list.find((x) => x.accountId === a.inv)!;
    expect([inv.classification, inv.suggestion]).toEqual([null, "current_asset_not_deducted"]);
    // a liability cannot take an asset class (the database answers too)
    expect((await refusal(inZ(() => zakatClassificationService.set(a.loan!, { classification: "current_asset_deducted" }, userId)))).payload?.code).toBe("zakat_class_type");
  });

  it("🔴 Z1/Z2 — classified, the working paper IS the hand-worked base; Σ assets read = the balance sheet's; book profit = the income statement", async () => {
    const set = (id: number, c: string) => inZ(() => zakatClassificationService.set(id, { classification: c, basisNote: "test" }, userId));
    await set(a.fixed!, "noncurrent_asset_deducted"); await set(a.accdep!, "noncurrent_asset_deducted");
    await set(a.raw!, "current_asset_deducted"); await set(a.inv!, "current_asset_not_deducted");
    await set(a.loan!, "noncurrent_liability"); await set(a.eosb!, "noncurrent_liability");
    await set(a.pay!, "current_liability"); await set(a.prov!, "provision_as_equity");
    const d = await inZ(() => taxComputationsService.detail(compId));
    expect(d.live!.blockers).toEqual([]);
    const r = d.live!.zakat!.result!;
    expect([r.zakatBase, r.zakat, r.deductions, r.liabilitiesAdded]).toEqual([363_636.36, 9_373.39, 590_000, 233_636.36]);
    const rec = d.live!.reconciliation as { balanceSheetTotalAssets: number; assetsRead: number; bookNetProfit: number; balanceSheetYearResult: number; bookProfitMatchesBalanceSheet: boolean };
    expect([rec.assetsRead, rec.balanceSheetTotalAssets]).toEqual([1_090_000, 1_090_000]);
    const is = await inZ(() => reportsService.incomeStatement("2025-01-01", "2025-12-31"));
    expect([rec.bookNetProfit, rec.balanceSheetYearResult, is.netIncome, rec.bookProfitMatchesBalanceSheet]).toEqual([110_000, 110_000, 110_000, true]);
  });

  it("🔴 Z5 + Z4 — nothing moves before approval; approval posts Dr Zakat expense / Cr Zakat payable at the year-end; a revision posts the DIFFERENCE only", async () => {
    expect(await glBySystem(coZ, "ZAKAT_EXPENSE"), "zero movement before approval").toBe(0);
    await inZ(() => taxComputationsService.submit(compId, v1, userId));
    expect(await glBySystem(coZ, "ZAKAT_EXPENSE"), "zero movement after submission").toBe(0);
    const ap = await inZ(() => taxComputationsService.approve(compId, v1, userId));
    expect([ap.version!.status, ap.version!.resultAmount, ap.version!.accruedAmount, ap.version!.accrualDate]).toEqual(["approved", 9_373.39, 9_373.39, "2025-12-31"]);
    expect(await glBySystem(coZ, "ZAKAT_EXPENSE")).toBe(9_373.39);
    expect(await glBySystem(coZ, "ZAKAT_PAYMENT")).toBe(-9_373.39);
    // 🔴 its own accrual is excluded from its inputs: the ledger "has not changed" for it
    expect(ap.ledgerChangedSinceApproval).toBe(false);
    // the statements present it on its own line (SOCPA para 6)
    const is = await inZ(() => reportsService.incomeStatement("2025-01-01", "2025-12-31"));
    expect([is.zakatAndIncomeTax.total, is.profitBeforeZakatAndIncomeTax, is.netIncome, is.totalExpenses]).toEqual([9_373.39, 110_000, 100_626.61, 399_373.39]);
    expect(is.expenses.map((e) => e.name)).not.toContain("Zakat expense");

    // revise: an Art. 63 add-back of 15,000 → base 378,636.36 → Zakat 9,760.05 → posts 386.66
    const rv = await inZ(() => taxComputationsService.revise(compId, userId));
    const v2 = rv.version!.id;
    expect(rv.live!.adjustments).toEqual([]);
    const withAdj = await inZ(() => taxComputationsService.addAdjustment(compId, v2, { target: "adjusted_net_profit", effect: "increase", amount: 15_000, reason: "Fines are not an accepted expense", legalReference: "Zakat Regs Art. 62" }, userId));
    expect(withAdj.live!.zakat!.result!.zakat).toBe(9_760.05);
    const ap2 = await inZ(() => taxComputationsService.approve(compId, v2, userId));
    expect([ap2.version!.accruedAmount, ap2.version!.resultAmount]).toEqual([386.66, 9_760.05]);
    expect(await glBySystem(coZ, "ZAKAT_EXPENSE"), "Σ accruals = the approved Zakat").toBe(9_760.05);
    expect(ap2.versions.find((x) => x.id === v1)!.status).toBe("superseded");
  });

  it("🔴 the database locks an approved computation: no edit of its snapshot, no adjustment, no deletion; its accrual is never reversed generically", async () => {
    const v = (await pool.query(`SELECT id, accrual_journal_entry_id FROM tax_computation_versions WHERE computation_id = $1 AND status = 'approved'`, [compId])).rows[0];
    const owner = async (sql: string, params: unknown[]) => {
      const c = await pool.connect();
      try { await c.query("BEGIN"); await c.query(sql, params); throw new Error("NOT REFUSED"); }
      catch (e) { if ((e as Error).message === "NOT REFUSED") throw e; return (e as { constraint?: string }).constraint; }
      finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
    };
    expect(await owner(`UPDATE tax_computation_versions SET result_amount = 1 WHERE id = $1`, [v.id])).toBe("tax_computation_version_transition");
    expect(await owner(`DELETE FROM tax_computation_versions WHERE id = $1`, [v.id])).toBe("tax_computation_version_immutable");
    expect(await owner(`INSERT INTO tax_adjustments (organization_id, company_id, version_id, target, effect, amount, reason, legal_reference) VALUES ($1,$2,$3,'zakat_base','increase',1,'x x','Art. 1')`, [orgId, coZ, v.id])).toBe("tax_adjustment_locked");
    expect(await owner(`UPDATE tax_computations SET fiscal_year_end = '2025-12-30' WHERE id = $1`, [compId])).toBe("tax_computation_frozen");
    const e = await refusal(inZ(() => journalEntriesService.reverse(v.accrual_journal_entry_id, { reason: "try" })));
    expect(e.message).toMatch(/revising and approving the computation/);
    expect((await refusal(inZ(() => taxComputationsService.remove(compId)))).payload?.code).toBe("tax_computation_ever_approved");
  });

  it("🔴 a later posting INTO the year shows as 'the ledger has changed since approval' (a verification is a claim about a moment)", async () => {
    await post(inZ, "2025-12-15", [[a.exp!, 1_000, 0], [a.pay!, 0, 1_000]]);
    const d = await inZ(() => taxComputationsService.detail(compId));
    expect(d.ledgerChangedSinceApproval).toBe(true);
    expect((d.approvedSnapshot as { computation: { amount: number } }).computation.amount, "the approved figure stays the approved figure").toBe(9_760.05);
  });

  it("🔴 income tax: the pool replaces book depreciation; losses capped at 25 %; Dr income-tax expense / Cr payable on approval; MIXED with losses is refused (I-1)", async () => {
    // the pool: a nil anchor for 2024 in every group, then group 3 with a declared 2024 balance of 80,000
    for (const g of [1, 2, 4, 5]) await inF(() => incomeTaxPoolService.declare({ incomeTaxGroup: g, taxYear: 2024, closingBalanceDeclared: 0, additionsDeclared: 0, disposalsDeclared: 0 }, userId));
    await inF(() => incomeTaxPoolService.declare({ incomeTaxGroup: 3, taxYear: 2024, closingBalanceDeclared: 80_000, additionsDeclared: 0, disposalsDeclared: 0 }, userId));
    const c = await inF(() => taxComputationsService.create({ kind: "income_tax", fiscalYearLabel: 2025 }, userId));
    expect(c.live!.blockers).toEqual([]);
    const it1 = c.live!.incomeTax!;
    expect([it1.profitBeforeTaxes, it1.poolDeduction, it1.taxableIncome]).toEqual([200_000, 20_000, 180_000]); // group 3 at 25 % of 80,000
    await inF(() => taxComputationsService.setLosses(c.id, c.version!.id, { amount: 100_000, reference: "Audited FS 2024, note 18" }));
    const withLoss = await inF(() => taxComputationsService.detail(c.id));
    expect([withLoss.live!.incomeTax!.lossCap, withLoss.live!.incomeTax!.lossUsed, withLoss.live!.incomeTax!.incomeTax]).toEqual([45_000, 45_000, 27_000]);
    await inF(() => taxComputationsService.approve(c.id, c.version!.id, userId));
    expect(await glBySystem(coF, "INCOME_TAX_EXPENSE")).toBe(27_000);
    expect(await glBySystem(coF, "INCOME_TAX_PAYABLE")).toBe(-27_000);

    const m = await inM(() => taxComputationsService.create({ kind: "income_tax", fiscalYearLabel: 2025 }, userId));
    await inM(() => taxComputationsService.setLosses(m.id, m.version!.id, { amount: 10_000, reference: "FS" }));
    expect((await inM(() => taxComputationsService.detail(m.id))).live!.blockers.map((b) => b.code)).toContain("income_tax_mixed_losses_open");
  });

  it("🔴 cash flow — the accrual is NON-CASH; paying the Zakat payable is its OWN operating line (IAS 7.35 as endorsed: separately disclosed); the statement reconciles and treasury reads the same cash", async () => {
    type CF = Awaited<ReturnType<typeof reportsService.cashFlow>>;
    const items = (cf: CF) => [...cf.operating.items, ...cf.investing.items, ...cf.financing.items, ...cf.internal.items];
    // FY 2025: the two approvals posted Dr Zakat expense / Cr Zakat payable — no cash line, so NO cash flow at all
    const cf25 = await inZ(() => reportsService.cashFlow("2025-01-01", "2025-12-31"));
    expect(items(cf25)).toEqual([]);
    expect([cf25.openingCash, cf25.netChange, cf25.closingCash, cf25.reconciles]).toEqual([0, 0, 0, true]);
    expect(await glBySystem(coZ, "ZAKAT_PAYMENT"), "the payable stands at the approved Zakat").toBe(-9_760.05);
    const owed = (await inZ(() => taxObligationsService.list())).obligations.filter((o) => o.kind === "zakat");
    expect(owed.map((o) => o.amount)).toEqual([9_760.05]);

    // 2026: cash comes in, then the Zakat is paid from the bank — through the product's journal path
    const bank = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Zakat Co bank','SNB') RETURNING id`, [orgId, coZ])).rows[0].id;
    const leaf = (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [bank])).rows[0].id as number;
    const payable = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'ZAKAT_PAYMENT'`, [orgId])).rows[0].id as number;
    await post(inZ, "2026-01-05", [[leaf, 20_000, 0], [a.capital!, 0, 20_000]]);
    await post(inZ, "2026-02-10", [[payable, 9_760.05, 0], [leaf, 0, 9_760.05]]);

    const cf26 = await inZ(() => reportsService.cashFlow("2026-01-01", "2026-12-31"));
    expect(cf26.operating.items.map((i) => [i.key, i.amount])).toEqual([["zakat_income_tax", -9_760.05]]);
    expect(items(cf26).some((i) => i.key === "taxes"), "Zakat is never folded into the VAT/WHT line").toBe(false);
    expect(cf26.financing.items.map((i) => [i.key, i.amount])).toEqual([["owners", 20_000]]);
    expect([cf26.netCashFromActivities, cf26.netChange, cf26.closingCash, cf26.reconciles]).toEqual([10_239.95, 10_239.95, 10_239.95, true]);
    // treasury reads the SAME cash from the ledger — one figure, never a second one, never counted twice
    const pos = await inZ(() => treasuryService.position());
    expect([pos.totalCash, pos.reconciliation.reconciles, pos.banks.map((b) => b.ledgerBalance)]).toEqual([10_239.95, true, [10_239.95]]);
    // settled to the halala: nothing left on the payable, and the obligations calendar no longer lists Zakat
    expect(await glBySystem(coZ, "ZAKAT_PAYMENT")).toBe(0);
    expect((await inZ(() => taxObligationsService.list())).obligations.filter((o) => o.kind === "zakat")).toEqual([]);
  });

  it("🔴 approval waits for the year to END: a current-year computation is a live projection only", async () => {
    const cur = await inZ(() => taxComputationsService.create({ kind: "zakat", fiscalYearLabel: 2026 }, userId));
    expect((await refusal(inZ(() => taxComputationsService.approve(cur.id, cur.version!.id, userId)))).payload?.code).toBe("tax_year_not_ended");
  });

  it("🔴 contract conformance — the computation responses parse under their generated schemas: live Zakat, the approved SNAPSHOT, income tax, a blocked one, the classifications", async () => {
    const z = await inZ(() => taxComputationsService.detail(compId));
    expect([z.live?.zakat?.result != null, z.approvedSnapshot != null]).toEqual([true, true]);
    expectConforms(GetTaxComputationResponse, z, "GET /tax/computations/:id (Zakat, approved, with snapshot)");
    // the snapshot IS a TaxComputationLive (the union reconciliation, the working paper) frozen
    expect("balanceSheetTotalAssets" in (z.approvedSnapshot as { computation: { reconciliation: object } }).computation.reconciliation).toBe(true);
    expectConforms(ListTaxComputationsResponse, await inZ(() => taxComputationsService.list("zakat")), "GET /tax/computations?kind=zakat");
    const inc = await inF(() => taxComputationsService.list("income_tax"));
    expect(inc.length).toBeGreaterThan(0);
    const it1 = await inF(() => taxComputationsService.detail(inc[0]!.id));
    expect(it1.live?.incomeTax).not.toBeNull();
    expectConforms(GetTaxComputationResponse, it1, "GET /tax/computations/:id (income tax)");
    const blocked = await inM(() => taxComputationsService.list("income_tax"));
    if (blocked.length) expectConforms(GetTaxComputationResponse, await inM(() => taxComputationsService.detail(blocked[0]!.id)), "GET /tax/computations/:id (blocked)");
    expectConforms(ListZakatClassificationsResponse, await inZ(() => zakatClassificationService.list()), "GET /tax/zakat/classifications");
    // the instrument sees: a snapshot with its computation missing FAILS
    expect(GetTaxComputationResponse.safeParse({ ...JSON.parse(JSON.stringify(z)), approvedSnapshot: { frozenAt: "x" } }).success).toBe(false);
    // 🔴 the export of an APPROVED version is its FROZEN working paper — the approved 9,760.05, though the live
    // reading has since moved (the 2025-12-15 posting above) — never a recomputation
    const frozenAmount = (z.approvedSnapshot as { computation: { amount: number } }).computation.amount;
    expect(frozenAmount).toBe(9_760.05);
    expect(z.live!.amount, "the live reading moved").not.toBe(frozenAmount);
    const csv = (await inZ(() => exportReport("tax-computation", { computation_id: String(compId), version_id: String(z.version!.id) }, "csv", "en"))).body.toString("utf8");
    expect(csv).toContain("9,760.05".replace(",", "")) ;
    expect(csv).toContain("frozen approved working paper");
  });

  it("isolation — another company of the same organisation sees none of these computations", async () => {
    const zList = (await inZ(() => taxComputationsService.list())).map((x) => x.id);
    expect(zList).toContain(compId);
    expect((await inF(() => taxComputationsService.list())).map((x) => x.id)).not.toContain(compId);
    expect((await refusal(inF(() => taxComputationsService.detail(compId)))).statusCode).toBe(404);
  });
});
