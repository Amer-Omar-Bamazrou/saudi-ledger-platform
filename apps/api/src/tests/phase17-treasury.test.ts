/**
 * PHASE 17 — TREASURY, on real rows (docs/product/phase-16-17-tax-treasury-decision-pack.md §8, §10).
 *
 * Cash is posted through the product's journal path; receivables and payables
 * through invoices and bills created and approved; plans paid through the bill
 * pay path. The forecast is anchored to TODAY (the business date), so every
 * date here is relative to it.
 *
 *   T1  treasury cash = Σ banks + unattributed = balance-sheet cash, exact; a future-dated entry is excluded
 *   T2  expected receipts = GL AR; payables (plans + the rest) = GL AP — nothing counted twice
 *   T3  closing(n) = closing(n−1) + in − out, exact; opening = T1 today
 *   T4  paying a plan moves the books exactly as payBill does, once
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { reportsService } from "../services/reports.service";
import { treasuryService } from "../services/treasury/treasury.service";
import { paymentPlansService } from "../services/treasury/paymentPlans.service";
import { addDays } from "../services/tax/taxComputations.service";
import {
  GetTreasuryPositionResponse, GetTreasuryForecastResponse, GetTreasuryDashboardResponse, ListPaymentPlansResponse,
  ListForecastAssumptionsResponse, GetTreasurySettingsResponse, PayPaymentPlanResponse,
} from "@workspace/api-zod";
import { expectConforms } from "./helpers/conforms";
import { exportReport } from "../services/reporting/reportExport.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase17-treasury] no real DATABASE_URL — skipping.");

describeMaybe("Phase 17 — treasury on real rows", () => {
  const SLUG = "p17-tr", SLUG_C = "p17-tr-c", EMAIL = "p17-tr@test.local";
  let orgId = "", orgC = "", coA = "", coB = "", coC = "", userId = 0;
  let bankA1 = 0, bankA2 = 0, bankB = 0;
  const ids: Record<string, number> = {};
  let seq = 0;
  const today = businessToday();
  const d = (n: number) => addDays(today, n);

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
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG}','${SLUG_C}'))`;
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM organizations WHERE slug IN ('${SLUG}','${SLUG_C}')`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return e as { statusCode?: number; payload?: { code?: string }; message: string; constraint?: string }; }
    throw new Error("expected a refusal");
  };
  const leaf = async (bank: number) => (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [bank])).rows[0].id as number;
  const post = async (inX: <T>(fn: () => Promise<T>) => Promise<T>, date: string, lines: [number, number, number][]) =>
    inX(async () => {
      const e = (await journalEntriesService.create({ entryNumber: `P17-${++seq}`, date, description: `p17 ${seq}`,
        lines: lines.map(([accountId, debitAmount, creditAmount]) => ({ accountId, debitAmount, creditAmount })) }, userId)) as { id: number };
      await journalEntriesService.approve(e.id, userId);
    });
  const glDebit = async (co: string, code: string) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN categories c ON c.id = l.account_id WHERE e.company_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed') AND e.date::date <= $3::date`, [co, code, today])).rows[0].v);
  const entryCount = async () => Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);
  const invoice = async (inX: <T>(fn: () => Promise<T>) => Promise<T>, date: string, due: string, net: number) => {
    const inv = await inX(() => invoicesService.create({ invoiceNumber: `P17-INV-${++seq}`, date, dueDate: due, customerId: ids.customer, items: [{ description: "Service", quantity: 1, unitPrice: net, vatRate: 15 }] }, userId)) as { id: number };
    await inX(() => invoicesService.approve(inv.id, userId));
    return inv.id;
  };
  const bill = async (vendorId: number, date: string, due: string, net: number) => {
    const b = await inA(() => billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: `S-${++seq}`, billNumber: `P17-B-${seq}`, date, dueDate: due, vendorId,
      items: [{ description: "Supply", quantity: 1, unitPrice: net, vatRate: 0 }] }, userId)) as { id: number };
    return (await inA(() => billsService.approve(b.id, {}, userId)) as { id: number }).id;
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P17 TR','${SLUG}','approved') RETURNING id`)).rows[0].id;
    coA = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number) VALUES ($1,'P17 A',1,'gregorian','399999999999993','1010101012') RETURNING id`, [orgId])).rows[0].id;
    await new Promise((r) => setTimeout(r, 20));
    coB = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number) VALUES ($1,'P17 B',1,'gregorian','399999999999993','1010101013') RETURNING id`, [orgId])).rows[0].id;
    orgC = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P17 TR C','${SLUG_C}','approved') RETURNING id`)).rows[0].id;
    coC = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P17 C',1,'gregorian') RETURNING id`, [orgC])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P17',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, orgC]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    bankA1 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Ops A1','SNB') RETURNING id`, [orgId, coA])).rows[0].id;
    bankA2 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Reserve A2','Riyad') RETURNING id`, [orgId, coA])).rows[0].id;
    bankB = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Ops B','SNB') RETURNING id`, [orgId, coB])).rows[0].id;
    ids.capital = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable) VALUES ($1,'P17 capital','P17 capital','equity',false) RETURNING id`, [orgId])).rows[0].id;
    ids.exp = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable) VALUES ($1,'P17 wages','P17 wages','expense',false) RETURNING id`, [orgId])).rows[0].id;
    ids.salariesPayable = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'SALARIES_PAYABLE'`, [orgId])).rows[0].id;
    ids.customer = (await pool.query(`INSERT INTO customers (organization_id, name, payment_terms_days) VALUES ($1,'P17 Customer','30') RETURNING id`, [orgId])).rows[0].id;
    ids.nr = (await pool.query(`INSERT INTO vendors (organization_id, name, residency, wht_default_payment_type) VALUES ($1,'P17 Foreign Consultant','non_resident','technical_consulting') RETURNING id`, [orgId])).rows[0].id;
    ids.res = (await pool.query(`INSERT INTO vendors (organization_id, name, residency) VALUES ($1,'P17 Local Supplier','resident') RETURNING id`, [orgId])).rows[0].id;

    // cash: A1 100,000 (10 days ago) · A2 50,000 (5 days ago) · and a FUTURE-dated 7,000 into A1 (in 5 days)
    await post(inA, d(-10), [[await leaf(bankA1), 100_000, 0], [ids.capital!, 0, 100_000]]);
    await post(inA, d(-5), [[await leaf(bankA2), 50_000, 0], [ids.capital!, 0, 50_000]]);
    await post(inA, d(5), [[await leaf(bankA1), 7_000, 0], [ids.capital!, 0, 7_000]]);
    // payroll payable — undated (no payroll payment path exists)
    await post(inA, d(-2), [[ids.exp!, 5_000, 0], [ids.salariesPayable!, 0, 5_000]]);
    // receivables: due in 10 days · overdue by 5 · beyond the horizon
    ids.inv1 = await invoice(inA, d(-20), d(10), 1_000);   // 1,150
    ids.inv2 = await invoice(inA, d(-40), d(-5), 2_000);   // 2,300 — overdue
    ids.inv3 = await invoice(inA, d(-1), d(200), 500);     //   575 — beyond 13 weeks
    // payables: a resident's due in 3 days · a non-resident's due in 20
    ids.billR = await bill(ids.res!, d(-10), d(3), 1_150);
    ids.billNR = await bill(ids.nr!, d(-10), d(20), 10_000);
    // a manual assumption, and a STALE one (past-dated)
    await inA(() => treasuryService.createEntry({ entryDate: d(14), direction: "inflow", amount: 20_000, category: "financing", description: "Shareholder loan drawdown" }, userId));
    await inA(() => treasuryService.createEntry({ entryDate: d(-3), direction: "outflow", amount: 999, category: "other", description: "Stale assumption" }, userId));
  }, 180_000);
  afterAll(cleanup);

  it("🔴 T1 — cash is the ledger: per bank, the total = balance-sheet cash EXACTLY; a future-dated entry is not cash; the future is refused as a position", async () => {
    const p = await inA(() => treasuryService.position());
    expect(p.banks.map((b) => [b.name, b.ledgerBalance]).sort()).toEqual([["Ops A1", 100_000], ["Reserve A2", 50_000]].sort());
    expect([p.totalCash, p.unattributedCash, p.reconciliation.reconciles, p.reconciliation.balanceSheetCash]).toEqual([150_000, 0, true, 150_000]);
    const bs = await inA(() => reportsService.balanceSheet(today));
    expect(bs.assets.items.filter((i) => i.liquidityClass === "cash").reduce((s, i) => s + i.amount, 0)).toBe(p.totalCash);
    // as of a past day: A2's deposit (5 days ago) is not there yet
    const past = await inA(() => treasuryService.position(d(-7)));
    expect([past.totalCash, past.reconciliation.reconciles]).toEqual([100_000, true]);
    expect((await refusal(inA(() => treasuryService.position(d(1))))).payload?.code).toBe("as_of_in_future");
  });

  it("🔴 T2 + T3 — every row typed and sourced; overdue and undated in their own bucket; receipts = GL AR; closing chains exactly", async () => {
    const f = await inA(() => treasuryService.forecast(13));
    expect(f.opening).toEqual({ kind: "actual", amount: 150_000 });
    const inv2 = f.rows.find((r) => r.source.type === "invoice" && r.source.id === ids.inv2)!;
    expect([inv2.bucket, inv2.bucketReason, inv2.kind, inv2.amount]).toEqual([0, "overdue", "expected", 2_300]);
    const payroll = f.rows.find((r) => r.category === "payroll")!;
    expect([payroll.bucket, payroll.bucketReason, payroll.amount]).toEqual([0, "undated", 5_000]);
    const inv1 = f.rows.find((r) => r.source.type === "invoice" && r.source.id === ids.inv1)!;
    expect([inv1.bucket, inv1.date]).toEqual([2, d(10)]);
    expect(f.excluded.beyondHorizon).toEqual({ inflow: 575, outflow: 0, count: 1 });
    expect(f.excluded.staleAssumptions).toBe(1);
    expect(f.rows.find((r) => r.kind === "manual")!.amount).toBe(20_000);
    // T2: Σ expected receipts (in the horizon + beyond it) = GL AR
    const receiptsH = Math.round(f.rows.filter((r) => r.category === "receivables").reduce((s, r) => s + r.amount * 100, 0)) + 57_500;
    expect(receiptsH / 100).toBe(await glDebit(coA, "AR"));
    // T2: Σ payables (expected + plan rows) = GL AP (credit)
    const payH = Math.round(f.rows.filter((r) => r.category === "payables" || r.category === "payment_plans").reduce((s, r) => s + r.amount * 100, 0));
    expect(payH / 100).toBe(-(await glDebit(coA, "AP")));
    // T3: closing chains, exact
    let running = Math.round(f.opening.amount * 100);
    for (const b of f.buckets) {
      expect(Math.round(b.opening * 100), `bucket ${b.index} opens where the last closed`).toBe(running);
      running = running + Math.round(b.inflow.total * 100) - Math.round(b.outflow.total * 100);
      expect(Math.round(b.closing * 100)).toBe(running);
      const inRows = f.rows.filter((r) => r.bucket === b.index && r.direction === "in").reduce((s, r) => s + Math.round(r.amount * 100), 0);
      expect(Math.round(b.inflow.total * 100), `bucket ${b.index}'s inflow IS its rows`).toBe(inRows);
    }
  });

  let planId = 0;
  it("🔴 a plan never exceeds what the bill owes; it displaces the due-date expectation (no double count) and posts NOTHING", async () => {
    const e1 = await refusal(inA(() => paymentPlansService.create({ billId: ids.billNR, plannedDate: d(7), amount: 10_000.01 }, userId)));
    expect([e1.statusCode, e1.payload?.code]).toEqual([409, "plan_exceeds_outstanding"]);
    expect((await refusal(inA(() => paymentPlansService.create({ billId: ids.billNR, plannedDate: d(-1), amount: 100 }, userId)))).payload?.code).toBe("plan_date_in_past");
    const before = await entryCount();
    const p = await inA(() => paymentPlansService.create({ billId: ids.billNR, plannedDate: d(7), amount: 6_000, priority: "high", bankAccountId: bankA1, whtPaymentType: "technical_consulting" }, userId));
    planId = p.id;
    expect([p.status, p.whtEstimate, p.cashEstimate]).toEqual(["planned", 300, 5_700]);
    // a second plan for more than is left is refused
    expect((await refusal(inA(() => paymentPlansService.create({ billId: ids.billNR, plannedDate: d(8), amount: 4_000.01 }, userId)))).payload?.code).toBe("plan_exceeds_outstanding");
    await inA(() => paymentPlansService.approve(planId, userId));
    expect(await entryCount(), "a plan is an intention: nothing posts").toBe(before);
    const f = await inA(() => treasuryService.forecast(13));
    const planned = f.rows.filter((r) => r.source.type === "scheduled_payment");
    expect(planned.map((r) => [r.kind, r.amount, r.bucket])).toEqual([["committed", 6_000, 2]]);
    const rest = f.rows.find((r) => r.source.type === "bill" && r.source.id === ids.billNR)!;
    expect([rest.amount, rest.date], "the bill's remainder only, at its due date").toEqual([4_000, d(20)]);
    expect([f.liquidity.committed, f.liquidity.available]).toEqual([6_000, 144_000]);
  });

  it("🔴 T4 — paying the plan IS one bill payment (WHT included): the bank −5,700, WHT +300, AP −6,000; the plan names it; it is paid once", async () => {
    const bankBefore = (await inA(() => treasuryService.position())).banks.find((b) => b.bankAccountId === bankA1)!.ledgerBalance;
    const r = await inA(() => paymentPlansService.pay(planId, {}, userId));
    expect([r.plan.status, r.payment.amount, r.payment.cashPaid, r.payment.withheld]).toEqual(["paid", 6_000, 5_700, 300]);
    expect(r.plan.paidBillPaymentId).toBe(r.payment.billPaymentId);
    const bankAfter = (await inA(() => treasuryService.position())).banks.find((b) => b.bankAccountId === bankA1)!.ledgerBalance;
    expect(Math.round((bankAfter - bankBefore) * 100) / 100).toBe(-5_700);
    expect(Number((await pool.query(`SELECT count(*)::int n FROM bill_payments WHERE bill_id = $1`, [ids.billNR])).rows[0].n)).toBe(1);
    expect((await refusal(inA(() => paymentPlansService.pay(planId, {}, userId)))).payload?.code).toBe("plan_not_approved");
    const f = await inA(() => treasuryService.forecast(13));
    expect(f.rows.filter((x) => x.source.type === "scheduled_payment"), "a paid plan leaves the forecast").toEqual([]);
  });

  it("🔴 the WHT declaration made AT PAYMENT governs: a plan planned with a nature is paid as NOT SUBJECT (goods) — nothing withheld, no conflict", async () => {
    // found by the UI build (2026-10-04): `body.whtPaymentType ?? plan.whtPaymentType` made the plan's stored
    // nature win over a not-subject reason given at payment, so the pay path refused the pair as a conflict
    const goods = await bill(ids.nr!, d(-3), d(15), 2_000);
    const p = await inA(() => paymentPlansService.create({ billId: goods, plannedDate: d(4), amount: 2_000, bankAccountId: bankA1, whtPaymentType: "technical_consulting" }, userId));
    expect([p.whtEstimate, p.cashEstimate]).toEqual([100, 1_900]);
    await inA(() => paymentPlansService.approve(p.id, userId));
    const r = await inA(() => paymentPlansService.pay(p.id, { whtNotSubjectReason: "goods" }, userId));
    expect([r.plan.status, r.payment.amount, r.payment.withheld, r.payment.cashPaid]).toEqual(["paid", 2_000, 0, 2_000]);
    const w = (await pool.query(`SELECT status, not_subject_reason, wht_amount::numeric AS wht FROM wht_withholdings WHERE bill_payment_id = $1`, [r.payment.billPaymentId])).rows[0];
    expect([w.status, w.not_subject_reason, Number(w.wht)]).toEqual(["not_subject", "goods", 0]);
    expectConforms(PayPaymentPlanResponse, r, "POST /treasury/payment-plans/:id/pay");
  });

  it("🔴 contract conformance — every treasury response parses under its generated schema, on these real rows", async () => {
    expectConforms(GetTreasuryPositionResponse, await inA(() => treasuryService.position()), "GET /treasury/position");
    expectConforms(GetTreasuryPositionResponse, await inA(() => treasuryService.position(d(-7))), "GET /treasury/position?as_of");
    const f = await inA(() => treasuryService.forecast(13));
    expect(new Set(f.rows.map((r) => r.category)).size, "the forecast carries several row categories").toBeGreaterThanOrEqual(4);
    expectConforms(GetTreasuryForecastResponse, f, "GET /treasury/forecast");
    expectConforms(GetTreasuryDashboardResponse, await inA(() => treasuryService.dashboard()), "GET /treasury/dashboard");
    const plans = await inA(() => paymentPlansService.list({}));
    expect(plans.length).toBeGreaterThan(0);
    expectConforms(ListPaymentPlansResponse, plans, "GET /treasury/payment-plans");
    const assumptions = await inA(() => treasuryService.entries());
    expect(assumptions.length).toBeGreaterThan(0);
    expectConforms(ListForecastAssumptionsResponse, assumptions, "GET /treasury/assumptions");
    expectConforms(GetTreasurySettingsResponse, await inA(() => treasuryService.settings()), "GET /treasury/settings");
    // the instrument sees: a broken response FAILS the same schema
    expect(GetTreasuryForecastResponse.safeParse({ ...JSON.parse(JSON.stringify(f)), buckets: "nope" }).success).toBe(false);
    // the forecast CSV carries every bucket's closing, as the screen shows it
    const csv = (await inA(() => exportReport("treasury-forecast", { weeks: "13" }, "csv", "en"))).body.toString("utf8");
    for (const b of f.buckets) expect(csv, `bucket ${b.index}'s closing`).toContain(b.closing.toFixed(2));
    expect(csv).toContain("a projection, never cash");
  });

  it("🔴 a plan the bill no longer covers is refused BY NAME at execution; the database pins 'paid' to a real payment of the plan's bill and amount", async () => {
    const p = await inA(() => paymentPlansService.create({ billId: ids.billR, plannedDate: d(2), amount: 1_150, bankAccountId: bankA1 }, userId));
    await inA(() => paymentPlansService.approve(p.id, userId));
    await inA(() => billsService.pay(ids.billR!, { amount: 500, paidAt: today, bankAccountId: bankA2 }, userId)); // paid partly another way
    const list = await inA(() => paymentPlansService.list({ billId: ids.billR }));
    expect(list[0]!.exceedsOutstanding).toBe(true);
    expect((await refusal(inA(() => paymentPlansService.pay(p.id, {}, userId)))).payload?.code).toBe("plan_exceeds_outstanding");
    // owner SQL: "paid" with a payment of another bill is refused; deleting an approved plan is refused
    const otherPayment = (await pool.query(`SELECT id FROM bill_payments WHERE bill_id = $1 LIMIT 1`, [ids.billNR])).rows[0].id;
    const owner = async (sql: string, params: unknown[]) => {
      const c = await pool.connect();
      try { await c.query("BEGIN"); await c.query(sql, params); throw new Error("NOT REFUSED"); }
      catch (e) { if ((e as Error).message === "NOT REFUSED") throw e; return (e as { constraint?: string }).constraint; }
      finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
    };
    expect(await owner(`UPDATE scheduled_payments SET status = 'paid', paid_bill_payment_id = $2, paid_at = now() WHERE id = $1`, [p.id, otherPayment])).toBe("scheduled_payment_paid_by");
    expect(await owner(`DELETE FROM scheduled_payments WHERE id = $1`, [p.id])).toBe("scheduled_payment_immutable");
    expect(await owner(`UPDATE scheduled_payments SET amount = 1 WHERE id = $1`, [p.id])).toBe("scheduled_payment_immutable");
    await inA(() => paymentPlansService.cancel(p.id, { reason: "paid partly by cheque" }, userId));
  });

  it("🔴 funding requirement — the CALCULATION is the largest gap below the declared buffer; the recommendation is words; nothing is booked", async () => {
    const before = await entryCount();
    let f = await inA(() => treasuryService.forecast(13));
    expect([f.funding.bufferDeclared, f.funding.minimumBalance]).toEqual([false, null]);
    expect(f.funding.requirement, "measured against zero when no buffer is declared").toBe(0);
    await inA(() => treasuryService.updateSettings({ minimumCashBalance: 200_000 }, userId));
    f = await inA(() => treasuryService.forecast(13));
    const gaps = f.buckets.map((b) => Math.max(0, Math.round((200_000 - b.closing) * 100)));
    expect(Math.round(f.funding.requirement * 100)).toBe(Math.max(...gaps));
    expect(f.funding.firstShortfallBucket).toBe(gaps.findIndex((g) => g > 0));
    expect(f.funding.recommendation?.en).toMatch(/Arrange funding of SAR .* not a financing transaction/);
    expect(await entryCount(), "a funding requirement books nothing").toBe(before);
  });

  it("🔴 isolation — presence, absence, movement: company B and another organisation see none of A's cash, rows or plans", async () => {
    const b = await inB(() => treasuryService.position());
    expect(b.banks.map((x) => x.bankAccountId)).toEqual([bankB]);
    expect(b.totalCash).toBe(0);
    expect((await inB(() => treasuryService.forecast(13))).rows).toEqual([]);
    expect(await inB(() => paymentPlansService.list())).toEqual([]);
    expect((await inC(() => treasuryService.position())).banks).toEqual([]);
    // movement: B receives cash — B sees it, A's total does not move
    const aTotal = (await inA(() => treasuryService.position())).totalCash;
    await post(inB, d(-1), [[await leaf(bankB), 3_000, 0], [ids.capital!, 0, 3_000]]);
    expect((await inB(() => treasuryService.position())).totalCash).toBe(3_000);
    expect((await inA(() => treasuryService.position())).totalCash).toBe(aTotal);
    // B cannot plan A's bill (a foreign bill reads exactly as a missing one)
    expect((await refusal(inB(() => paymentPlansService.create({ billId: ids.billNR, plannedDate: d(9), amount: 1 }, userId)))).statusCode).toBe(404);
  });
});
