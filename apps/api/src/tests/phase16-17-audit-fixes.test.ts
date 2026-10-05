/**
 * PHASE 16 + 17 — THE FINAL AUDIT'S FIXES, ON REAL ROWS (2026-10-05; pack phase-16-17 §15).
 *
 *   WHT-1  a bank-statement line settles a non-resident's bill by the GROSS whose cash it is — the pay path's own
 *          arithmetic inverted (`baseForCash`), never the cash itself; the books move exactly the line's cash.
 *   WHT-2  an expense's approval (which also pays) is refused, by name and before any write, where the canonical
 *          decision would withhold or cannot judge without a declaration.
 *   MG-2   the generic journal reverse never reverses a mirror nor a migration's own entry — service AND database.
 *   MG-1   a migration reversal and a depreciation posting serialise on the asset row.
 *   SEC-1  the WHT return functions answer only inside the caller's tenant (RLS — caller's rights).
 *   SEC-4  a filing replayed with its ZATCA reference is the same filing, never a false amendment.
 *   IT-1   income tax adds back the register's depreciation wherever it posted — never another expense.
 *   TR-1   (API half) a plan paid into a FILED month with its stated treatment is paid.
 *
 * Every expected figure is computed here from the fixture — never by calling the code under test a second way.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { baseForCash, whtHalalas } from "../services/accounting/wht";
import { billsService } from "../services/bills.service";
import { whtService } from "../services/tax/wht.service";
import { whtCorrectionService } from "../services/tax/whtCorrection.service";
import { reconciliationService } from "../services/reconciliation.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { periodLocksService } from "../services/periodLocks.service";
import { treasuryService } from "../services/treasury/treasury.service";
import { paymentPlansService } from "../services/treasury/paymentPlans.service";
import { reportsService } from "../services/reports.service";
import { assetsService } from "../services/assets.service";
import { assetCapitalisationService } from "../services/assets/capitalisation.service";
import { incomeTaxPoolService } from "../services/assets/incomeTaxPool.service";
import { migrationService } from "../services/migration.service";
import { migrationStagingService } from "../services/migrationStaging.service";
import { migrationValidationService } from "../services/migrationValidation.service";
import { migrationCommitService } from "../services/migrationCommit.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { taxComputationsService } from "../services/tax/taxComputations.service";
import { taxRepository } from "../repositories/tax.repository";
import { assetDisposalService } from "../services/assets/disposal.service";
import { translateDbRefusal } from "../lib/dbRefusals";
import { businessToday } from "@workspace/shared";
import { addDays } from "../services/tax/taxComputations.service";
import { categoriesService } from "../services/categories.service";

type PoolClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void }; // eslint-disable-line @typescript-eslint/no-explicit-any
const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-17-audit-fixes] no real DATABASE_URL — skipping.");

describe("WHT-1 — baseForCash: the exact inverse of the pay path's arithmetic (pure)", () => {
  it("every base round-trips through its cash at 0 %, 5 %, 15 % and 20 % (the preferred base decides a halala tie)", () => {
    for (const rate of ["0.0000", "0.0500", "0.1500", "0.2000"]) {
      for (const baseH of [1, 99, 1_000, 333_337, 333_336, 1_000_000, 1_000_010, 987_654_321]) {
        const cashH = baseH - whtHalalas(baseH, rate);
        expect(baseForCash(cashH, rate, baseH), `${rate} ${baseH}`).toBe(baseH);
      }
    }
  });
  it("🔴 where the tax steps a halala, TWO bases give one cash — ambiguous without a preference (null, the caller refuses); never a guess", () => {
    // 3,333.29 → tax 166.66 (16,666.45 rounds down) → cash 3,166.63; 3,333.30 → tax 166.67 (16,666.5 rounds up) → cash 3,166.63
    expect([333_329 - whtHalalas(333_329, "0.05"), 333_330 - whtHalalas(333_330, "0.05")]).toEqual([316_663, 316_663]);
    expect(baseForCash(316_663, "0.05")).toBeNull();
    expect(baseForCash(316_663, "0.05", 333_330)).toBe(333_330);
    expect(baseForCash(316_663, "0.05", 333_329)).toBe(333_329);
    expect(baseForCash(316_663, "0.05", 999_999)).toBeNull(); // a preference that is neither base decides nothing
    expect(baseForCash(0, "0.05")).toBeNull();
  });
});

describeMaybe("Phase 16 + 17 — the final audit's fixes (real rows)", () => {
  const SLUG = "p1617-fix", SLUG_X = "p1617-fix-x", EMAIL = "p1617-fix@test.local";
  let orgId = "", coA = "", coB = "", coM = "", coF = "", orgX = "", coX = "", userId = 0;
  let bankA = 0, bankB = 0, bankM = 0, bankF = 0, bankX = 0;
  const v = { nr: 0, nrNoDefault: 0, resident: 0, nrRelief: 0 };
  let seq = 0;

  const tenant = (org: () => string, co: () => string) => async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org(), companyId: co(), role: "authenticated" });
    try { const out = await conn.run(() => auditContext.run({ userId, organizationId: org(), ipAddress: null }, fn)); await conn.commit(); return out; }
    catch (err) { await conn.rollback(); throw err; }
  };
  const inA = tenant(() => orgId, () => coA), inB = tenant(() => orgId, () => coB), inM = tenant(() => orgId, () => coM), inF = tenant(() => orgId, () => coF), inX = tenant(() => orgX, () => coX);
  type Run = typeof inA;
  const asApp = async <T,>(org: string, co: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('app.current_org_id', $1, true)", [org]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [co]);
      return await fn(c);
    } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  };
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { const x = e as { statusCode?: number; payload?: { code?: string }; message: string; constraint?: string; code?: string; cause?: { constraint?: string; code?: string } }; return { status: x.statusCode ?? null, code: x.payload?.code ?? null, constraint: x.constraint ?? x.cause?.constraint ?? null, pg: x.code ?? x.cause?.code ?? null, message: String(x.message) }; }
    throw new Error("expected a refusal");
  };
  const q = async (s: string, p: unknown[] = []) => (await pool.query(s, p)).rows;
  const n = (x: unknown) => Math.round(Number(x) * 100) / 100;
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica");
      const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG}','${SLUG_X}'))`;
      const { rows } = await c.query(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM organizations WHERE slug IN ('${SLUG}','${SLUG_X}')`);
      await c.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email = '${EMAIL}')`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const glSys = async (co: string, code: string) => n((await q(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount),0) v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.company_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [co, code]))[0].v);
  const bankGl = async (bank: number) => n((await q(
    `SELECT coalesce(sum(v.debit_amount - v.credit_amount),0) v FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bank]))[0].v);
  const counts = async (co: string) => (await q(
    `SELECT (SELECT count(*) FROM journal_entries WHERE company_id = $1)::int je, (SELECT count(*) FROM bill_payments WHERE company_id = $1)::int bp,
            (SELECT count(*) FROM wht_withholdings WHERE company_id = $1)::int ww, (SELECT count(*) FROM bank_line_links WHERE company_id = $1)::int links`, [co]).catch(async () => q(
    `SELECT (SELECT count(*) FROM journal_entries WHERE company_id = $1)::int je, (SELECT count(*) FROM bill_payments WHERE company_id = $1)::int bp,
            (SELECT count(*) FROM wht_withholdings WHERE company_id = $1)::int ww`, [co])))[0];
  const bill = async (run: Run, vendorId: number, net: number, date: string) => {
    const d = await run(() => billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: `FX-${++seq}`, billNumber: `FX-B-${seq}`, date, dueDate: "2026-12-31", vendorId,
      items: [{ description: "Consulting", quantity: 1, unitPrice: net, vatRate: 0 }] }, userId)) as { id: number };
    return (await run(() => billsService.approve(d.id, {}, userId)) as { id: number }).id;
  };
  const statementLine = async (co: string, bank: number, amount: number, date: string) =>
    (await q(`INSERT INTO transactions (organization_id, company_id, date, description, amount, type, review_status, bank_account_id) VALUES ($1,$2,$3,$4,$5,'debit','pending_review',$6) RETURNING id`,
      [orgId, co, date, `Outgoing transfer ${++seq}`, amount.toFixed(2), bank]))[0].id as number;
  const owes = async (billId: number) => n((await q(`SELECT total::numeric - coalesce(paid_amount,0) v FROM bills WHERE id = $1`, [billId]))[0].v);
  const fund = async (run: Run, co: string, bank: number, amount: number, date: string) => {
    const leaf = (await q(`SELECT id FROM categories WHERE bank_account_id = $1`, [bank]))[0].id;
    const re = (await q(`SELECT id FROM categories WHERE organization_id = (SELECT organization_id FROM companies WHERE id = $1) AND system_code = 'RETAINED_EARNINGS'`, [co]))[0].id;
    await run(async () => {
      const je = (await journalEntriesService.create({ entryNumber: `FX-FUND-${++seq}`, date, description: "funding", lines: [{ accountId: leaf, debitAmount: amount, creditAmount: 0 }, { accountId: re, debitAmount: 0, creditAmount: amount }] }, userId)) as { id: number };
      await journalEntriesService.approve(je.id, userId);
    });
  };
  /** A migration with one or more machinery assets, cutover `cutover`, bank + cost + accumulated against retained earnings. */
  const migrate = async (run: Run, bank: number, catBySource: Record<string, number>, assets: Array<{ sourceId: string; cost: number; acc: number; category: string }>, cutover: string) => {
    const b = await run(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate: cutover }, userId));
    const cost = assets.reduce((s, a) => s + a.cost, 0), acc = assets.reduce((s, a) => s + a.acc, 0);
    const costAccountOf: Record<string, number> = {};
    for (const [name, catId] of Object.entries(catBySource)) costAccountOf[name] = Number((await q(`SELECT cost_account_id id FROM asset_categories WHERE id = $1`, [catId]))[0].id);
    const costAccounts = [...new Set(assets.map((a) => costAccountOf[a.category]!))];
    const rows: Array<Record<string, unknown>> = [
      { sourceCode: "1100", sourceName: "Bank", sourceType: "asset", openingDebit: 5_000, sourceRole: "bank", evidenceNote: "Statement at the opening date, closing 5,000.00" },
      ...costAccounts.map((acct, i) => ({ sourceCode: `150${i}`, sourceName: `Fixed assets at cost ${i}`, sourceType: "asset", openingDebit: assets.filter((a) => costAccountOf[a.category] === acct).reduce((s, a) => s + a.cost, 0) })),
      { sourceCode: "1590", sourceName: "Accumulated depreciation", sourceType: "asset", openingCredit: acc },
      { sourceCode: "3200", sourceName: "Retained earnings b/f", sourceType: "equity", openingCredit: 5_000 + cost - acc, sourceRole: "retained_earnings" },
    ];
    await run(() => migrationService.importChart(b.id, { rows } as never, userId));
    const chart = await run(() => migrationService.getChart(b.id));
    const row = (code: string) => chart.rows.find((r) => r.sourceCode === code)!.id;
    await run(() => migrationService.decideChartRow(b.id, row("1100"), { decision: "map_to_bank", targetBankAccountId: bank }, userId));
    for (const [i, acct] of costAccounts.entries()) {
      await run(() => migrationService.decideChartRow(b.id, row(`150${i}`), { decision: "merge_into", targetCategoryId: acct }, userId));
    }
    await run(() => migrationService.decideChartRow(b.id, row("1590"), { decision: "map_to_system", targetSystemCode: "ACCUMULATED_DEPRECIATION" }, userId));
    await run(() => migrationService.decideChartRow(b.id, row("3200"), { decision: "map_to_system", targetSystemCode: "RETAINED_EARNINGS" }, userId));
    await run(() => migrationStagingService.importAssets(b.id, { rows: assets.map((a) => ({ sourceId: a.sourceId, name: `Asset ${a.sourceId}`, categoryName: a.category, acquisitionDate: "2024-01-01", availableForUseDate: "2024-01-01", cost: a.cost, usefulLifeMonths: 48, openingAccumulatedDepreciation: a.acc, openingPeriodsBooked: 12, vatInputTaxAmount: Math.round(a.cost * 15) / 100, vatInitialRecoveryPct: 100 })) }, userId));
    const val = await run(() => migrationValidationService.validate(b.id, userId));
    expect(val.ok, JSON.stringify(val.checks.filter((c) => c.status !== "pass"))).toBe(true);
    await run(() => migrationCommitService.commit(b.id, userId));
    const ids = Object.fromEntries((await q(`SELECT id, source_reference s FROM fixed_assets WHERE migration_batch_id = $1`, [b.id])).map((r) => [r.s, r.id as number]));
    return { batchId: b.id, ids };
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await q(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P1617 Fix','${SLUG}','approved') RETURNING id`))[0].id;
    const company = async (name: string, extra = "") => (await q(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar${extra ? ", ownership_type, foreign_ownership_pct" : ""}) VALUES ($1,$2,1,'gregorian'${extra}) RETURNING id`, [orgId, name]))[0].id as string;
    coA = await company("Fix A"); coB = await company("Fix B"); coM = await company("Fix M"); coF = await company("Fix F", ",'FOREIGN',100");
    orgX = (await q(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P1617 Fix X','${SLUG_X}','approved') RETURNING id`))[0].id;
    coX = (await q(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'Fix X',1,'gregorian') RETURNING id`, [orgX]))[0].id;
    userId = (await q(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P1617F',' ','admin',true) RETURNING id`))[0].id;
    for (const o of [orgId, orgX]) await q(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    bankA = (await inA(() => bankAccountsService.create({ name: "Fix Bank A", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bankB = (await inB(() => bankAccountsService.create({ name: "Fix Bank B", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bankM = (await inM(() => bankAccountsService.create({ name: "Fix Bank M", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bankF = (await inF(() => bankAccountsService.create({ name: "Fix Bank F", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bankX = (await inX(() => bankAccountsService.create({ name: "Fix Bank X", bankName: "Riyad Bank", currency: "SAR" }))).id;
    const vendor = async (name: string, residency: string, type: string | null) =>
      (await q(`INSERT INTO vendors (organization_id, name, residency, wht_default_payment_type, country, foreign_tax_id) VALUES ($1,$2,$3,$4,'GB','GB-FIX') RETURNING id`, [orgId, name, residency, type]))[0].id as number;
    v.nr = await vendor("Fix London Consulting", "non_resident", "technical_consulting");
    v.nrNoDefault = await vendor("Fix Paris Trading", "non_resident", null);
    v.resident = await vendor("Fix Riyadh Supplies", "resident", null);
    v.nrRelief = await vendor("Fix Dubai Licensor", "non_resident", "royalty");
    await fund(inA, coA, bankA, 200_000, "2026-06-01");
    await fund(inB, coB, bankB, 50_000, "2026-06-01");
  }, 180_000);
  afterAll(cleanup);

  // ── WHT-1 ────────────────────────────────────────────────────────────────
  it("🔴 WHT-1 — a 9,500 statement line settles a 10,000 bill of a non-resident (5 %): AP 10,000 · WHT 500 · bank 9,500; the line is reconciled IN FULL to the payment's cash line", async () => {
    const b = await bill(inA, v.nr, 10_000, "2026-07-01");
    const bank0 = await bankGl(bankA);
    const tx = await statementLine(coA, bankA, 9_500, "2026-07-10");
    await inA(() => reconciliationService.settle(tx, { billId: b }, userId));
    const [pay] = await q(`SELECT amount::numeric a, journal_entry_id je FROM bill_payments WHERE bill_id = $1`, [b]);
    const [w] = await q(`SELECT base_amount::numeric b, wht_amount::numeric w, return_period FROM wht_withholdings WHERE bill_id = $1`, [b]);
    expect([n(pay.a), n(w.b), n(w.w), w.return_period]).toEqual([10_000, 10_000, 500, "2026-07"]);
    expect(await owes(b), "the bill is settled — the cash AND the tax").toBe(0);
    expect(n(bank0 - (await bankGl(bankA))), "the bank moved exactly the line").toBe(9_500);
    const link = await q(`SELECT sum(amount)::numeric a FROM bank_line_reconciliation WHERE transaction_id = $1`, [tx]);
    expect(n(link[0].a), "the statement line reconciles IN FULL").toBe(9_500);
    expect(-(await glSys(coA, "WHT_PAYABLE")), "the WHT ledger = the GL (W1)").toBe(n((await q(`SELECT coalesce(sum(wht_amount),0) v FROM wht_withholdings WHERE company_id = $1 AND status = 'withheld'`, [coA]))[0].v));
  }, 120_000);

  it("🔴 WHT-1 — partial and final settlements (4,750 + 4,750 of cash → 5,000 + 5,000 gross), rounding (3,166.70 of cash → 3,333.37 gross), no WHT for a resident (cash = gross)", async () => {
    const b = await bill(inA, v.nr, 10_000, "2026-07-01");
    for (const d of ["2026-07-11", "2026-07-12"]) await inA(async () => reconciliationService.settle(await statementLine(coA, bankA, 4_750, d), { billId: b }, userId));
    expect((await q(`SELECT base_amount::numeric b, wht_amount::numeric w FROM wht_withholdings WHERE bill_id = $1 ORDER BY id`, [b])).map((r) => [n(r.b), n(r.w)])).toEqual([[5_000, 250], [5_000, 250]]);
    expect(await owes(b)).toBe(0);
    const r = await bill(inA, v.nr, 3_333.37, "2026-07-01");
    await inA(async () => reconciliationService.settle(await statementLine(coA, bankA, 3_166.70, "2026-07-13"), { billId: r }, userId));
    expect((await q(`SELECT base_amount::numeric b, wht_amount::numeric w FROM wht_withholdings WHERE bill_id = $1`, [r])).map((x) => [n(x.b), n(x.w)])).toEqual([[3_333.37, 166.67]]);
    const res = await bill(inA, v.resident, 2_000, "2026-07-01");
    const bank0 = await bankGl(bankA);
    await inA(async () => reconciliationService.settle(await statementLine(coA, bankA, 2_000, "2026-07-14"), { billId: res }, userId));
    expect([await owes(res), n(bank0 - (await bankGl(bankA)))]).toEqual([0, 2_000]);
  }, 120_000);

  it("🔴 WHT-1 — refused by name, with NOTHING written: an ambiguous halala, a supplier with no declared nature, a locked month; a backdated line lands in its own month's return", async () => {
    const amb = await bill(inA, v.nr, 5_000, "2026-07-01");
    const noDef = await bill(inA, v.nrNoDefault, 1_000, "2026-07-01");
    const locked = await bill(inA, v.nr, 1_000, "2026-05-01");
    const before = await counts(coA);
    const e1 = await refusal(inA(async () => reconciliationService.settle(await statementLine(coA, bankA, 3_166.63, "2026-07-15"), { billId: amb }, userId)));
    expect([e1.status, e1.code]).toEqual([422, "settlement_wht_gross_ambiguous"]);
    const e2 = await refusal(inA(async () => reconciliationService.settle(await statementLine(coA, bankA, 950, "2026-07-15"), { billId: noDef }, userId)));
    expect([e2.status, e2.code]).toEqual([422, "wht_classification_required"]);
    await inA(() => periodLocksService.lock({ period: "2026-06", userId }));
    const e3 = await refusal(inA(async () => reconciliationService.settle(await statementLine(coA, bankA, 950, "2026-06-20"), { billId: locked }, userId)));
    expect(e3.status).toBe(423);
    await inA(() => periodLocksService.unlock("2026-06"));
    const after = await counts(coA);
    expect([after.je, after.bp, after.ww]).toEqual([before.je, before.bp, before.ww]);
    // backdated (an earlier, unfiled month): the withholding belongs to the line's own month
    const back = await bill(inA, v.nr, 2_000, "2026-05-01");
    await inA(async () => reconciliationService.settle(await statementLine(coA, bankA, 1_900, "2026-05-20"), { billId: back }, userId));
    expect((await q(`SELECT return_period FROM wht_withholdings WHERE bill_id = $1`, [back]))[0].return_period).toBe("2026-05");
  }, 120_000);

  it("🔴 WHT-1 — after the settlements: remit July; the cash, AP, WHT, treasury and cash-flow figures all agree with the ledger; a settled (reconciled) payment's correction is refused by name until the line is un-reconciled", async () => {
    const owedJuly = n((await q(`SELECT coalesce(sum(wht_amount),0) v FROM wht_withholdings WHERE company_id = $1 AND return_period = '2026-07' AND status = 'withheld'`, [coA]))[0].v);
    expect(owedJuly, "500 + 250 + 250 + 166.67").toBe(1_166.67);
    await inA(() => whtService.remit("2026-07", { bankAccountId: bankA, paidAt: "2026-08-05" }, userId));
    const ret = await inA(() => whtService.monthlyReturn("2026-07")) as unknown as { totals: { taxWithheld: number; remitted: number; outstanding: number } };
    expect([ret.totals.taxWithheld, ret.totals.remitted, ret.totals.outstanding]).toEqual([1_166.67, 1_166.67, 0]);
    const live = n((await q(`SELECT coalesce(sum(wht_amount),0) v FROM wht_withholdings WHERE company_id = $1 AND status = 'withheld'`, [coA]))[0].v);
    const remitted = n((await q(`SELECT coalesce(sum(amount),0) v FROM wht_remittances WHERE company_id = $1`, [coA]))[0].v);
    expect(-(await glSys(coA, "WHT_PAYABLE")) + 0).toBe(n(live - remitted) + 0);
    const apOwed = n((await q(`SELECT coalesce(sum(total::numeric - coalesce(paid_amount,0)),0) v FROM bills WHERE company_id = $1 AND status NOT IN ('draft','submitted')`, [coA]))[0].v);
    expect(-(await glSys(coA, "AP")), "AP control = what the bills owe").toBe(apOwed);
    const cash = await bankGl(bankA);
    const pos = await inA(() => treasuryService.position()) as unknown as { totalCash: number };
    const cf = await inA(() => reportsService.cashFlow("2026-01-01", "2026-12-31")) as unknown as { closingCash: number };
    expect([n(pos.totalCash), n(cf.closingCash)]).toEqual([cash, cash]);
    const [w] = await q(`SELECT w.id FROM wht_withholdings w JOIN bills b ON b.id = w.bill_id WHERE w.company_id = $1 AND w.base_amount = 10000 ORDER BY w.id LIMIT 1`, [coA]);
    const e = await refusal(inA(() => whtCorrectionService.correct(w.id, { reason: "the settled payment was for another bill", date: "2026-08-10" }, userId)));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/reconcil/i);
  }, 120_000);

  // ── WHT-2 ────────────────────────────────────────────────────────────────
  it("🔴 WHT-2 — an expense to a non-resident (a declared nature, no nature, an approved relief) is refused by name with nothing written; a resident's expense posts and pays as before", async () => {
    const expense = (vendorId: number) => inA(() => billsService.create({
      date: "2026-08-03", vendorId, vendorReference: `EXP-${++seq}`, supplierDocumentKind: "tax_invoice",
      subtotal: 1_000, vatAmount: 0, total: 1_000, items: [],
      recordedAsExpense: true, expensePaidFromBankAccountId: bankA, expensePaidAt: "2026-08-03",
    }, userId)) as Promise<{ id: number }>;
    await inA(() => whtService.createRelief({ vendorId: v.nrRelief, paymentType: "royalty", reducedRate: 0.05, treatyCountry: "AE", zatcaApprovalReference: "Z-FIX-1", residencyCertificateReference: "R-FIX-1", validFrom: "2026-01-01", validTo: "2026-12-31" }, userId))
      .then((r) => inA(() => whtService.approveRelief((r as { id: number }).id, userId)));
    for (const vendorId of [v.nr, v.nrNoDefault, v.nrRelief]) {
      const d = await expense(vendorId);
      const before = await counts(coA);
      const e = await refusal(inA(() => billsService.approve(d.id, {}, userId)));
      expect([e.status, e.code], `vendor ${vendorId}`).toEqual([422, "expense_wht_requires_bill_payment"]);
      expect(await counts(coA)).toEqual(before);
      expect((await q(`SELECT status FROM bills WHERE id = $1`, [d.id]))[0].status).not.toBe("approved");
    }
    const ok = await expense(v.resident);
    await inA(() => billsService.approve(ok.id, {}, userId));
    expect([(await q(`SELECT status FROM bills WHERE id = $1`, [ok.id]))[0].status, await owes(ok.id)]).toEqual(["paid", 0]);
  }, 120_000);

  // ── SEC-4 ────────────────────────────────────────────────────────────────
  it("🔴 SEC-4 — a filing replayed with its reference is the SAME filing (no amendment); the same reference on another date is refused; concurrent replays land once; a genuine amendment is recorded", async () => {
    const filings = async () => (await q(`SELECT kind, zatca_reference r FROM wht_return_filings WHERE company_id = $1 AND period = '2026-07' ORDER BY id`, [coA])).map((x) => [x.kind, x.r]);
    const [r1, r2] = await Promise.allSettled([
      inA(() => whtService.fileReturn("2026-07", { filedOn: "2026-08-10", zatcaReference: "ZATCA-FIX-1" }, userId)),
      inA(() => whtService.fileReturn("2026-07", { filedOn: "2026-08-10", zatcaReference: "ZATCA-FIX-1" }, userId)),
    ]);
    expect([r1.status, r2.status].filter((s) => s === "fulfilled").length, "one of two concurrent filings lands").toBeGreaterThanOrEqual(1);
    expect(await filings()).toEqual([["original", "ZATCA-FIX-1"]]);
    await inA(() => whtService.fileReturn("2026-07", { filedOn: "2026-08-10", zatcaReference: "ZATCA-FIX-1" }, userId));
    expect(await filings(), "an exact replay writes nothing").toEqual([["original", "ZATCA-FIX-1"]]);
    const e = await refusal(inA(() => whtService.fileReturn("2026-07", { filedOn: "2026-08-12", zatcaReference: "ZATCA-FIX-1" }, userId)));
    expect([e.status, e.code]).toEqual([409, "wht_filing_reference_reused"]);
    await inA(() => whtService.fileReturn("2026-07", { filedOn: "2026-08-20", zatcaReference: "ZATCA-FIX-2" }, userId));
    expect(await filings()).toEqual([["original", "ZATCA-FIX-1"], ["amendment", "ZATCA-FIX-2"]]);
    // the database holds the rule for any path
    const latest = (await q(`SELECT max(id) id FROM wht_return_filings WHERE company_id = $1 AND period = '2026-07'`, [coA]))[0].id;
    const raw = await refusal(asApp(orgId, coA, (c) => c.query(`INSERT INTO wht_return_filings (organization_id, company_id, period, kind, amends_filing_id, filed_on, zatca_reference, tax_withheld, payment_total, created_by) VALUES ($1,$2,'2026-07','amendment',$4,'2026-08-21','ZATCA-FIX-2',0,0,$3)`, [orgId, coA, userId, latest])));
    expect(raw.constraint ?? raw.pg).toMatch(/wht_return_filings_reference_unq|23505/);
  }, 120_000);

  // ── TR-1 (API half) ──────────────────────────────────────────────────────
  it("🔴 TR-1 — a plan paid into the FILED July with its stated treatment is paid (the API always took it; the dialog now sends it)", async () => {
    const b = await bill(inA, v.nr, 1_000, "2026-07-01");
    const p = await inA(() => paymentPlansService.create({ billId: b, amount: 1_000, plannedDate: addDays(businessToday(), 30), bankAccountId: bankA }, userId)) as { id: number };
    await inA(() => paymentPlansService.approve(p.id, userId));
    const e = await refusal(inA(() => paymentPlansService.pay(p.id, { paidAt: "2026-07-25" }, userId)));
    expect(e.code, "without the treatment: the filed month is never changed silently").toBe("wht_month_filed");
    const paid = await inA(() => paymentPlansService.pay(p.id, { paidAt: "2026-07-25", whtFiledMonthTreatment: "subsequent_period" }, userId)) as { payment: { withheld: number; cashPaid: number } };
    expect([paid.payment.withheld, paid.payment.cashPaid]).toEqual([50, 950]);
    expect((await q(`SELECT filed_month_treatment t, return_period r FROM wht_withholdings WHERE bill_id = $1`, [b]))[0].t).toBe("subsequent_period");
  }, 120_000);

  // ── SEC-1 ────────────────────────────────────────────────────────────────
  it("🔴 SEC-1 — the WHT return functions answer ONLY inside the caller's tenant: A sees its own; B (same org) and X (another org) read 0; NULL reads nothing; a malformed id is an error", async () => {
    const fn = (c: PoolClient, co: unknown) => c.query(`SELECT wht_return_tax($1::uuid, '2026-07')::text t, wht_return_base($1::uuid, '2026-07')::text b, wht_unremitted($1::uuid, '2026-07')::text u, wht_unremitted($1::uuid, NULL)::text o`, [co]).then((r) => r.rows[0]);
    const own = await asApp(orgId, coA, (c) => fn(c, coA));
    expect(Number(own.t), "the company reads its own return").toBeGreaterThan(0);
    for (const [org, co] of [[orgId, coB], [orgX, coX]] as const) {
      expect(await asApp(org, co, (c) => fn(c, coA)), `${co} asks for A`).toEqual({ t: "0", b: "0", u: "0", o: "0" });
      expect(await asApp(org, co, (c) => fn(c, coA)), "repeated: still nothing").toEqual({ t: "0", b: "0", u: "0", o: "0" });
    }
    expect(await asApp(orgId, coA, (c) => fn(c, null))).toEqual({ t: "0", b: "0", u: "0", o: "0" });
    expect((await refusal(asApp(orgId, coA, (c) => fn(c, "not-a-uuid")))).pg).toBe("22P02");
    // the app's own reads still see its own month: May owes the backdated settlement's 100 — over-remitting it is refused,
    // the exact amount is admitted (the remittance's definer trigger calls wht_unremitted as the owner), and May then owes 0
    const over = await refusal(inA(() => whtService.remit("2026-05", { bankAccountId: bankA, paidAt: "2026-09-01", amount: 999_999 }, userId)));
    expect([over.status, over.code]).toEqual([409, "wht_remittance_exceeds"]);
    await inA(() => whtService.remit("2026-05", { bankAccountId: bankA, paidAt: "2026-09-01", amount: 100 }, userId));
    expect((await refusal(inA(() => whtService.remit("2026-05", { bankAccountId: bankA, paidAt: "2026-09-01" }, userId)))).code).toBe("wht_nothing_to_remit");
  }, 60_000);

  // ── MG-2 ────────────────────────────────────────────────────────────────
  it("🔴 MG-2 — after a migration reversal, the generic reverse refuses the opening journal, its mirror and a depreciation mirror (service AND database), repeatedly and concurrently; a normal journal still reverses; the books do not move", async () => {
    const cat = (await inM(() => assetsService.createCategory({ name: "Machinery", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId))).id;
    const { batchId, ids } = await migrate(inM, bankM, { Machinery: cat }, [{ sourceId: "FA-1", cost: 24_000, acc: 6_000, category: "Machinery" }], "2026-07-01");
    await inM(() => assetCapitalisationService.depreciate(ids["FA-1"]!, { period: "2026-07" }, userId));
    await inM(() => migrationCommitService.reverse(batchId, { reason: "the opening position was loaded twice" }, userId));
    const [batch] = await q(`SELECT opening_journal_entry_id o, reversal_journal_entry_id r FROM migration_batches WHERE id = $1`, [batchId]);
    const [depMirror] = await q(`SELECT r.id FROM journal_entries r JOIN asset_depreciation_schedule s ON s.journal_entry_id = r.reversal_of WHERE s.asset_id = $1`, [ids["FA-1"]]);
    const fixedNet = async () => n((await q(`SELECT coalesce(sum(l.debit_amount - l.credit_amount),0) v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN asset_categories k ON l.account_id IN (k.cost_account_id, k.accumulated_depreciation_account_id) WHERE k.id = $1 AND e.company_id = $2 AND e.status IN ('posted','reversed')`, [cat, coM]))[0].v);
    const before = { fixed: await fixedNet(), je: (await counts(coM)).je, bank: await bankGl(bankM) };
    expect(before.fixed).toBe(0);
    const tries: Array<[number, string]> = [[batch.o, "journal_migration_owned"], [batch.r, "journal_mirror_not_reversible"], [depMirror.id, "journal_mirror_not_reversible"]];
    for (const [id, code] of tries) {
      for (let i = 0; i < 2; i++) expect((await refusal(inM(() => journalEntriesService.reverse(id, { reason: "try" })))).code, `${id} #${i}`).toBe(code);
    }
    const conc = await Promise.allSettled([inM(() => journalEntriesService.reverse(batch.r, { reason: "a" })), inM(() => journalEntriesService.reverse(batch.r, { reason: "b" }))]);
    expect(conc.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect({ fixed: await fixedNet(), je: (await counts(coM)).je, bank: await bankGl(bankM) }, "nothing moved").toEqual(before);
    expect((await q(`SELECT status FROM fixed_assets WHERE id = $1`, [ids["FA-1"]]))[0].status).toBe("reversed");
    expect((await q(`SELECT status FROM migration_batches WHERE id = $1`, [batchId]))[0].status).toBe("reversed");
    // the DATABASE refuses the same mirrors from any path (as the app role, a raw insert)
    const mirrorOf = (target: number, source: string | null) => asApp(orgId, coM, (c) => c.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, reversal_of, source) VALUES ($1,$2,$3,'2026-10-01','raw','posted',$4,$5)`, [orgId, coM, `RAW-${++seq}`, target, source]));
    expect((await refusal(mirrorOf(batch.r, null))).constraint).toBe("journal_mirror_not_reversible");
    expect((await refusal(mirrorOf(depMirror.id, null))).constraint).toBe("journal_mirror_not_reversible");
    expect((await refusal(mirrorOf(batch.o, null))).constraint).toBe("journal_migration_owned");
    // another tenant's entry and a missing one answer the SAME refusal (no oracle)
    const foreign = (await q(`SELECT id FROM journal_entries WHERE company_id = $1 LIMIT 1`, [coA]))[0].id;
    expect((await refusal(mirrorOf(foreign, null))).constraint).toBe("journal_reversal_tenant");
    expect((await refusal(mirrorOf(2_000_000_000, null))).constraint).toBe("journal_reversal_tenant");
    // a NORMAL journal still reverses through the generic path
    const leaf = (await q(`SELECT id FROM categories WHERE bank_account_id = $1`, [bankM]))[0].id;
    const re = (await q(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'RETAINED_EARNINGS'`, [orgId]))[0].id;
    const je = await inM(async () => { const e = (await journalEntriesService.create({ entryNumber: `FX-N-${++seq}`, date: "2026-09-01", description: "normal", lines: [{ accountId: leaf, debitAmount: 100, creditAmount: 0 }, { accountId: re, debitAmount: 0, creditAmount: 100 }] }, userId)) as { id: number }; await journalEntriesService.approve(e.id, userId); return e.id; });
    const out = await inM(() => journalEntriesService.reverse(je, { reason: "normal reverse" }));
    expect(out.reversalId).toBeGreaterThan(0);
  }, 180_000);

  // ── MG-1 ────────────────────────────────────────────────────────────────
  it("🔴 MG-1 — a depreciation arriving while a reversal holds the asset WAITS and is then refused; a reversal arriving while a depreciation holds the asset WAITS and then mirrors it — never a reversed asset with an unmirrored charge", async () => {
    const coN = (await q(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'Fix N',1,'gregorian') RETURNING id`, [orgId]))[0].id as string;
    const inN = tenant(() => orgId, () => coN);
    const bankN = (await inN(() => bankAccountsService.create({ name: "Fix Bank N", bankName: "Riyad Bank", currency: "SAR" }))).id;
    const cat = (await inN(() => assetsService.createCategory({ name: "Machinery", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId))).id;
    const { batchId, ids } = await migrate(inN, bankN, { Machinery: cat }, [{ sourceId: "FA-1", cost: 24_000, acc: 6_000, category: "Machinery" }], "2026-07-01");
    const asset = ids["FA-1"]!;
    await inN(() => assetCapitalisationService.depreciate(asset, { period: "2026-07" }, userId));
    const unmirrored = async () => (await q(`SELECT s.period FROM asset_depreciation_schedule s JOIN journal_entries e ON e.id = s.journal_entry_id WHERE s.asset_id = $1 AND e.status = 'posted'`, [asset])).map((r) => r.period);
    const pending = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => "done", () => "done"), new Promise((r) => setTimeout(() => r("waiting"), ms))]);

    // (1) a REAL depreciation of August, written but not yet committed (its trigger holds the asset FOR SHARE) → the
    //     REVERSAL waits BEFORE it reads what was depreciated, then sees and mirrors August too. Without the reversal's
    //     up-front lock it would read July only, wait at its final update, and leave August unmirrored.
    const dep1 = await beginTenantConnection({ organizationId: orgId, companyId: coN, role: "authenticated" });
    let reversal: Promise<unknown>;
    try {
      await dep1.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, () => assetCapitalisationService.depreciate(asset, { period: "2026-08" }, userId)));
      reversal = inN(() => migrationCommitService.reverse(batchId, { reason: "the opening position was wrong" }, userId));
      expect(await pending(reversal, 2_500), "the reversal waits for the posting that holds the asset").toBe("waiting");
      await dep1.commit();
    } catch (err) { await dep1.rollback(); throw err; }
    await reversal!;
    expect([(await q(`SELECT status FROM fixed_assets WHERE id = $1`, [asset]))[0].status, await unmirrored()], "July AND August mirrored").toEqual(["reversed", []]);
    expect((await q(`SELECT count(*)::int n FROM asset_depreciation_schedule s JOIN journal_entries e ON e.id = s.journal_entry_id WHERE s.asset_id = $1 AND e.status = 'reversed'`, [asset]))[0].n).toBe(2);

    // (2) a reversal holds a (second) asset FOR UPDATE, as `reverse` now does first → a DEPRECIATION waits, then is refused
    const cat2 = (await inX(() => assetsService.createCategory({ name: "Machinery", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId))).id;
    const second = await migrate(inX, bankX, { Machinery: cat2 }, [{ sourceId: "FA-9", cost: 12_000, acc: 3_000, category: "Machinery" }], "2026-07-01");
    const a2 = second.ids["FA-9"]!;
    const t2 = await pool.connect();
    let dep: Promise<unknown>;
    try {
      await t2.query("BEGIN");
      await t2.query(`SELECT id FROM fixed_assets WHERE id = $1 FOR UPDATE`, [a2]);
      await t2.query(`UPDATE fixed_assets SET status = 'reversed', reversed_at = now(), reversed_by_migration_batch_id = $2 WHERE id = $1`, [a2, second.batchId]);
      dep = inX(() => assetCapitalisationService.depreciate(a2, { period: "2026-07" }, userId));
      expect(await pending(dep, 2_500), "the depreciation waits for the reversal that holds the asset").toBe("waiting");
      await t2.query("COMMIT");
    } finally { t2.release(); }
    let raw: unknown = null;
    try { await dep!; } catch (err) { raw = err; }
    expect(translateDbRefusal(raw), "answered 409 by name at the HTTP layer, never a 500").toMatchObject({ status: 409, body: { code: "depreciation_asset_out_of_books" } });
    expect((await q(`SELECT count(*)::int n FROM asset_depreciation_schedule WHERE asset_id = $1 AND journal_entry_id IS NOT NULL`, [a2]))[0].n, "nothing posted").toBe(0);
  }, 180_000);

  // ── IT-1 ────────────────────────────────────────────────────────────────
  it("🔴 IT-1 — income tax adds back the REGISTER's depreciation wherever it posted (system account, a category's own account, a disposed asset's run) — never an unrelated expense on that account, and nothing for a reversed asset", async () => {
    // a category with its OWN expense account (the category API accepts any expense account)
    // a person's OWN expense account (created through the chart's create path), chosen as the category's depreciation account
    const ownExp = (await inF(() => categoriesService.create({ name: "Fix machinery depreciation", nameAr: "إهلاك الآلات", type: "expense", vatApplicable: false } as never)) as { id: number }).id;
    const sysCat = (await inF(() => assetsService.createCategory({ name: "Vehicles", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId))).id;
    const ownCat = (await inF(() => assetsService.createCategory({ name: "Machinery", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable", depreciationExpenseAccountId: ownExp }, userId))).id;
    expect((await q(`SELECT depreciation_expense_account_id d FROM asset_categories WHERE id = $1`, [ownCat]))[0].d).toBe(ownExp);
    // 1st migration (cutover 2025-01-01): asset R on the own account, depreciated Jan–Feb, then REVERSED (mirrored on its dates)
    const m1 = await migrate(inF, bankF, { Machinery: ownCat }, [{ sourceId: "R", cost: 12_000, acc: 3_000, category: "Machinery" }], "2025-01-01");
    for (const p of ["2025-01", "2025-02"]) await inF(() => assetCapitalisationService.runPeriod({ period: p }, userId));
    await inF(() => migrationCommitService.reverse(m1.batchId, { reason: "withdrawn — the asset was not ours" }, userId));
    // the replacement (same opening date): Y on the own account, Z on the system account; Jan–Mar; Y disposed in March
    const m2 = await migrate(inF, bankF, { Machinery: ownCat, Vehicles: sysCat }, [{ sourceId: "Y", cost: 24_000, acc: 6_000, category: "Machinery" }, { sourceId: "Z", cost: 36_000, acc: 9_000, category: "Vehicles" }], "2025-01-01");
    for (const p of ["2025-01", "2025-02"]) await inF(() => assetCapitalisationService.runPeriod({ period: p }, userId));
    await inF(() => assetDisposalService.dispose(m2.ids["Y"]!, { date: "2025-03-15", kind: "scrapped", reason: "Motor burnt out, scrapped" }, userId));
    await inF(() => assetCapitalisationService.runPeriod({ period: "2025-03" }, userId));
    // an UNRELATED expense on the own account — not depreciation, never added back
    const leaf = (await q(`SELECT id FROM categories WHERE bank_account_id = $1`, [bankF]))[0].id;
    await inF(async () => { const e = (await journalEntriesService.create({ entryNumber: `FX-UNREL-${++seq}`, date: "2025-04-01", description: "repairs coded to the depreciation account", lines: [{ accountId: ownExp, debitAmount: 777, creditAmount: 0 }, { accountId: leaf, debitAmount: 0, creditAmount: 777 }] }, userId)) as { id: number }; await journalEntriesService.approve(e.id, userId); });
    // expected, from the schedule rows the register posted (independent of the code under test)
    const sched = async (asset: number) => n((await q(`SELECT coalesce(sum(s.amount),0) v FROM asset_depreciation_schedule s JOIN journal_entries e ON e.id = s.journal_entry_id WHERE s.asset_id = $1 AND e.date BETWEEN '2025-01-01' AND '2025-12-31'`, [asset]))[0].v);
    const ownExpected = await sched(m2.ids["Y"]!), sysExpected = await sched(m2.ids["Z"]!);
    expect(ownExpected).toBeGreaterThan(0); expect(sysExpected).toBeGreaterThan(0);
    expect(await inF(() => taxRepository.registerDepreciationOffSystemAccount("2025-01-01", "2025-12-31")), "Y only: R nets to zero, Z is the system account's, the 777 is not depreciation").toBe(ownExpected);
    // the computation: the add-back = the system account's movement + Y's, exactly
    await inF(async () => { const e = (await journalEntriesService.create({ entryNumber: `FX-REV-${++seq}`, date: "2025-06-30", description: "service income", lines: [{ accountId: leaf, debitAmount: 100_000, creditAmount: 0 }, { accountId: (await q(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'SALES'`, [orgId]))[0].id, debitAmount: 0, creditAmount: 100_000 }] }, userId)) as { id: number }; await journalEntriesService.approve(e.id, userId); });
    for (const g of [1, 2, 3, 4, 5]) await inF(() => incomeTaxPoolService.declare({ incomeTaxGroup: g, taxYear: 2024, closingBalanceDeclared: 0, additionsDeclared: 0, disposalsDeclared: 0 }, userId));
    const c = await inF(() => taxComputationsService.create({ kind: "income_tax", fiscalYearLabel: 2025 }, userId));
    const it = c.live!.incomeTax as unknown as { bookDepreciationAddBack: number };
    expect(it.bookDepreciationAddBack).toBe(n(sysExpected + ownExpected));
  }, 300_000);
});
