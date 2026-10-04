/**
 * PHASE 16 + 17 × BATCH 1C POLICY C — a reversed opening bill is HISTORY in
 * tax and treasury (decision pack §13; openingReversal.ts; the 1C pack
 * §16.12.1, accountant A4).
 *
 * Found by the recovery audit (2026-10-04): `tax.repository.ts` and
 * `treasury.repository.ts` read bills / bill payments without the one
 * reversed-row predicate, the payment-plan writers accepted a reversed opening
 * bill, and an open plan did not block a batch reversal. Every figure here is
 * produced by the product's own paths — a migration staged, validated,
 * COMMITTED and REVERSED through `migrationCommitService`; bills approved and
 * paid through the bill pay path; plans through `paymentPlansService`.
 *
 *   Org L (live)      — its migration stays committed: the LIVE opening bills
 *                       are included (plan, forecast, WHT exceptions), beside
 *                       normal current bills.
 *   Org R (reversed)  — its migration is reversed: the opening bills are
 *                       excluded from every tax / treasury figure, refused by
 *                       every plan writer (service AND database), and the
 *                       reversal is refused while a plan is open on one.
 *
 * Two rows below are PLANTED with triggers off (`session_replication_role =
 * replica`), each labelled: states the product can no longer produce, written
 * to prove the READERS stay correct if one were ever reached (a plan created
 * under 0114 before 0115 closed the write path; a payment row on a reversed
 * bill). A planted row is a probe of the reader, never a fixture of a feature.
 *
 * As-of: the reversal's mirror journal is dated the OPENING date, so the GL
 * reads the reversed opening position as zero at EVERY as-of date, including
 * dates before the reversal happened in real time — and the subledger readers
 * agree, because the predicate is a marking, not a date.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { auditContext } from "../lib/auditContext";
import { migrationService } from "../services/migration.service";
import { migrationStagingService } from "../services/migrationStaging.service";
import { migrationValidationService } from "../services/migrationValidation.service";
import { migrationCommitService } from "../services/migrationCommit.service";
import { billsService } from "../services/bills.service";
import { treasuryService } from "../services/treasury/treasury.service";
import { paymentPlansService } from "../services/treasury/paymentPlans.service";
import { taxRepository } from "../repositories/tax.repository";
import { addDays } from "../services/tax/taxComputations.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-17-opening-reversal] no real DATABASE_URL — skipping.");

describeMaybe("Phase 16 + 17 × Policy C — reversed opening bills in tax and treasury", () => {
  const SLUG_L = "p1617-orev-live", SLUG_R = "p1617-orev-rev", EMAIL = "p1617-orev@test.local";
  let orgL = "", coL = "", orgR = "", coR = "", userId = 0;
  let bankL = 0, bankR = 0;
  const v: Record<string, number> = {};
  const today = businessToday();
  const d = (n: number) => addDays(today, n);
  let seq = 0;

  const inCo = async <T,>(org: string, co: string, fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const inL = <T,>(fn: () => Promise<T>) => inCo(orgL, coL, fn);
  const inR = <T,>(fn: () => Promise<T>) => inCo(orgR, coR, fn);
  type Run = typeof inL;

  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG_L}','${SLUG_R}'))`;
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM organizations WHERE slug IN ('${SLUG_L}','${SLUG_R}')`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return e as { statusCode?: number; payload?: { code?: string }; message: string; constraint?: string; code?: string }; }
    throw new Error("expected a refusal");
  };
  /** Planted with triggers OFF — a probe of the reader (see the header), never a product state. */
  const plant = async (sqlText: string, params: unknown[]) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const r = await c.query(sqlText, params);
      await c.query("COMMIT");
      return r.rows[0];
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };

  /** The opening position, as at 2026-06-30: a bank 20,000 = AP 11,500 (BILL-77 7,000 · BILL-78 4,500) + retained earnings 8,500. */
  const migrate = async (run: Run, bank: number, v1: number, v2: number) => {
    const b = await run(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" }, userId));
    await run(() => migrationService.importChart(b.id, { rows: [
      { sourceCode: "1100", sourceName: "Riyad Bank", sourceType: "asset", openingDebit: 20000, sourceRole: "bank", evidenceNote: "Riyad statement 30 Jun 2026, closing 20,000.00" },
      { sourceCode: "2100", sourceName: "Trade creditors", sourceType: "liability", openingCredit: 11500, sourceRole: "payable" },
      { sourceCode: "3200", sourceName: "Retained earnings b/f", sourceType: "equity", openingCredit: 8500, sourceRole: "retained_earnings" },
    ] }, userId));
    const chart = await run(() => migrationService.getChart(b.id));
    const row = (code: string) => chart.rows.find((r) => r.sourceCode === code)!.id;
    await run(() => migrationService.decideChartRow(b.id, row("1100"), { decision: "map_to_bank", targetBankAccountId: bank }, userId));
    await run(() => migrationService.decideChartRow(b.id, row("2100"), { decision: "map_to_system", targetSystemCode: "AP" }, userId));
    await run(() => migrationService.decideChartRow(b.id, row("3200"), { decision: "map_to_system", targetSystemCode: "RETAINED_EARNINGS" }, userId));
    const parties = await run(() => migrationStagingService.importParties(b.id, { rows: [
      { partyType: "vendor" as const, sourceId: "V1", name: "Delta Supplies" },
      { partyType: "vendor" as const, sourceId: "V2", name: "Epsilon Ltd" },
    ] }, userId));
    const p = (sid: string) => parties.rows.find((r) => r.sourceId === sid)!.id;
    await run(() => migrationStagingService.decideParty(b.id, p("V1"), { decision: "use_existing", existingId: v1 }, userId));
    await run(() => migrationStagingService.decideParty(b.id, p("V2"), { decision: "use_existing", existingId: v2 }, userId));
    await run(() => migrationStagingService.importOpenItems(b.id, { rows: [
      { itemType: "ap" as const, sourceId: "PI-77", partySourceId: "V1", documentNumber: "BILL-77", issueDate: "2026-04-15", dueDate: "2026-05-15", originalAmount: 7000, outstandingAmount: 7000 },
      { itemType: "ap" as const, sourceId: "PI-78", partySourceId: "V2", documentNumber: "BILL-78", issueDate: "2026-06-20", dueDate: "2026-07-20", originalAmount: 9000, outstandingAmount: 4500 },
    ] }, userId));
    await run(() => migrationService.updateBatch(b.id, { vatPosition: { returnReference: "VAT-2026-Q2-ACK-1", periodStart: "2026-04-01", periodEnd: "2026-06-30", outputVatPayable: 0, inputVatReceivable: 0 } }, userId));
    const val = await run(() => migrationValidationService.validate(b.id, userId));
    expect(val.ok, JSON.stringify(val.checks?.filter((c: { status: string }) => c.status !== "pass"))).toBe(true);
    const out = await run(() => migrationCommitService.commit(b.id, userId));
    expect(out.status).toBe("committed");
    return b.id;
  };
  const billId = async (co: string, number: string) => Number((await pool.query(`SELECT id FROM bills WHERE company_id = $1 AND bill_number = $2`, [co, number])).rows[0].id);
  const currentBill = async (run: Run, vendorId: number, net: number) => {
    const b = await run(() => billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: `S-${++seq}`, billNumber: `ORV-B-${seq}`, date: d(-5), dueDate: d(10), vendorId,
      items: [{ description: "Supply", quantity: 1, unitPrice: net, vatRate: 0 }] }, userId)) as { id: number };
    return (await run(() => billsService.approve(b.id, {}, userId)) as { id: number }).id;
  };
  const glAp = async (co: string, asOf: string) => Number((await pool.query(
    `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
       JOIN categories c ON c.id = l.account_id WHERE e.company_id = $1 AND c.system_code = 'AP' AND e.status IN ('posted','reversed') AND e.date::date <= $2::date`, [co, asOf])).rows[0].v);
  const payableBills = (f: Awaited<ReturnType<typeof treasuryService.forecast>>) =>
    f.rows.filter((r) => r.category === "payables").map((r) => [r.source.reference, r.amount] as const).sort();

  let batchR = 0;
  const ids: Record<string, number> = {};
  const before: Record<string, unknown> = {};

  beforeAll(async () => {
    await cleanup();
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','ORV',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const [slug, which] of [[SLUG_L, "L"], [SLUG_R, "R"]] as const) {
      const org = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ($1,$2,'approved') RETURNING id`, [`ORV ${which}`, slug])).rows[0].id;
      const co = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number) VALUES ($1,$2,1,'gregorian','399999999999993',$3) RETURNING id`,
        [org, `ORV ${which} Co`, which === "L" ? "1010202021" : "1010202022"])).rows[0].id;
      await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, org]);
      const bank = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Riyad Main','Riyad Bank') RETURNING id`, [org, co])).rows[0].id;
      // V1 / V2 — the opening bills' suppliers, residency UNDECLARED (the WHT "undeclared" exception list); a resident one for current bills
      v[`${which}1`] = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Delta Supplies') RETURNING id`, [org])).rows[0].id;
      v[`${which}2`] = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Epsilon Ltd') RETURNING id`, [org])).rows[0].id;
      v[`${which}res`] = (await pool.query(`INSERT INTO vendors (organization_id, name, residency) VALUES ($1,'Local Supplier','resident') RETURNING id`, [org])).rows[0].id;
      if (which === "L") { orgL = org; coL = co; bankL = bank; } else { orgR = org; coR = co; bankR = bank; }
    }
    await migrate(inL, bankL, v.L1!, v.L2!);
    batchR = await migrate(inR, bankR, v.R1!, v.R2!);
    for (const [k, co] of [["L", coL], ["R", coR]] as const) {
      ids[`${k}77`] = await billId(co, "BILL-77");
      ids[`${k}78`] = await billId(co, "BILL-78");
    }
    // normal CURRENT bills, after the cutover: one to a resident (planned), one to an undeclared supplier (paid — a WHT exception)
    ids.Lcur = await currentBill(inL, v.Lres!, 1_000);
    ids.Rcur = await currentBill(inR, v.Rres!, 1_000);
    ids.LcurU = await currentBill(inL, v.L1!, 600);
    ids.RcurU = await currentBill(inR, v.R1!, 600);
    await inL(() => billsService.pay(ids.LcurU!, { amount: 600, paidAt: today, bankAccountId: bankL }, userId));
    await inR(() => billsService.pay(ids.RcurU!, { amount: 600, paidAt: today, bankAccountId: bankR }, userId));
  }, 240_000);
  afterAll(cleanup);

  it("🔴 LIVE opening bills are INCLUDED, beside normal current bills: plans, the forecast's payables, the WHT exception list", async () => {
    // a plan on a live opening bill: accepted, owing what billPosition says, not flagged reversed
    const plan = await inL(() => paymentPlansService.create({ billId: ids.L78, amount: 4500, plannedDate: d(7) }, userId));
    expect([plan.billOutstanding, plan.billReversed, plan.exceedsOutstanding]).toEqual([4500, false, false]);
    ids.Lplan78 = plan.id;
    ids.LplanCur = (await inL(() => paymentPlansService.create({ billId: ids.Lcur, amount: 1000, plannedDate: d(3) }, userId))).id;

    const f = await inL(() => treasuryService.forecast());
    // the plan DISPLACES BILL-78's due-date expectation (never counted twice); BILL-77 stays expected, overdue
    expect(payableBills(f)).toEqual([["BILL-77", 7000]]);
    expect(f.rows.filter((r) => r.category === "payment_plans").map((r) => [r.source.reference, r.amount]).sort()).toEqual([["BILL-78", 4500], [expect.stringMatching(/^ORV-B-/), 1000]].sort());
    expect(f.planFlags.find((x) => x.planId === ids.Lplan78)).toEqual({ planId: ids.Lplan78, covered: 4500, exceedsOutstanding: false, billReversed: false });
    // T2 holds with the opening bills in: payables + plans = GL AP (opening 11,500 + current 1,000; the 600 is paid)
    const out = f.rows.filter((r) => r.category === "payables" || r.category === "payment_plans").reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100;
    expect([out, await glAp(coL, today)]).toEqual([12500, 12500]);

    // WHT: a payment on the LIVE opening bill to an undeclared supplier is an exception — beside the current one
    await inL(() => billsService.pay(ids.L77!, { amount: 1000, paidAt: today, bankAccountId: bankL }, userId));
    const ex = await inL(() => taxRepository.exceptions("undeclared"));
    expect(ex.map((r) => [r.document, Number(r.amount)]).sort()).toEqual([["BILL-77", 1000], [expect.stringMatching(/^ORV-B-/), 600]].sort());
    expect(ex[0]!.total).toBe(2);
  });

  it("🔴 an OPEN plan on an opening bill BLOCKS the batch reversal — named; cancelled, the reversal proceeds", async () => {
    before.position = await inR(() => treasuryService.position("2026-06-30"));
    before.apAsOfJuly = await glAp(coR, "2026-07-31");
    before.forecast = payableBills(await inR(() => treasuryService.forecast()));
    expect(before.position).toMatchObject({ totalCash: 20000, reconciliation: { reconciles: true } });
    expect(before.apAsOfJuly).toBe(11500);
    expect(before.forecast).toEqual([["BILL-77", 7000], ["BILL-78", 4500], [expect.stringMatching(/^ORV-B-/), 1000]].sort());

    const plan = await inR(() => paymentPlansService.create({ billId: ids.R78, amount: 4500, plannedDate: d(7) }, userId));
    const preview = await inR(() => migrationCommitService.reversalPreview(batchR));
    expect(preview.blockers).toEqual([expect.stringMatching(/bill BILL-78 has 1 open payment plan\(s\) — cancel them in Treasury first/)]);
    const e = await refusal(inR(() => migrationCommitService.reverse(batchR, { reason: "the opening AP was wrong" }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([422, "migration_reversal_blocked"]);

    await inR(() => paymentPlansService.cancel(plan.id, { reason: "the opening position is being corrected" }, userId));
    expect((await inR(() => migrationCommitService.reversalPreview(batchR))).blockers).toEqual([]);
    const out = await inR(() => migrationCommitService.reverse(batchR, { reason: "the opening AP was wrong — re-migrating" }, userId));
    expect(out.status).toBe("reversed");
    expect((await pool.query(`SELECT count(*)::int n FROM bills WHERE company_id = $1 AND reversed_at IS NOT NULL`, [coR])).rows[0].n).toBe(2);
  });

  it("🔴 a REVERSED opening bill is refused by every plan writer — the service by name, the database beneath it", async () => {
    const e = await refusal(inR(() => paymentPlansService.create({ billId: ids.R78, amount: 100, plannedDate: d(7) }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([409, "opening_item_reversed"]);
    // the wall beneath: a direct insert, triggers ON
    const db = await refusal(pool.query(`INSERT INTO scheduled_payments (organization_id, company_id, bill_id, planned_date, amount) VALUES ($1,$2,$3,$4,100)`, [orgR, coR, ids.R78, d(7)]));
    expect(db.constraint).toBe("scheduled_payment_bill_reversed");
    // movement: the CURRENT bill is still planned normally in the same company
    const ok = await inR(() => paymentPlansService.create({ billId: ids.Rcur, amount: 1000, plannedDate: d(3) }, userId));
    expect([ok.billReversed, ok.billOutstanding]).toEqual([false, 1000]);
    ids.RplanCur = ok.id;
  });

  it("🔴 the forecast and the position EXCLUDE the reversed opening bills at every as-of date — the GL and the subledger agree; current bills stay", async () => {
    const f = await inR(() => treasuryService.forecast());
    // BILL-77 / BILL-78 gone from payables; the current bill is covered by its plan
    expect(payableBills(f)).toEqual([]);
    expect(f.rows.filter((r) => r.category === "payment_plans").map((r) => [r.source.reference, r.amount])).toEqual([[expect.stringMatching(/^ORV-B-/), 1000]]);
    const out = f.rows.filter((r) => r.category === "payables" || r.category === "payment_plans").reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100;
    expect([out, await glAp(coR, today)]).toEqual([1000, 1000]);

    // as of a date BEFORE the reversal happened (July): the mirror is dated the opening date, so the GL says 0 — and the readers agree
    expect(await glAp(coR, "2026-07-31")).toBe(0);
    const pos = await inR(() => treasuryService.position("2026-06-30"));
    expect([pos.totalCash, pos.reconciliation.reconciles, pos.reconciliation.balanceSheetCash]).toEqual([0, true, 0]);
    // movement: the figures MOVED from the before-snapshot (presence → absence), and the live org still shows its opening bank
    expect([(before.position as { totalCash: number }).totalCash, before.apAsOfJuly]).toEqual([20000, 11500]);
    const live = await inL(() => treasuryService.position("2026-06-30"));
    expect([live.totalCash, live.reconciliation.reconciles]).toEqual([20000, true]);
  });

  it("🔴 defence in depth — a plan that reached a reversed bill (PLANTED: possible under 0114) is read as owing nothing, covers nothing, is flagged, cannot be approved, and can be cancelled", async () => {
    const planted = await plant(
      `INSERT INTO scheduled_payments (organization_id, company_id, bill_id, planned_date, amount, status) VALUES ($1,$2,$3,$4,7000,'planned') RETURNING id`,
      [orgR, coR, ids.R77, d(5)]);
    const pid = Number(planted.id);
    const list = await inR(() => paymentPlansService.list({}));
    expect(list.find((p) => p.id === pid)).toMatchObject({ billOutstanding: 0, billReversed: true, exceedsOutstanding: true });
    // movement: the current bill's plan in the same list is NOT flagged
    expect(list.find((p) => p.id === ids.RplanCur)).toMatchObject({ billOutstanding: 1000, billReversed: false, exceedsOutstanding: false });

    const f = await inR(() => treasuryService.forecast());
    expect(f.rows.some((r) => r.source.type === "scheduled_payment" && r.source.id === pid)).toBe(false);
    expect(f.planFlags.find((x) => x.planId === pid)).toEqual({ planId: pid, covered: 0, exceedsOutstanding: true, billReversed: true });
    expect(f.liquidity.committed).toBe(0);

    const e = await refusal(inR(() => paymentPlansService.approve(pid, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([409, "opening_item_reversed"]);
    const db = await refusal(pool.query(`UPDATE scheduled_payments SET status = 'approved', approved_at = now(), approved_by = $2 WHERE id = $1`, [pid, userId]));
    expect(db.constraint).toBe("scheduled_payment_bill_reversed");
    const cancelled = await inR(() => paymentPlansService.cancel(pid, { reason: "its bill was reversed with the migration" }, userId));
    expect(cancelled.status).toBe("cancelled");
  });

  it("🔴 defence in depth — a payment row on a reversed bill (PLANTED) never surfaces in the WHT exception list or counts; the current payment does", async () => {
    await plant(`INSERT INTO bill_payments (organization_id, company_id, bill_id, amount, paid_at) VALUES ($1,$2,$3,250,$4) RETURNING id`, [orgR, coR, ids.R78, today]);
    const ex = await inR(() => taxRepository.exceptions("undeclared"));
    expect(ex.map((r) => [r.document, Number(r.amount)])).toEqual([[expect.stringMatching(/^ORV-B-/), 600]]);
    expect(ex[0]!.total).toBe(1);
    // the predicate is what excludes it: the same row is visible to a read that omits it (the probe can see)
    const raw = (await pool.query(`SELECT count(*)::int n FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id WHERE bp.company_id = $1 AND b.bill_number = 'BILL-78'`, [coR])).rows[0].n;
    expect(raw).toBe(1);
  });
});
