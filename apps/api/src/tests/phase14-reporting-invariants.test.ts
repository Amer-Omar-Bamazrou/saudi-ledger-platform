/**
 * PHASE 14 — THE REPORTING INVARIANTS, ON REAL ROWS (decision pack §4).
 *
 * Every figure below is computed from books the PRODUCT wrote: invoices and
 * bills approved through their services, payments through `pay`, manual
 * journals through `journalEntriesService` — nothing is inserted into the
 * ledger tables directly (standing rule 2). The amounts are chosen so no two
 * figures can be confused (CLAUDE.md §3: when the correct answer equals the
 * broken one, the test proves nothing).
 *
 * Company A (fiscal year declared, January, Gregorian):
 *   2025-12-15  manual   Dr Bank1 500      / Cr Sales 500        (prior-year revenue)
 *   2026-01-02  manual   Dr Bank1 50,000   / Cr Owner capital    (financing)
 *   2026-02-01  manual   Dr Equipment 10,000 / Cr Bank1          (investing)
 *   2026-03-10  INV-1    1,000 + 150 VAT = 1,150, paid 2026-04-05 to Bank1
 *   2026-03-20  BILL-1   2,000 + 300 VAT = 2,300, 1,150 paid 2026-05-01 from Bank1
 *   2026-06-01  manual   Dr Bank2 3,000    / Cr Bank1            (own transfer — not a flow)
 *   2026-06-15  manual   Dr VAT payable 100 / Cr Bank1           (VAT paid — operating/taxes)
 *   2026-07-15  INV-2    2,000 + 300 VAT = 2,300, unpaid, due 2026-08-14
 * Company B (same org): INV-B 9,000 + 1,350 = 10,350, paid 2026-04-05.
 * Org C: Dr Bank 4,444 / Cr Sales 4,444 on 2026-03-01.
 *
 * Invariants: A (TB), B (BS), C (P&L ↔ ledger), D (BS current-year profit =
 * P&L), E (GL ↔ TB), F/G (AR/AP ageing as of a date ↔ GL), H (cash flow
 * reconciles), K (party dimension), L (company + tenant isolation), F-11
 * (owner equity closes on the balance sheet), date boundaries, refusals, and
 * exports that carry exactly the screen's figures. (I — fixed assets — is
 * `fixed-assets-report.test.ts`; J — held VAT never on the return — is the
 * Phase 13A / 13B suites.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool, db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { reportsRepository } from "../repositories/reports.repository";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { reportsService } from "../services/reports.service";
import { analyticsService } from "../services/analytics.service";
import { buildReportDocument, exportReport } from "../services/reporting/reportExport.service";
import { RendererUnavailableError } from "../services/document/htmlToPdf";
import { purgeInputVatLedger } from "./helpers/purgeInputVatLedger";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase14-reporting-invariants] no real DATABASE_URL — skipping.");

const SLUG = "p14-reporting";
const SLUG_C = "p14-reporting-c";
const EMAIL = "p14-reporting@test.local";
const FY = { from: "2026-01-01", to: "2026-09-30" };

describeMaybe("Phase 14 — reporting invariants on real rows", () => {
  let orgId = "", orgC = "", coA = "", coB = "", coC = "";
  let userId = 0;
  const ids: Record<string, number> = {};

  const inCo = async <T,>(org: string, co: string, fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const inA = <T,>(fn: () => Promise<T>) => inCo(orgId, coA, fn);
  const inB = <T,>(fn: () => Promise<T>) => inCo(orgId, coB, fn);
  const inC = <T,>(fn: () => Promise<T>) => inCo(orgC, coC, fn);

  const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG}','${SLUG_C}'))`;
  const cleanup = async () => {
    await purgeInputVatLedger(`SELECT id FROM organizations WHERE slug IN ('${SLUG}','${SLUG_C}')`);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${ORGS})`);
      await c.query(`DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id IN ${ORGS})`);
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM organizations WHERE slug IN ('${SLUG}','${SLUG_C}')`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };

  const catId = async (org: string, code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [org, code])).rows[0].id as number;
  const bankLeaf = async (bankId: number) => (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [bankId])).rows[0].id as number;
  const manual = async (inX: <T>(fn: () => Promise<T>) => Promise<T>, entryNumber: string, date: string, lines: [number, number, number][]) => {
    const je = await inX(() => journalEntriesService.create({ entryNumber, date, description: entryNumber, lines: lines.map(([accountId, debitAmount, creditAmount]) => ({ accountId, debitAmount, creditAmount })) }, userId)) as { id: number };
    await inX(() => journalEntriesService.approve(je.id, userId));
    return je.id;
  };
  const newBank = async (org: string, co: string, name: string) =>
    (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,$3,'SNB') RETURNING id`, [org, co, name])).rows[0].id as number;

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P14 Org','${SLUG}','approved') RETURNING id`)).rows[0].id;
    coA = (await pool.query(`INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'P14 Co A','شركة أ','1010440001','300000000000043',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
    await new Promise((r) => setTimeout(r, 20));
    coB = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'P14 Co B','1010440002','300000000000053',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
    orgC = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P14 Org C','${SLUG_C}','approved') RETURNING id`)).rows[0].id;
    coC = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P14 Co C',1,'gregorian') RETURNING id`, [orgC])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P14',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active'), ($1,$3,'admin','active')`, [userId, orgId, orgC]);

    // ── company A ─────────────────────────────────────────────────────────
    ids.bank1 = await newBank(orgId, coA, "A Main");
    ids.bank2 = await newBank(orgId, coA, "A Reserve");
    const bank1Leaf = await bankLeaf(ids.bank1), bank2Leaf = await bankLeaf(ids.bank2);
    ids.bank1Leaf = bank1Leaf; ids.bank2Leaf = bank2Leaf;
    ids.sales = await catId(orgId, "SALES");
    ids.vatOut = await catId(orgId, "VAT_OUTPUT");
    ids.ar = await catId(orgId, "AR");
    ids.ap = await catId(orgId, "AP");
    ids.capital = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, is_posting) VALUES ($1,'Owner capital','رأس المال','equity',true) RETURNING id`, [orgId])).rows[0].id;
    ids.equipment = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, liquidity_class, is_posting) VALUES ($1,'Equipment','معدات','asset','non_current',true) RETURNING id`, [orgId])).rows[0].id;
    ids.customer = (await pool.query(`INSERT INTO customers (organization_id, name, name_ar, tax_number) VALUES ($1,'Client One','العميل الأول','300000000000063') RETURNING id`, [orgId])).rows[0].id;
    ids.vendor = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'Supplier One','300000000000073') RETURNING id`, [orgId])).rows[0].id;

    await manual(inA, "P14-PRIOR", "2025-12-15", [[bank1Leaf, 500, 0], [ids.sales, 0, 500]]);
    await manual(inA, "P14-CAPITAL", "2026-01-02", [[bank1Leaf, 50000, 0], [ids.capital, 0, 50000]]);
    await manual(inA, "P14-EQUIP", "2026-02-01", [[ids.equipment, 10000, 0], [bank1Leaf, 0, 10000]]);
    const inv1 = await inA(() => invoicesService.create({ invoiceNumber: "P14-INV-1", date: "2026-03-10", dueDate: "2026-03-25", customerId: ids.customer, items: [{ description: "Service", quantity: 1, unitPrice: 1000, vatRate: 15 }] }, userId)) as { id: number };
    await inA(() => invoicesService.approve(inv1.id, userId));
    await inA(() => invoicesService.pay(inv1.id, { amount: 1150, paidAt: "2026-04-05", bankAccountId: ids.bank1 }, userId));
    const bill1 = await inA(() => billsService.create({ billNumber: "P14-BILL-1", date: "2026-03-20", dueDate: "2026-04-19", vendorId: ids.vendor, vendorReference: "SUP-P14-1", supplierDocumentKind: "tax_invoice", items: [{ description: "Goods", quantity: 1, unitPrice: 2000, vatRate: 15 }] }, userId)) as { id: number };
    await inA(() => billsService.approve(bill1.id, {}, userId));
    await inA(() => billsService.pay(bill1.id, { amount: 1150, paidAt: "2026-05-01", bankAccountId: ids.bank1 }, userId));
    await manual(inA, "P14-XFER", "2026-06-01", [[bank2Leaf, 3000, 0], [bank1Leaf, 0, 3000]]);
    await manual(inA, "P14-VATPAY", "2026-06-15", [[ids.vatOut, 100, 0], [bank1Leaf, 0, 100]]);
    const inv2 = await inA(() => invoicesService.create({ invoiceNumber: "P14-INV-2", date: "2026-07-15", dueDate: "2026-08-14", customerId: ids.customer, items: [{ description: "Service", quantity: 2, unitPrice: 1000, vatRate: 15 }] }, userId)) as { id: number };
    await inA(() => invoicesService.approve(inv2.id, userId));
    ids.inv1 = inv1.id; ids.inv2 = inv2.id; ids.bill1 = bill1.id;

    // ── company B (same org) ─────────────────────────────────────────────
    ids.bankB = await newBank(orgId, coB, "B Main");
    const custB = (await pool.query(`INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'Client B','300000000000083') RETURNING id`, [orgId])).rows[0].id;
    const invB = await inB(() => invoicesService.create({ invoiceNumber: "P14-INV-B", date: "2026-03-10", dueDate: "2026-03-25", customerId: custB, items: [{ description: "B work", quantity: 1, unitPrice: 9000, vatRate: 15 }] }, userId)) as { id: number };
    await inB(() => invoicesService.approve(invB.id, userId));
    await inB(() => invoicesService.pay(invB.id, { amount: 10350, paidAt: "2026-04-05", bankAccountId: ids.bankB }, userId));

    // ── org C ──────────────────────────────────────────────────────────────
    ids.bankC = await newBank(orgC, coC, "C Main");
    await manual(inC, "P14-C-SALE", "2026-03-01", [[await bankLeaf(ids.bankC), 4444, 0], [await catId(orgC, "SALES"), 0, 4444]]);
  }, 240_000);
  afterAll(async () => { await cleanup(); });

  // ════════════════════════════════════════════════════════════════════════
  it("🔴 A — the trial balance: Σ debit = Σ credit; Σ opening = Σ closing = 0; every row rolls; P&L opens at the fiscal-year start with the prior year as ONE computed row", async () => {
    const tb = await inA(() => reportsService.trialBalance(FY.from, FY.to));
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.totalDebit).toBeGreaterThan(0);
    expect([tb.totalOpening, tb.totalClosing]).toEqual([0, 0]);
    for (const r of tb.accounts) expect(Math.round((r.openingBalance + r.debit - r.credit) * 100) / 100, r.name).toBe(r.closingBalance);
    expect(tb.plResetFrom).toBe("2026-01-01");
    const sales = tb.accounts.find((r) => r.accountId === ids.sales)!;
    expect(sales.openingBalance, "Sales opens at 0 — the 2025 revenue is not this year's").toBe(0);
    expect(sales.credit).toBe(3000); // INV-1 1,000 + INV-2 2,000
    const prior = tb.accounts.find((r) => r.computed)!;
    expect([prior.key, prior.openingBalance, prior.closingBalance]).toEqual(["pl_prior_years", -500, -500]);
    // the bank's opening is the 2025 receipt
    expect(tb.accounts.find((r) => r.accountId === ids.bank1Leaf)!.openingBalance).toBe(500);
  });

  it("🔴 B + D — the balance sheet balances EXACTLY, and its current-fiscal-year profit IS the P&L for the year to date (prior years apart)", async () => {
    const bs = await inA(() => reportsService.balanceSheet(FY.to));
    expect(bs.balanced).toBe(true);
    expect(bs.assets.total).toBe(bs.totalLiabilitiesAndEquity);
    expect(bs.unmapped).toEqual([]);
    const is = await inA(() => reportsService.incomeStatement(FY.from, FY.to));
    expect(is.netIncome).toBe(1000); // 3,000 revenue − 2,000 purchases
    expect(bs.equity.currentYearProfit).toBe(is.netIncome);
    expect(bs.equity.priorYearsProfit).toBe(500);
    expect(bs.equity.retainedEarnings).toBe(1500);
    expect(bs.equity.fiscalYear).toMatchObject({ startDate: "2026-01-01", endDate: "2026-12-31" });
    // the classified groups partition the totals (IAS 1.60)
    expect(Math.round((bs.assets.current.total + bs.assets.nonCurrent.total + bs.assets.unclassified.total) * 100) / 100).toBe(bs.assets.total);
    expect(bs.assets.nonCurrent.items.find((i) => i.key === String(ids.equipment))?.amount).toBe(10000);
    expect(bs.assets.accountsReceivableKey).toBe(String(ids.ar));
    // the SIDES, not only their equality: a liability counted as a negative asset
    // still "balances" (A − L = E), so the totals themselves are pinned.
    // assets = cash 40,400 + equipment 10,000 + AR 2,300 + input VAT 300;
    // liabilities = AP 1,150 + output VAT (450 − 100 paid) 350;
    // equity = capital 50,000 + retained 1,500.
    expect([bs.assets.total, bs.liabilities.total, bs.equity.total]).toEqual([53000, 1500, 51500]);
    expect(bs.liabilities.accountsPayable).toBe(1150);
  });

  it("🔴 C — the P&L is the ledger: its totals equal the trial balance's income and expense movement for the window; no gross profit (by nature); one source", async () => {
    const [is, tb] = await Promise.all([inA(() => reportsService.incomeStatement(FY.from, FY.to)), inA(() => reportsService.trialBalance(FY.from, FY.to))]);
    const incomeMoved = tb.accounts.filter((r) => r.type === "income" || r.type === "revenue").reduce((s, r) => s + r.credit - r.debit, 0);
    const expenseMoved = tb.accounts.filter((r) => r.type === "expense").reduce((s, r) => s + r.debit - r.credit, 0);
    expect(is.totalRevenue).toBe(Math.round(incomeMoved * 100) / 100);
    expect(is.totalExpenses).toBe(Math.round(expenseMoved * 100) / 100);
    expect([is.grossProfit, is.expenseAnalysis, is.source]).toEqual([null, "nature", "journal_entries"]);
  });

  it("🔴 D-boundary — dates are inclusive and exact: the day before an invoice excludes it, its own day includes it; the balance sheet the day before a payment still holds the receivable", async () => {
    const before = await inA(() => reportsService.incomeStatement("2026-03-01", "2026-03-09"));
    const on = await inA(() => reportsService.incomeStatement("2026-03-01", "2026-03-10"));
    expect([before.totalRevenue, on.totalRevenue]).toEqual([0, 1000]);
    const bsBefore = await inA(() => reportsService.balanceSheet("2026-04-04"));
    const bsOn = await inA(() => reportsService.balanceSheet("2026-04-05"));
    expect([bsBefore.assets.accountsReceivable, bsOn.assets.accountsReceivable]).toEqual([1150, 0]);
  });

  it("🔴 E — the general ledger: opening + movements = closing, and it agrees with the trial balance for the account and in total", async () => {
    const tb = await inA(() => reportsService.trialBalance(FY.from, FY.to));
    const gl = await inA(() => reportsService.generalLedger(String(ids.bank1Leaf), undefined, FY.from, FY.to));
    const tbRow = tb.accounts.find((r) => r.accountId === ids.bank1Leaf)!;
    expect([gl.openingBalance, gl.totalDebit, gl.totalCredit, gl.closingBalance]).toEqual([tbRow.openingBalance, tbRow.debit, tbRow.credit, tbRow.closingBalance]);
    expect(gl.movements.at(-1)?.balance).toBe(gl.closingBalance);
    const all = await inA(() => reportsService.generalLedger(undefined, undefined, FY.from, FY.to));
    expect([all.totalDebit, all.totalCredit]).toEqual([tb.totalDebit, tb.totalCredit]);
  });

  it("🔴 F — AR ageing AS OF a date ties to the GL receivable at that date (before payment, after payment, today); today's two paths agree", async () => {
    const arAt = async (d: string) => (await inA(() => reportsService.balanceSheet(d))).assets.accountsReceivable;
    for (const [d, expected] of [["2026-04-01", 1150], ["2026-04-05", 0], ["2026-08-01", 2300]] as const) {
      const ag = await inA(() => reportsService.arAging(d));
      expect([ag.basis, ag.total], d).toEqual(["events", expected]);
      expect(ag.total - ag.liabilities.customerCredits - ag.liabilities.customerDeposits, d).toBe(await arAt(d));
    }
    const today = await inA(() => reportsService.arAging());
    expect([today.basis, today.total]).toEqual(["subledger", 2300]);
    // the INV-2 item is due 2026-08-14: on 2026-09-30 it is 47 days past due
    const late = await inA(() => reportsService.arAging("2026-09-30"));
    expect(late.items).toEqual([expect.objectContaining({ id: ids.inv2, outstanding: 2300, daysPastDue: 47 })]);
    expect(late.buckets.days_31_60).toBe(2300);
  });

  it("🔴 G — AP ageing AS OF a date ties to the GL payable at that date", async () => {
    const apAt = async (d: string) => (await inA(() => reportsService.balanceSheet(d))).liabilities.accountsPayable;
    for (const [d, expected] of [["2026-04-30", 2300], ["2026-05-01", 1150]] as const) {
      const ag = await inA(() => reportsService.apAging(d));
      expect([ag.basis, ag.total], d).toEqual(["events", expected]);
      expect(ag.total - ag.assets.supplierCredits - ag.assets.onAccountTotal, d).toBe(await apAt(d));
    }
  });

  it("🔴 H — the cash flow reconciles to the GL cash accounts, classifies by the account on the other side, and the own-account transfer is not a flow", async () => {
    const cf = await inA(() => reportsService.cashFlow(FY.from, FY.to));
    expect(cf.reconciles).toBe(true);
    expect([cf.openingCash, cf.closingCash]).toEqual([500, 40400]);
    expect(cf.netChange).toBe(39900);
    const line = (sec: typeof cf.operating, key: string) => sec.items.find((i) => i.key === key)?.amount ?? 0;
    expect(line(cf.operating, "receipts_customers")).toBe(1150);
    expect(line(cf.operating, "payments_suppliers")).toBe(-1150);
    expect(line(cf.operating, "taxes")).toBe(-100);
    expect([cf.operating.total, cf.investing.total, cf.financing.total]).toEqual([-100, -10000, 50000]);
    expect(line(cf.investing, "non_current_assets")).toBe(-10000);
    expect(line(cf.financing, "owners")).toBe(50000);
    expect(cf.internal.items, "both banks are cash: the 3,000 transfer nets to nothing").toEqual([]);
    expect([cf.method, cf.vatBasis]).toEqual(["direct", "inclusive"]);
  });

  it("🔴 K — the party dimension: the AR ledger filtered to the customer closes on the receivable; a customer with no lines shows none", async () => {
    const gl = await inA(() => reportsService.generalLedger(String(ids.ar), undefined, FY.from, FY.to, { type: "customer", id: ids.customer }));
    const bs = await inA(() => reportsService.balanceSheet(FY.to));
    expect(gl.closingBalance).toBe(bs.assets.accountsReceivable);
    expect(gl.movements.every((m) => m.partyType === "customer" && m.customerId === ids.customer)).toBe(true);
    const none = await inA(() => reportsService.generalLedger(String(ids.ar), undefined, FY.from, FY.to, { type: "customer", id: 999999999 }));
    expect([none.movements.length, none.closingBalance]).toEqual([0, 0]);
  });

  it("🔴 F-11 — the statement of changes in equity closes on the balance sheet's equity", async () => {
    const oe = await inA(() => reportsService.ownerEquity(FY.from, FY.to));
    const bs = await inA(() => reportsService.balanceSheet(FY.to));
    expect(oe.closingEquity).toBe(bs.equity.total);
    expect([oe.openingEquity, oe.netIncome, oe.contributions]).toEqual([500, 1000, 50000]);
  });

  it("🔴 L — company and tenant isolation: presence, absence AND movement, for every statement", async () => {
    const [isA, isB, isC] = await Promise.all([inA(() => reportsService.incomeStatement(FY.from, FY.to)), inB(() => reportsService.incomeStatement(FY.from, FY.to)), inC(() => reportsService.incomeStatement(FY.from, FY.to))]);
    expect([isA.totalRevenue, isB.totalRevenue, isC.totalRevenue]).toEqual([3000, 9000, 4444]);
    const [cfA, cfB] = await Promise.all([inA(() => reportsService.cashFlow(FY.from, FY.to)), inB(() => reportsService.cashFlow(FY.from, FY.to))]);
    expect([cfA.closingCash, cfB.closingCash]).toEqual([40400, 10350]);
    const [tbA, tbB] = await Promise.all([inA(() => reportsService.trialBalance(FY.from, FY.to)), inB(() => reportsService.trialBalance(FY.from, FY.to))]);
    expect(tbA.accounts.some((r) => r.debit === 10350 || r.credit === 10350)).toBe(false);
    expect(tbB.accounts.some((r) => r.debit === 10350)).toBe(true);
    const [agA, agB] = await Promise.all([inA(() => reportsService.arAging("2026-04-01")), inB(() => reportsService.arAging("2026-04-01"))]);
    expect([agA.total, agB.total]).toEqual([1150, 10350]);
    const trendA = await inA(() => analyticsService.pnlTrend("2026-01", "2026-09"));
    expect(trendA.totals.revenue).toBe(3000);
  });

  it("🔴 L (the query layer) — with NO company scope (an org-wide connection) every statement is EMPTY: the report predicate refuses rather than merging two companies' books (RLS alone would read org-wide)", async () => {
    const conn = await beginTenantConnection({ organizationId: orgId, role: "authenticated" });
    try {
      const out = await conn.run(async () => ({
        tb: await reportsService.trialBalance(FY.from, FY.to),
        is: await reportsService.incomeStatement(FY.from, FY.to),
        cf: await reportsService.cashFlow(FY.from, FY.to),
      }));
      await conn.commit();
      expect([out.tb.accounts.length, out.tb.totalDebit, out.is.totalRevenue, out.cf.closingCash]).toEqual([0, 0, 0, 0]);
    } catch (err) { await conn.rollback(); throw err; }
  });

  it("🔴 D14-03 — a migration OPENING entry inside the window is an opening balance: never a cash flow, never period movement — yet still in every balance, and the cash flow still reconciles", async () => {
    const coD = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P14 Co D',1,'gregorian') RETURNING id`, [orgId])).rows[0].id as string;
    const inD = <T,>(fn: () => Promise<T>) => inCo(orgId, coD, fn);
    const bankD = await newBank(orgId, coD, "D Main");
    const { postJournalEntry } = await import("../services/accounting/glPosting");
    await inD(() => postJournalEntry({ entryNumber: "P14-D-OPEN", date: "2026-02-01", description: "Opening position", source: "opening", lines: [{ bankAccountId: bankD, debitAmount: 7000, creditAmount: 0 }, { accountId: ids.capital, accountName: "Owner capital", debitAmount: 0, creditAmount: 7000 }] }));
    await manual(inD, "P14-D-SALE", "2026-03-05", [[await bankLeaf(bankD), 800, 0], [ids.sales, 0, 800]]);

    const cf = await inD(() => reportsService.cashFlow(FY.from, FY.to));
    expect([cf.openingCash, cf.migrationOpeningCash, cf.financing.total, cf.operating.total, cf.closingCash, cf.reconciles]).toEqual([0, 7000, 0, 800, 7800, true]);
    const tb = await inD(() => reportsService.trialBalance(FY.from, FY.to));
    const bankLeafId = await bankLeaf(bankD);
    const bank = tb.accounts.find((r) => r.accountId === bankLeafId)!;
    expect([bank.openingBalance, bank.debit, bank.closingBalance]).toEqual([7000, 800, 7800]);
    expect([tb.totalOpening, tb.totalClosing, tb.balanced]).toEqual([0, 0, true]);
    // the balance sheet carries it all the same
    const bs = await inD(() => reportsService.balanceSheet(FY.to));
    expect([bs.assets.total, bs.balanced]).toEqual([7800, true]);
    // the owner-equity statement treats the cut-over capital as OPENING, not a contribution of the window
    const oe = await inD(() => reportsService.ownerEquity(FY.from, FY.to));
    expect([oe.openingEquity, oe.contributions, oe.closingEquity]).toEqual([7000, 0, bs.equity.total]);
    // D14-09 — the drill from the TB row lands on the SAME row: the GL and the account
    // statement open on 7,000 and list only the 800 — the opening entry is not a movement
    const gl = await inD(() => reportsService.generalLedger(String(bankLeafId), undefined, FY.from, FY.to));
    expect([gl.openingBalance, gl.totalDebit, gl.closingBalance, gl.movements.length]).toEqual([bank.openingBalance, bank.debit, bank.closingBalance, 1]);
    const st = await inD(() => reportsService.accountStatement(String(bankLeafId), undefined, FY.from, FY.to));
    expect([st.openingBalance, st.totalDebit, st.closingBalance]).toEqual([7000, 800, 7800]);
    // with NO window the opening entry is still the opening (as the TB's all-history column)
    const all = await inD(() => reportsService.generalLedger(String(bankLeafId), undefined, undefined, undefined));
    const tbAll = (await inD(() => reportsService.trialBalance())).accounts.find((r) => r.accountId === bankLeafId)!;
    expect([all.openingBalance, all.totalDebit, all.closingBalance]).toEqual([tbAll.openingBalance, tbAll.debit, tbAll.closingBalance]);
  });

  it("🔴 D14-09 — a P&L account's ledger opens where its trial-balance row opens: the fiscal-year start, prior years apart — the drill never lands on a different question", async () => {
    const tb = await inA(() => reportsService.trialBalance("2026-03-01", FY.to));
    const row = tb.accounts.find((r) => r.accountId === ids.sales)!;
    const gl = await inA(() => reportsService.generalLedger(String(ids.sales), undefined, "2026-03-01", FY.to));
    // 2025's 500 of sales is the prior-years row, not this account's opening — in both reports
    expect(gl.plResetFrom).toBe("2026-01-01");
    expect([gl.openingBalance, gl.totalDebit, gl.totalCredit, gl.closingBalance]).toEqual([row.openingBalance, row.debit, row.credit, row.closingBalance]);
    expect(gl.closingBalance).toBe(-3000);
    // a balance-sheet account is NOT reset: the bank opens on everything before the window
    const bankGl = await inA(() => reportsService.generalLedger(String(ids.bank1Leaf), undefined, "2026-03-01", FY.to));
    const bankRow = tb.accounts.find((r) => r.accountId === ids.bank1Leaf)!;
    expect([bankGl.plResetFrom, bankGl.openingBalance]).toEqual([null, bankRow.openingBalance]);
    expect(bankGl.openingBalance).toBe(40500); // 500 (2025) + 50,000 − 10,000
  });

  it("🔴 H-internal — an own-account transfer STRADDLING the window end is cash in transit: an internal line, never an activity; activities + internal = the change in cash", async () => {
    const coE = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P14 Co E',1,'gregorian') RETURNING id`, [orgId])).rows[0].id as string;
    const inE = <T,>(fn: () => Promise<T>) => inCo(orgId, coE, fn);
    const e1 = await bankLeaf(await newBank(orgId, coE, "E Main")), e2 = await bankLeaf(await newBank(orgId, coE, "E Reserve"));
    const clearing = await catId(orgId, "TRANSFER_CLEARING");
    await manual(inE, "P14-E-CAP", "2026-01-10", [[e1, 5000, 0], [ids.capital, 0, 5000]]);
    await manual(inE, "P14-E-OUT", "2026-06-30", [[clearing, 700, 0], [e1, 0, 700]]);
    await manual(inE, "P14-E-IN", "2026-07-02", [[e2, 700, 0], [clearing, 0, 700]]);
    const h1 = await inE(() => reportsService.cashFlow("2026-01-01", "2026-06-30"));
    const transit = h1.internal.items.find((i) => i.key === "transfers_in_transit")?.amount;
    expect([h1.financing.total, h1.operating.total, h1.investing.total, transit, h1.netCashFromActivities, h1.netChange, h1.closingCash, h1.reconciles])
      .toEqual([5000, 0, 0, -700, 5000, 4300, 4300, true]);
    // across the whole year the two legs net out: no internal line, the 700 never was a flow
    const fy = await inE(() => reportsService.cashFlow(FY.from, FY.to));
    expect([fy.financing.total, fy.netChange, fy.internal.items.filter((i) => i.amount !== 0)]).toEqual([5000, 5000, []]);
  });

  it("🔴 F-19 — each company's statements use ITS OWN fiscal year: a second company with an April year resets its P&L in April, not at company A's January", async () => {
    const coF = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P14 Co F',4,'gregorian') RETURNING id`, [orgId])).rows[0].id as string;
    const inF = <T,>(fn: () => Promise<T>) => inCo(orgId, coF, fn);
    const tbF = await inF(() => reportsService.trialBalance("2026-06-01", "2026-06-30"));
    const bsF = await inF(() => reportsService.balanceSheet("2026-06-30"));
    expect([tbF.plResetFrom, bsF.equity.fiscalYear?.startDate]).toEqual(["2026-04-01", "2026-04-01"]);
    // movement: company A, same dates, answers with ITS January year
    const tbA = await inA(() => reportsService.trialBalance("2026-06-01", "2026-06-30"));
    expect(tbA.plResetFrom).toBe("2026-01-01");
  });

  it("🔴 the P&L trend: each month is that month's P&L, and the months sum to the window's income statement", async () => {
    const trend = await inA(() => analyticsService.pnlTrend("2026-01", "2026-09"));
    const is = await inA(() => reportsService.incomeStatement(FY.from, FY.to));
    expect(trend.totals).toEqual({ revenue: is.totalRevenue, expenses: is.totalExpenses, net: is.netIncome });
    expect(trend.points.find((p) => p.month === "2026-03")).toEqual({ month: "2026-03", revenue: 1000, expenses: 2000, net: -1000 });
    expect(trend.points.find((p) => p.month === "2026-07")).toEqual({ month: "2026-07", revenue: 2000, expenses: 0, net: 2000 });
    expect(trend.points).toHaveLength(9);
  });

  it("🔴 refusals by name — a malformed date, a reversed window, a future ageing date and a junk account id are 400s, never 'all time'", async () => {
    await expect(inA(() => reportsService.balanceSheet("2026-13-40"))).rejects.toMatchObject({ statusCode: 400 });
    await expect(inA(() => reportsService.trialBalance("2026-09-30", "2026-01-01"))).rejects.toMatchObject({ statusCode: 400 });
    await expect(inA(() => reportsService.arAging("2999-01-01"))).rejects.toMatchObject({ statusCode: 400 });
    await expect(inA(() => reportsService.generalLedger("abc", undefined, FY.from, FY.to))).rejects.toMatchObject({ statusCode: 400 });
  });

  it("🔴 exports carry EXACTLY the screen's figures: CSV (BOM, Arabic names for lang=ar, the totals), the comparative column, and a too-large export is refused, never cut short", async () => {
    const tb = await inA(() => reportsService.trialBalance(FY.from, FY.to));
    const csv = await inA(() => exportReport("trial-balance", { date_from: FY.from, date_to: FY.to }, "csv", "en"));
    const text = csv.body.toString("utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.filename).toBe(`trial-balance_${FY.from}_${FY.to}.csv`);
    expect(text).toContain(`Total,${tb.totalOpening.toFixed(2)},${tb.totalDebit.toFixed(2)},${tb.totalCredit.toFixed(2)},${tb.totalClosing.toFixed(2)}`);
    const ar = await inA(() => exportReport("trial-balance", { date_from: FY.from, date_to: FY.to }, "csv", "ar"));
    expect(ar.body.toString("utf8")).toContain("رأس المال");
    // the P&L with a comparative window: both columns, merged by account
    const doc = await inA(() => buildReportDocument("income-statement", { date_from: FY.from, date_to: FY.to, compare_from: "2025-01-01", compare_to: "2025-12-31" }, "en"));
    const salesRow = doc.tables[0]!.rows.find((r) => r.cells[0] === "Sales Revenue")!;
    expect(salesRow.cells.slice(1)).toEqual([3000, 500]);
    // company scoping holds in an export too
    const b = await inB(() => exportReport("income-statement", { date_from: FY.from, date_to: FY.to }, "csv", "en"));
    expect(b.body.toString("utf8")).toContain("9000.00");
    expect(b.body.toString("utf8")).not.toContain("3000.00");
    await expect(inA(() => exportReport("no-such-report", {}, "csv", "en"))).rejects.toMatchObject({ statusCode: 400 });
  });

  // Split out of the export test above (2026-10-07) so that a run with no
  // renderer reports THIS check as SKIPPED instead of counting it as passed.
  it("🔴 exports: the balance-sheet PDF is rendered — or the named 503 and the check is SKIPPED, never a broken file", async (ctx) => {
    let pdf: Awaited<ReturnType<typeof exportReport>>;
    try {
      pdf = await inA(() => exportReport("balance-sheet", { as_of: FY.to }, "pdf", "ar"));
    } catch (err) {
      expect(err).toBeInstanceOf(RendererUnavailableError);
      return ctx.skip("no Chromium executable — the PDF export did not run");
    }
    expect(pdf.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  // ═══ the accounting review (2026-10-01): each test FAILS on the code it was written against ═══

  it("🔴 review M1/M2 — a migration's YEAR-TO-DATE P&L (income and expense lines in the opening entry) is period movement in EVERY statement: P&L = TB = equity statement = BS current year; the trend keeps it out of the months and in the total", async () => {
    const coG = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P14 Co G',1,'gregorian') RETURNING id`, [orgId])).rows[0].id as string;
    const inG = <T,>(fn: () => Promise<T>) => inCo(orgId, coG, fn);
    const bankG = await newBank(orgId, coG, "G Main");
    const expenseG = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, is_posting) VALUES ($1,'P14 G operating costs','تكاليف','expense',true) RETURNING id`, [orgId])).rows[0].id as number;
    const { postJournalEntry } = await import("../services/accounting/glPosting");
    // cut-over 2026-07-01: the previous system's Jan–Jun — sales 900, costs 700, the 200 profit sitting in the bank — plus capital 1,000
    await inG(() => postJournalEntry({ entryNumber: "P14-G-OPEN", date: "2026-06-30", description: "Opening position", source: "opening", lines: [
      { bankAccountId: bankG, debitAmount: 1200, creditAmount: 0 },
      { accountId: expenseG, accountName: "P14 G operating costs", debitAmount: 700, creditAmount: 0 },
      { accountId: ids.sales!, accountName: "Sales", debitAmount: 0, creditAmount: 900 },
      { accountId: ids.capital!, accountName: "Owner capital", debitAmount: 0, creditAmount: 1000 },
    ] }));
    await manual(inG, "P14-G-SALE", "2026-08-10", [[await bankLeaf(bankG), 150, 0], [ids.sales!, 0, 150]]);

    const is = await inG(() => reportsService.incomeStatement(FY.from, FY.to));
    expect(is.netIncome).toBe(350); // 900 − 700 + 150
    const tb = await inG(() => reportsService.trialBalance(FY.from, FY.to));
    const plMoved = tb.accounts.filter((r) => r.type === "income" || r.type === "expense").reduce((t, r) => t + r.credit - r.debit, 0);
    expect(Math.round(plMoved * 100) / 100, "the TB's P&L movement IS the income statement (invariant C)").toBe(350);
    expect(tb.accounts.find((r) => r.accountId === ids.sales)!.openingBalance, "Sales opens at 0: the migrated 900 is THIS year's movement").toBe(0);
    expect([tb.balanced, tb.accounts.find((r) => r.accountId === ids.capital)!.openingBalance]).toEqual([true, -1000]); // capital IS opening
    // the split entry's result moves from the opening position into the period through ONE computed row, closing at 0
    expect(tb.accounts.find((r) => r.key === "migrated_ytd_result")).toMatchObject({ computed: true, openingBalance: -200, debit: 200, credit: 0, closingBalance: 0 });
    expect([tb.totalOpening, tb.totalClosing, tb.totalDebit === tb.totalCredit]).toEqual([0, 0, true]);
    const oe = await inG(() => reportsService.ownerEquity(FY.from, FY.to));
    expect([oe.openingEquity, oe.netIncome, oe.closingEquity]).toEqual([1000, 350, 1350]);
    const bs = await inG(() => reportsService.balanceSheet(FY.to));
    expect([bs.equity.currentYearProfit, bs.equity.total, bs.balanced]).toEqual([350, 1350, true]);
    // the GL of Sales lists the migrated 900 as a movement (it is in no opening), and closes on the TB row
    const gl = await inG(() => reportsService.generalLedger(String(ids.sales), undefined, FY.from, FY.to));
    expect([gl.openingBalance, gl.totalCredit, gl.closingBalance]).toEqual([0, 1050, -1050]);
    // the cash flow: the 1,200 is migration, never a flow
    const cf = await inG(() => reportsService.cashFlow(FY.from, FY.to));
    expect([cf.migrationOpeningCash, cf.operating.total, cf.closingCash, cf.reconciles]).toEqual([1200, 150, 1350, true]);
    // the trend: June shows nothing of the migrated half-year; the migrated figure stands apart, and the total is the P&L
    const trend = await inG(() => analyticsService.pnlTrend("2026-01", "2026-12"));
    expect(trend.points.find((p) => p.month === "2026-06")!.revenue).toBe(0);
    expect(trend.migrated).toEqual({ date: "2026-06-30", revenue: 900, expenses: 700, net: 200 });
    expect([trend.totals.revenue, trend.totals.net]).toEqual([is.totalRevenue, is.netIncome]);
  });

  it("🔴 review — date_from is INCLUSIVE, and the opening ends the day before it (the boundary the earlier mutation did not reach)", async () => {
    const on = await inA(() => reportsService.incomeStatement("2026-03-10", "2026-03-31"));
    const after = await inA(() => reportsService.incomeStatement("2026-03-11", "2026-03-31"));
    expect([on.totalRevenue, after.totalRevenue]).toEqual([1000, 0]);
    const tbOn = (await inA(() => reportsService.trialBalance("2026-03-10", FY.to))).accounts.find((r) => r.accountId === ids.sales)!;
    const tbAfter = (await inA(() => reportsService.trialBalance("2026-03-11", FY.to))).accounts.find((r) => r.accountId === ids.sales)!;
    expect([tbOn.openingBalance, tbOn.credit]).toEqual([0, 3000]);
    expect([tbAfter.openingBalance, tbAfter.credit]).toEqual([-1000, 2000]);
  });

  it("🔴 review K — the party dimension on the PAYABLE side too: the AP ledger filtered to the vendor closes on the balance sheet's payable", async () => {
    const gl = await inA(() => reportsService.generalLedger(String(ids.ap), undefined, FY.from, FY.to, { type: "vendor", id: ids.vendor! }));
    const bs = await inA(() => reportsService.balanceSheet(FY.to));
    expect(gl.closingBalance).toBe(-bs.liabilities.accountsPayable);
    expect(gl.movements.length).toBeGreaterThan(0);
    expect(gl.movements.every((m) => m.partyType === "vendor" && m.vendorId === ids.vendor)).toBe(true);
  });

  it("🔴 review M3 — the account summary IS the trial balance for the same dates (it used to skip the fiscal-year reset)", async () => {
    const [sum, tb] = await Promise.all([inA(() => reportsService.accountSummary("2026-03-01", FY.to)), inA(() => reportsService.trialBalance("2026-03-01", FY.to))]);
    const sales = sum.accounts.find((r) => r.accountId === ids.sales)!;
    const tbSales = tb.accounts.find((r) => r.accountId === ids.sales)!;
    expect([sales.openingBalance, sales.closingBalance]).toEqual([tbSales.openingBalance, tbSales.closingBalance]);
    expect(sales.openingBalance, "2025's sale is the prior-years row, not Sales' opening").toBe(0);
    expect(sum.accounts.length).toBe(tb.accounts.length);
  });

  it("🔴 review M4 — a ledger ONE HALALA out of balance is reported unbalanced (the tolerance used to admit it)", async () => {
    const coI = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P14 Co I',1,'gregorian') RETURNING id`, [orgId])).rows[0].id as string;
    // raw rows: the posting path refuses an unbalanced entry, so the defect is planted beneath it, as a legacy row would be
    const je = (await pool.query(`INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status) VALUES ($1,$2,'P14-I-1','2026-02-02','one halala off','posted') RETURNING id`, [orgId, coI])).rows[0].id;
    await pool.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount) VALUES ($1,$2,$3,$4,'Equipment',100.00,0), ($1,$2,$3,$5,'Owner capital',0,99.99)`, [orgId, coI, je, ids.equipment, ids.capital]);
    const inI = <T,>(fn: () => Promise<T>) => inCo(orgId, coI, fn);
    const [tb, bs] = await Promise.all([inI(() => reportsService.trialBalance(FY.from, FY.to)), inI(() => reportsService.balanceSheet(FY.to))]);
    expect([tb.totalDebit, tb.totalCredit, tb.balanced]).toEqual([100, 99.99, false]);
    expect(bs.balanced).toBe(false);
  });

  it("🔴 review L1 + cash-flow shapes — a 3-line entry with a bank fee, a two-bank entry with a fee, and a fixed asset on an account with NO liquidity class: the asset is investing, and the statement reconciles", async () => {
    const coH = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P14 Co H',1,'gregorian') RETURNING id`, [orgId])).rows[0].id as string;
    const inH = <T,>(fn: () => Promise<T>) => inCo(orgId, coH, fn);
    const h1 = await bankLeaf(await newBank(orgId, coH, "H One")), h2 = await bankLeaf(await newBank(orgId, coH, "H Two"));
    const rent = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, is_posting) VALUES ($1,'P14 H rent','إيجار','expense',true) RETURNING id`, [orgId])).rows[0].id as number;
    const fees = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, is_posting) VALUES ($1,'P14 bank charges','رسوم بنكية','expense',true) RETURNING id`, [orgId])).rows[0].id as number;
    const vehicles = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, liquidity_class, is_posting) VALUES ($1,'P14 Vehicles','مركبات','asset',NULL,true) RETURNING id`, [orgId])).rows[0].id as number;
    await pool.query(
      `INSERT INTO asset_categories (organization_id, company_id, name, cost_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id, default_useful_life_months, income_tax_group, vat_capital_asset_class)
       VALUES ($1,$2,'Vehicles',$3,$4,$5,60,3,'movable')`,
      [orgId, coH, vehicles, await catId(orgId, "ACCUMULATED_DEPRECIATION"), await catId(orgId, "DEPRECIATION_EXPENSE")],
    );
    await manual(inH, "P14-H-CAP", "2026-01-05", [[h1, 20000, 0], [ids.capital!, 0, 20000]]);
    await manual(inH, "P14-H-FEE", "2026-02-05", [[rent, 1000, 0], [fees, 10, 0], [h1, 0, 1010]]);           // pay the rent, a fee on top
    await manual(inH, "P14-H-TWO", "2026-03-05", [[h2, 400, 0], [fees, 100, 0], [h1, 0, 500]]);             // move 400, the bank keeps 100
    await manual(inH, "P14-H-CAR", "2026-04-05", [[vehicles, 8000, 0], [h1, 0, 8000]]);                    // buy a vehicle
    const cf = await inH(() => reportsService.cashFlow(FY.from, FY.to));
    const line = (sec: typeof cf.operating, key: string) => sec.items.find((i) => i.key === key)?.amount ?? 0;
    expect([line(cf.investing, "non_current_assets"), line(cf.operating, "payments_suppliers"), cf.financing.total]).toEqual([-8000, -1110, 20000]);
    expect([cf.closingCash, cf.netChange, cf.reconciles]).toEqual([10890, 10890, true]);
    expect(cf.internal.items.filter((i) => i.amount !== 0), "two banks are both cash: the 400 moved is no flow").toEqual([]);
  });


  it("🔴 D14-15 — the seam's company predicate is an INDEX CONDITION as the tenant role (the plan, read, not inferred from a timing)", async () => {
    // seq scans off: at fixture volume any plan is a scan; this asks which index the planner CAN use.
    // The old `company_id::text = …` form could not put the company into an Index Cond under RLS
    // (its functions are not leakproof) — the database review's finding, and why companyScoped is typed.
    const plan = await inA(async () => {
      await db.execute(sql`set local enable_seqscan = off`);
      const q = reportsRepository.ledgerBalances({ from: "2026-03-01", to: "2026-03-31", movementOnly: true });
      const res = await db.execute(sql`explain ${q.getSQL()}`);
      return (res.rows as Array<Record<string, string>>).map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("journal_entries_company_date_idx");
    expect(plan).toMatch(/Index Cond: \(\(company_id = /);
  });

});
