/**
 * ACCOUNTANT Q1 (2026-10-05) — CORRECTING A WHT-BEARING PAYMENT, on real rows.
 * Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §14.1.
 *
 * Reversal + re-entry: the original payment and withholding never change; a
 * correction mirrors the payment's entry and records why/who/when and the
 * month whose return carries it; the corrected payment is a NEW payment
 * through the same pay path, linked both ways. Before the month is filed the
 * correction lands in that month's return; after filing, a filed return is
 * never rewritten silently — the person chooses subsequent period or
 * amendment.
 *
 * Every figure is checked three ways: the GL (W1, exact), the WHT ledger's
 * return (`monthlyReturn`) and the database's own definition of a month's
 * return (`wht_return_tax()`), which the remittance cap and the filing
 * snapshot read.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { supplierStatementService } from "../services/accounting/supplierStatement.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { reportsService } from "../services/reports.service";
import { whtService } from "../services/tax/wht.service";
import { whtCorrectionService } from "../services/tax/whtCorrection.service";
import { GetWhtReturnResponse, GetWhtWithholdingLineageResponse, GetWhtOverviewResponse } from "@workspace/api-zod";
import { expectConforms } from "./helpers/conforms";
import { businessToday } from "@workspace/shared";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-wht-correction] no real DATABASE_URL — skipping.");

describeMaybe("Q1 — correcting a WHT-bearing payment: reversal + re-entry, the filed return never rewritten silently", () => {
  const SLUG = "q1-whtc", SLUG_C = "q1-whtc-c", EMAIL = "q1-whtc@test.local";
  let orgId = "", orgC = "", coA = "", coB = "", coC = "", userId = 0;
  let bankA = 0;
  const v: Record<string, number> = {};
  let seq = 0;

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
    try { await p; } catch (e) { return e as { statusCode?: number; payload?: { code?: string; error?: string }; message: string; constraint?: string }; }
    throw new Error("expected a refusal");
  };
  const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;
  const glCredit = async (co: string, code: string) =>
    Number((await q(`SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text v FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.company_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [co, code]))[0].v);
  const bankGl = async (bank: number) =>
    Number((await q(`SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text v FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id
        WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bank]))[0].v);
  const dbReturnTax = async (co: string, period: string) => Number((await q(`SELECT wht_return_tax($1, $2)::text t`, [co, period]))[0].t);
  const counts = async () => (await q(`SELECT (SELECT count(*)::int FROM journal_entries WHERE organization_id = $1) je,
      (SELECT count(*)::int FROM wht_corrections WHERE organization_id = $1) corr,
      (SELECT count(*)::int FROM wht_withholdings WHERE organization_id = $1) w,
      (SELECT count(*)::int FROM bill_payments WHERE organization_id = $1) bp`, [orgId]))[0];
  const bill = async (inX: <T>(fn: () => Promise<T>) => Promise<T>, vendorId: number, net: number, date: string) => {
    const draft = await inX(() => billsService.create({
      supplierDocumentKind: "tax_invoice", vendorReference: `Q1-${++seq}`, billNumber: `Q1C-${seq}`, date, dueDate: date, vendorId,
      items: [{ description: "Services", quantity: 1, unitPrice: net, vatRate: 0 }],
    }, userId)) as { id: number };
    return (await inX(() => billsService.approve(draft.id, {}, userId)) as { id: number }).id;
  };
  const payA = (billId: number, amount: number, paidAt: string, extra: Record<string, unknown> = {}) =>
    inA(() => billsService.pay(billId, { amount, paidAt, bankAccountId: bankA, ...extra }, userId));
  const whtOfBill = async (billId: number) => (await q(`SELECT * FROM wht_withholdings WHERE bill_id = $1 ORDER BY id`, [billId]));
  const owes = async (billId: number) => Number((await q(`SELECT (total - coalesce(paid_amount,0))::text o FROM bills WHERE id = $1`, [billId]))[0].o);
  const w1 = async () => (await inA(() => whtService.overview())).reconciliation;

  beforeAll(async () => {
    await cleanup();
    orgId = (await q(`INSERT INTO organizations (name, slug, verification_status) VALUES ('Q1 WHTC','${SLUG}','approved') RETURNING id`))[0].id;
    coA = (await q(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'Q1 A',1,'gregorian') RETURNING id`, [orgId]))[0].id;
    await new Promise((r) => setTimeout(r, 20));
    coB = (await q(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'Q1 B',1,'gregorian') RETURNING id`, [orgId]))[0].id;
    orgC = (await q(`INSERT INTO organizations (name, slug, verification_status) VALUES ('Q1 WHTC C','${SLUG_C}','approved') RETURNING id`))[0].id;
    coC = (await q(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'Q1 C',1,'gregorian') RETURNING id`, [orgC]))[0].id;
    userId = (await q(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','Q1',' ','admin',true) RETURNING id`))[0].id;
    for (const o of [orgId, orgC]) await q(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    bankA = (await q(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Q1 Bank A','Riyad') RETURNING id`, [orgId, coA]))[0].id;
    await q(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Q1 Bank B','Riyad')`, [orgId, coB]);
    await q(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Q1 Bank C','Riyad')`, [orgC, coC]);
    const vendor = async (org: string, name: string, type: string | null, residency = "non_resident") =>
      (await q(`INSERT INTO vendors (organization_id, name, residency, wht_default_payment_type, country, foreign_tax_id) VALUES ($1,$2,$3,$4,'GB','GB-1') RETURNING id`, [org, name, residency, type]))[0].id as number;
    v.tech = await vendor(orgId, "Q1 London Tech", "technical_consulting");
    v.other = await vendor(orgId, "Q1 Dublin Licences", "royalty");
    v.res = await vendor(orgId, "Q1 Riyadh Trading", null, "resident");
    v.techC = await vendor(orgC, "Q1 C Tech", "technical_consulting");
  }, 180_000);
  afterAll(cleanup);

  it("🔴 WRONG RATE (unfiled month): reversed and re-entered as a royalty — the original stays, the return carries the corrected figure, W1 exact, the bank is the true cash", async () => {
    const b = await bill(inA, v.tech!, 10_000, "2026-06-01");
    const bank0 = await bankGl(bankA);
    await payA(b, 10_000, "2026-06-10"); // technical consulting 5 % → 500 withheld, 9,500 paid
    const [orig] = await whtOfBill(b);
    const origEntryLines = await q(`SELECT account_id, debit_amount::text, credit_amount::text, vendor_id FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY id`, [orig.journal_entry_id]);
    const out = await inA(() => whtCorrectionService.correct(orig.id, {
      reason: "nature was a royalty, not a consulting fee", date: "2026-06-20",
      reentry: { amount: 10_000, paidAt: "2026-06-10", whtPaymentType: "royalty" },
    }, userId));
    // the lineage: original → reversal → corrected
    expect(out.correction).toMatchObject({ reversalReturnPeriod: "2026-06", filedMonthTreatment: null, originalFilingId: null, remittedAtCorrection: 0 });
    expect(out.reentry).toMatchObject({ paymentType: "royalty", whtAmount: 1_500, reentryOfCorrectionId: out.correction!.id, returnPeriod: "2026-06" });
    expect(out.withholding.correction).toMatchObject({ id: out.correction!.id, correctedWithholdingId: out.reentry!.id });
    const back = await inA(() => whtCorrectionService.lineage(out.reentry!.id));
    expect(back.corrects?.id, "the re-entry names the original it corrects").toBe(orig.id);
    // 🔴 the ORIGINAL is unchanged — the row, and its entry's lines; only its entry is marked reversed beside the mirror
    expect((await q(`SELECT * FROM wht_withholdings WHERE id = $1`, [orig.id]))[0]).toEqual(orig);
    expect(await q(`SELECT account_id, debit_amount::text, credit_amount::text, vendor_id FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY id`, [orig.journal_entry_id])).toEqual(origEntryLines);
    expect((await q(`SELECT status FROM journal_entries WHERE id = $1`, [orig.journal_entry_id]))[0].status).toBe("reversed");
    // the June return: the original corrected out, the re-entry in; = the database's definition
    const ret = await inA(() => whtService.monthlyReturn("2026-06"));
    expect(ret.corrected.map((r) => r.id)).toContain(orig.id);
    expect(ret.schedule.map((r) => r.id)).toContain(out.reentry!.id);
    expect(ret.schedule.map((r) => r.id)).not.toContain(orig.id);
    expect(ret.totals.taxWithheld).toBe(await dbReturnTax(coA, "2026-06"));
    expect(ret.lines.find((l) => l.paymentType === "royalty")!.taxWithheld).toBe(1_500);
    // the GL: W1 exact; the bank paid the TRUE cash (8,500), the bill is settled once
    expect(await w1()).toMatchObject({ reconciles: true });
    expect(await bankGl(bankA) - bank0).toBeCloseTo(-8_500, 2);
    expect(await owes(b)).toBe(0);
    expectConforms(GetWhtReturnResponse, ret, "GET /tax/wht/returns/:period (corrected + re-entry)");
    expectConforms(GetWhtWithholdingLineageResponse, out, "POST /tax/wht/withholdings/:id/reverse");
  });

  it("WRONG AMOUNT: 10,000 recorded where 1,000 was paid — re-entered at 1,000; the bill owes the rest again", async () => {
    const b = await bill(inA, v.tech!, 10_000, "2026-06-02");
    await payA(b, 10_000, "2026-06-11");
    const [orig] = await whtOfBill(b);
    const out = await inA(() => whtCorrectionService.correct(orig.id, { reason: "typed ten thousand for one thousand", date: "2026-06-21", reentry: { amount: 1_000, paidAt: "2026-06-11" } }, userId));
    expect([out.reentry!.baseAmount, out.reentry!.whtAmount]).toEqual([1_000, 50]);
    expect(await owes(b)).toBe(9_000);
    expect((await q(`SELECT status FROM bills WHERE id = $1`, [b]))[0].status, "paid → owing again").not.toBe("paid");
    expect(await w1()).toMatchObject({ reconciles: true });
  });

  it("WRONG SUPPLIER: paid against supplier X's bill, really supplier Y's — the correction re-enters against Y's bill; X's bill owes again", async () => {
    const bx = await bill(inA, v.tech!, 4_000, "2026-06-03");
    const by = await bill(inA, v.other!, 4_000, "2026-06-03");
    await payA(bx, 4_000, "2026-06-12");
    const [orig] = await whtOfBill(bx);
    const out = await inA(() => whtCorrectionService.correct(orig.id, { reason: "paid to the wrong supplier's bill", date: "2026-06-22", reentry: { billId: by, amount: 4_000, paidAt: "2026-06-12" } }, userId));
    expect([out.reentry!.vendorId, out.reentry!.paymentType, out.reentry!.whtAmount]).toEqual([v.other, "royalty", 600]);
    expect([await owes(bx), await owes(by)]).toEqual([4_000, 0]);
    expect(await w1()).toMatchObject({ reconciles: true });
  });

  it("WRONG PAYMENT DATE: dated 28 July, paid 2 August — the July return loses it, the August return carries the re-entry", async () => {
    const b = await bill(inA, v.tech!, 2_000, "2026-07-01");
    await payA(b, 2_000, "2026-07-28");
    const [orig] = await whtOfBill(b);
    const julyBefore = await dbReturnTax(coA, "2026-07"), augBefore = await dbReturnTax(coA, "2026-08");
    const out = await inA(() => whtCorrectionService.correct(orig.id, { reason: "the transfer left on 2 August", date: "2026-08-03", reentry: { amount: 2_000, paidAt: "2026-08-02" } }, userId));
    expect(out.correction!.reversalReturnPeriod, "unfiled: the reversal is reported in the original's own month").toBe("2026-07");
    expect([await dbReturnTax(coA, "2026-07") - julyBefore, await dbReturnTax(coA, "2026-08") - augBefore]).toEqual([-100, 100]);
    expect(out.reentry!.returnPeriod).toBe("2026-08");
  });

  it("WRONG WHT CATEGORY: withheld as consulting, really goods — re-entered NOT SUBJECT; the month's tax falls by the original's", async () => {
    const b = await bill(inA, v.tech!, 3_000, "2026-06-04");
    await payA(b, 3_000, "2026-06-13");
    const [orig] = await whtOfBill(b);
    const before = await dbReturnTax(coA, "2026-06");
    const out = await inA(() => whtCorrectionService.correct(orig.id, { reason: "these were spare parts — goods", date: "2026-06-23", reentry: { amount: 3_000, paidAt: "2026-06-13", whtNotSubjectReason: "goods" } }, userId));
    expect([out.reentry!.status, out.reentry!.notSubjectReason, out.reentry!.whtAmount]).toEqual(["not_subject", "goods", 0]);
    expect(await dbReturnTax(coA, "2026-06") - before).toBe(-150);
    expect(await w1()).toMatchObject({ reconciles: true });
  });

  it("🔴 FILED month, SUBSEQUENT PERIOD: refused without a treatment; with it, the filed May return is untouched and September carries −old +new", async () => {
    const b = await bill(inA, v.tech!, 8_000, "2026-05-01");
    await payA(b, 8_000, "2026-05-10");
    const [orig] = await whtOfBill(b);
    const filed = await inA(() => whtService.fileReturn("2026-05", { filedOn: "2026-06-05", zatcaReference: "WHT-0526-001" }, userId));
    expect([filed.filing.status, filed.filing.latest!.taxWithheld]).toEqual(["filed", filed.totals.taxWithheld]);
    expect(filed.filing.latest!.taxWithheld, "the snapshot is the ledger's own figure").toBe(await dbReturnTax(coA, "2026-05"));
    const before = await counts();
    const e = await refusal(inA(() => whtCorrectionService.correct(orig.id, { reason: "royalty, not consulting", date: "2026-09-10", reentry: { amount: 8_000, paidAt: "2026-05-10", whtPaymentType: "royalty" } }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([409, "wht_month_filed"]);
    expect(await counts(), "refused: nothing written").toEqual(before);
    const septBefore = await dbReturnTax(coA, "2026-09");
    const out = await inA(() => whtCorrectionService.correct(orig.id, { reason: "royalty, not consulting", date: "2026-09-10", filedMonthTreatment: "subsequent_period", reentry: { amount: 8_000, paidAt: "2026-05-10", whtPaymentType: "royalty" } }, userId));
    expect(out.correction).toMatchObject({ reversalReturnPeriod: "2026-09", filedMonthTreatment: "subsequent_period", originalFilingId: filed.filing.latest!.id });
    expect([out.reentry!.returnPeriod, out.reentry!.filedMonthTreatment, out.reentry!.paymentDate]).toEqual(["2026-09", "subsequent_period", "2026-05-10"]);
    const may = await inA(() => whtService.monthlyReturn("2026-05"));
    expect([may.filing.status, may.totals.taxWithheld], "the filed return is NOT rewritten").toEqual(["filed", filed.totals.taxWithheld]);
    expect(may.schedule.map((s) => s.id), "the original stays on the return as filed").toContain(orig.id);
    const sept = await inA(() => whtService.monthlyReturn("2026-09"));
    expect(sept.adjustments.map((a) => [a.withholdingId, a.whtAmount, a.originalReturnPeriod])).toContainEqual([orig.id, -400, "2026-05"]);
    expect(sept.schedule.map((s) => s.id)).toContain(out.reentry!.id);
    expect(await dbReturnTax(coA, "2026-09") - septBefore).toBe(1_200 - 400);
    expect(sept.totals.taxWithheld).toBe(await dbReturnTax(coA, "2026-09"));
    expect(await w1()).toMatchObject({ reconciles: true });
    expectConforms(GetWhtReturnResponse, sept, "GET /tax/wht/returns/:period (adjustments)");
  });

  it("🔴 FILED month, AMENDMENT: April's live return changes, reads AMENDMENT DUE beside the filed figure, and reads AMENDED once the amendment is recorded", async () => {
    const b = await bill(inA, v.tech!, 6_000, "2026-04-01");
    await payA(b, 6_000, "2026-04-10");
    const [orig] = await whtOfBill(b);
    const filed = await inA(() => whtService.fileReturn("2026-04", { filedOn: "2026-05-08", zatcaReference: "WHT-0426-001" }, userId));
    await inA(() => whtCorrectionService.correct(orig.id, { reason: "management fee, not consulting", date: "2026-09-11", filedMonthTreatment: "amendment", reentry: { amount: 6_000, paidAt: "2026-04-10", whtPaymentType: "management_fee" } }, userId));
    const apr = await inA(() => whtService.monthlyReturn("2026-04"));
    expect([apr.filing.status, apr.filing.latest!.taxWithheld, apr.totals.taxWithheld]).toEqual(["amendment_due", filed.totals.taxWithheld, filed.totals.taxWithheld - 300 + 1_200]);
    expect((await inA(() => whtService.overview())).months.find((m) => m.period === "2026-04")!.filingStatus).toBe("amendment_due");
    const amended = await inA(() => whtService.fileReturn("2026-04", { filedOn: "2026-09-12", zatcaReference: "WHT-0426-AMD1" }, userId));
    expect([amended.filing.status, amended.filing.filings.map((f) => f.kind), amended.filing.latest!.amendsFilingId]).toEqual(["amended", ["original", "amendment"], filed.filing.latest!.id]);
    expect(amended.filing.filings[0]!.taxWithheld, "the ORIGINAL filing is preserved as filed").toBe(filed.totals.taxWithheld);
  });

  it("🔴 REMITTED month: correcting a remitted withholding records the state (remitted at correction) and leaves the month in CREDIT — never netted elsewhere, no further remittance", async () => {
    const b = await bill(inA, v.other!, 10_000, "2026-03-01");
    await payA(b, 10_000, "2026-03-10"); // royalty 15 % → 1,500
    const [orig] = await whtOfBill(b);
    await inA(() => whtService.remit("2026-03", { bankAccountId: bankA, paidAt: "2026-04-08", reference: "SADAD-0326" }, userId));
    const out = await inA(() => whtCorrectionService.correct(orig.id, { reason: "rent of equipment, not a royalty", date: "2026-04-20", reentry: { amount: 10_000, paidAt: "2026-03-10", whtPaymentType: "rent" } }, userId));
    expect(out.correction!.remittedAtCorrection, "the REMITTED state, written by the database").toBe(1_500);
    const mar = await inA(() => whtService.monthlyReturn("2026-03"));
    expect([mar.totals.taxWithheld, mar.totals.remitted, mar.totals.outstanding, mar.status]).toEqual([500, 1_500, -1_000, "credit"]);
    expect((await refusal(inA(() => whtService.remit("2026-03", { bankAccountId: bankA, paidAt: "2026-04-21" }, userId)))).payload?.code).toBe("wht_nothing_to_remit");
    expect(await w1()).toMatchObject({ reconciles: true });
    expect(await glCredit(coA, "WHT_PAYABLE")).toBe((await w1()).glWhtPayable);
  });

  it("🔴 ALREADY CORRECTED, DOUBLE-CLICK, CONCURRENT: one correction per withholding — a replay returns it, a second is refused, a race has one winner", async () => {
    const b = await bill(inA, v.tech!, 1_000, "2026-02-01");
    await payA(b, 1_000, "2026-02-10");
    const [orig] = await whtOfBill(b);
    const body = { reason: "the second of two identical entries", date: "2026-02-15", idempotencyKey: "q1-double-click" };
    const first = await inA(() => whtCorrectionService.correct(orig.id, body, userId));
    const replay = await inA(() => whtCorrectionService.correct(orig.id, body, userId));
    expect([first.replayed, replay.replayed, replay.correction!.id]).toEqual([false, true, first.correction!.id]);
    const again = await refusal(inA(() => whtCorrectionService.correct(orig.id, { reason: "a second attempt at it", date: "2026-02-16" }, userId)));
    expect([again.statusCode, again.payload?.code]).toEqual([409, "wht_already_corrected"]);
    expect(Number((await q(`SELECT count(*)::int n FROM wht_corrections WHERE withholding_id = $1`, [orig.id]))[0].n)).toBe(1);
    // concurrent: two transactions, two keys, at once — the advisory lock serialises them; the loser is refused by name
    const b2 = await bill(inA, v.tech!, 1_000, "2026-02-02");
    await payA(b2, 1_000, "2026-02-11");
    const [o2] = await whtOfBill(b2);
    const results = await Promise.allSettled([
      inA(() => whtCorrectionService.correct(o2.id, { reason: "racing correction number one", date: "2026-02-17", idempotencyKey: "race-1" }, userId)),
      inA(() => whtCorrectionService.correct(o2.id, { reason: "racing correction number two", date: "2026-02-17", idempotencyKey: "race-2" }, userId)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as { payload?: { code?: string } }).payload?.code).toBe("wht_already_corrected");
    expect(Number((await q(`SELECT count(*)::int n FROM wht_corrections WHERE withholding_id = $1`, [o2.id]))[0].n)).toBe(1);
    expect(await w1()).toMatchObject({ reconciles: true });
  });

  it("🔴 PERIOD LOCK: a correction dated in a closed month, or a re-entry into one, is refused — and writes NOTHING", async () => {
    const b = await bill(inA, v.tech!, 1_000, "2026-01-02");
    await payA(b, 1_000, "2026-01-12");
    const [orig] = await whtOfBill(b);
    await q(`INSERT INTO period_locks (organization_id, company_id, period, locked_by, notes) VALUES ($1,$2,'2026-01',$3,'Q1 test lock')`, [orgId, coA, userId]);
    const before = await counts();
    const e1 = await refusal(inA(() => whtCorrectionService.correct(orig.id, { reason: "dated inside the closed month", date: "2026-01-20" }, userId)));
    expect(e1.statusCode).toBe(423);
    const e2 = await refusal(inA(() => whtCorrectionService.correct(orig.id, { reason: "re-entry dated inside the closed month", date: "2026-02-20", reentry: { amount: 1_000, paidAt: "2026-01-12" } }, userId)));
    expect(e2.statusCode, "the re-entry's own pay path refuses the closed month — the whole correction rolls back").toBe(423);
    expect(await counts()).toEqual(before);
    expect((await q(`SELECT status FROM journal_entries WHERE id = $1`, [orig.journal_entry_id]))[0].status).toBe("posted");
    // dated in an open month, no re-entry into the closed one: allowed (the reversal posts in the open month)
    const ok = await inA(() => whtCorrectionService.correct(orig.id, { reason: "entered twice; reversed in February", date: "2026-02-20" }, userId));
    expect([ok.correction!.correctedOn, ok.reentry]).toEqual(["2026-02-20", null]);
  });

  it("🔴 a SUPPLIER payment: its own allocations are superseded by the same mirror, the money leaves on-account, the statement and AP reconcile on EVERY component; a touched payment is refused", async () => {
    const b = await bill(inA, v.tech!, 5_000, "2026-09-01");
    const pay = await inA(() => supplierPaymentsService.create({ vendorId: v.tech, bankAccountId: bankA, amount: 8_000, paidAt: "2026-09-02", classification: "advance", allocations: [{ billId: b, amount: 5_000 }] }, userId)) as { id: number };
    const [orig] = await q(`SELECT * FROM wht_withholdings WHERE supplier_payment_id = $1`, [pay.id]);
    expect(Number(orig.wht_amount)).toBe(400);
    const out = await inA(() => whtCorrectionService.correct(orig.id, {
      reason: "advance was for a licence (royalty)", date: "2026-09-05",
      reentry: { amount: 8_000, paidAt: "2026-09-02", classification: "advance", allocations: [{ billId: b, amount: 5_000 }], whtPaymentType: "royalty" },
    }, userId));
    expect([out.reentry!.whtAmount, out.reentry!.supplierPaymentId != null]).toEqual([1_200, true]);
    const original = await inA(() => supplierPaymentsService.getById(pay.id));
    expect([original.availableAmount, original.reversal?.correctionId]).toEqual([0, out.correction!.id]);
    expect(original.allocations.every((a) => a.reversed), "the original's own allocations are superseded").toBe(true);
    expect(await owes(b) - 0).toBe(5_000); // legacy counter untouched; billPosition is the one definition below
    expect(Number((await q(`SELECT (b.total - coalesce(b.paid_amount,0) - coalesce((SELECT sum(a.amount) FROM supplier_payment_allocations a WHERE a.bill_id = b.id AND NOT EXISTS (SELECT 1 FROM supplier_payment_allocation_reversals r WHERE r.allocation_id = a.id)),0))::text o FROM bills b WHERE b.id = $1`, [b]))[0].o), "the re-entry settles the bill once").toBe(0);
    const st = await inA(() => supplierStatementService.statement(v.tech!));
    expect(st.reconciliation.agrees, JSON.stringify(st.reconciliation)).toBe(true);
    expect(st.gl.agrees, JSON.stringify(st.gl)).toBe(true);
    expect(st.lines.map((l) => l.kind)).toContain("payment_reversal");
    // a reversed payment is history: nothing is allocated, reclassified or refunded on it
    expect((await refusal(inA(() => supplierPaymentsService.refund(pay.id, { amount: 1, bankAccountId: bankA, reason: "try" }, userId)))).payload?.code).toBe("supplier_payment_reversed");
    // a payment acted on since (a later allocation) is refused, not approximated
    const b2 = await bill(inA, v.tech!, 1_000, "2026-09-03");
    const p2 = await inA(() => supplierPaymentsService.create({ vendorId: v.tech, bankAccountId: bankA, amount: 2_000, paidAt: "2026-09-03", classification: "advance" }, userId)) as { id: number };
    await inA(() => supplierPaymentsService.allocate(p2.id, { allocations: [{ billId: b2, amount: 1_000 }], date: "2026-09-04" }, userId));
    const [w2] = await q(`SELECT id FROM wht_withholdings WHERE supplier_payment_id = $1`, [p2.id]);
    expect((await refusal(inA(() => whtCorrectionService.correct(w2.id, { reason: "would leave the allocation dangling", date: "2026-09-06" }, userId)))).payload?.code).toBe("wht_correction_payment_touched");
    expect(await w1()).toMatchObject({ reconciles: true });
  });

  it("🔴 the supplier statement after an ordinary ALLOCATION REVERSAL agrees on every component, and the as-of AP ageing ages the bill at what it owes (the defect found probing Q1)", async () => {
    const b = await bill(inA, v.res!, 1_000, "2026-08-01");
    const p = await inA(() => supplierPaymentsService.create({ vendorId: v.res, bankAccountId: bankA, amount: 500, paidAt: "2026-08-02", classification: "advance" }, userId)) as { id: number };
    await inA(() => supplierPaymentsService.allocate(p.id, { allocations: [{ billId: b, amount: 300 }], date: "2026-08-03" }, userId));
    const [alloc] = await q(`SELECT id FROM supplier_payment_allocations WHERE supplier_payment_id = $1`, [p.id]);
    await inA(() => supplierPaymentsService.reverseAllocation(alloc.id, { reason: "applied to the wrong bill", date: "2026-08-04" }, userId));
    const st = await inA(() => supplierStatementService.statement(v.res!));
    expect(st.reconciliation.components).toEqual({ payable: { fromPosition: 1_000, fromEvents: 1_000 }, credit: { fromPosition: 0, fromEvents: 0 }, onAccount: { fromPosition: 500, fromEvents: 500 } });
    expect(st.reconciliation.agrees).toBe(true);
    const aging = await inA(() => reportsService.apAging("2026-08-05"));
    expect(aging.items.find((i) => i.id === b)?.outstanding, "aged at what it owes, not 1,300").toBe(1_000);
  });

  it("🔴 the DATABASE keeps the record: the original and the correction cannot be edited or deleted; the mirror is not reversed generically; a filed month cannot be written silently", async () => {
    const [c] = await q(`SELECT * FROM wht_corrections WHERE organization_id = $1 ORDER BY id LIMIT 1`, [orgId]);
    const [w] = await q(`SELECT * FROM wht_withholdings WHERE id = $1`, [c.withholding_id]);
    expect((await refusal(pool.query(`UPDATE wht_withholdings SET wht_amount = 0 WHERE id = $1`, [w.id]))).constraint).toBe("wht_append_only");
    expect((await refusal(pool.query(`UPDATE wht_corrections SET reason = 'rewritten afterwards' WHERE id = $1`, [c.id]))).constraint).toBe("wht_correction_immutable");
    expect((await refusal(pool.query(`DELETE FROM wht_corrections WHERE id = $1`, [c.id]))).constraint).toBe("wht_append_only");
    expect((await refusal(pool.query(`UPDATE wht_return_filings SET tax_withheld = 0 WHERE organization_id = $1`, [orgId]))).constraint).toBe("wht_append_only");
    const e = await refusal(inA(() => journalEntriesService.reverse(c.reversal_journal_entry_id, { reason: "undo the correction" })));
    expect(e.message).toMatch(/itself the correction/);
    expect((await refusal(pool.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [c.reversal_journal_entry_id]))).constraint).toBe("journal_entries_tax_reversal_guard");
    // a withholding INTO a filed month with no treatment: refused by the pay path, and by the database for a caller that skips it
    const b = await bill(inA, v.tech!, 1_000, "2026-05-02");
    const before = await counts();
    const e2 = await refusal(payA(b, 1_000, "2026-05-15"));
    expect([e2.statusCode, e2.payload?.code]).toEqual([409, "wht_month_filed"]);
    expect(await counts()).toEqual(before);
    await payA(b, 1_000, "2026-05-15", { whtFiledMonthTreatment: "subsequent_period" });
    const [late] = await whtOfBill(b);
    expect([late.period, late.return_period, late.filed_month_treatment]).toEqual(["2026-05", businessToday().slice(0, 7), "subsequent_period"]); // reported in today's (unfiled) month
  });

  it("🔴 isolation — presence, absence, movement: another company and another organisation see none of A's corrections or filings, and cannot correct A's withholding", async () => {
    const aCorr = await q(`SELECT withholding_id FROM wht_corrections WHERE company_id = $1 LIMIT 1`, [coA]);
    expect(aCorr.length).toBe(1);
    const e = await refusal(inB(() => whtCorrectionService.correct(aCorr[0].withholding_id, { reason: "company B reaching into A", date: "2026-09-20" }, userId)));
    expect(e.statusCode).toBe(404);
    expect((await refusal(inC(() => whtCorrectionService.lineage(aCorr[0].withholding_id)))).statusCode).toBe(404);
    expect((await inB(() => whtService.monthlyReturn("2026-05"))).filing.filings).toEqual([]);
    expect((await inB(() => whtService.overview())).months).toEqual([]);
    // movement: C corrects its own; A does not see it
    const d = await inC(() => billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: "Q1C-C", billNumber: "Q1C-C-1", date: "2026-09-01", dueDate: "2026-09-01", vendorId: v.techC, items: [{ description: "x", quantity: 1, unitPrice: 2_000, vatRate: 0 }] }, userId)) as { id: number };
    const bc = (await inC(() => billsService.approve(d.id, {}, userId)) as { id: number }).id;
    const bankC = (await q(`SELECT id FROM bank_accounts WHERE company_id = $1`, [coC]))[0].id;
    await inC(() => billsService.pay(bc, { amount: 2_000, paidAt: "2026-09-08", bankAccountId: bankC }, userId));
    const [wc] = await whtOfBill(bc);
    await inC(() => whtCorrectionService.correct(wc.id, { reason: "C's own correction of its payment", date: "2026-09-09" }, userId));
    expect((await inC(() => whtService.monthlyReturn("2026-09"))).corrected.map((r) => r.id)).toEqual([wc.id]);
    expect((await inA(() => whtService.monthlyReturn("2026-09"))).corrected.map((r) => r.id)).not.toContain(wc.id);
    expectConforms(GetWhtOverviewResponse, await inA(() => whtService.overview()), "GET /tax/wht/overview (filing states, credit)");
  });
});
