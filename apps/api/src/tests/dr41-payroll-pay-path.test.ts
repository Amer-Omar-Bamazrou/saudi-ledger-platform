/**
 * 🔴 DR-41 / DR-39 — REGRESSION (Phase 18, owner decision 2.9; DR-41 HIGH).
 *
 * Salaries are expensed ONCE — by the run's approval. Paying them settles
 * SALARIES_PAYABLE and never touches SALARIES again, through either door:
 *  - the PAY PATH (`POST /payroll/:id/pay`): Dr Salaries Payable / Cr the bank,
 *    one payment per run, refused when the payable no longer owes the net;
 *  - the SALARY BANK LINE: in a company that runs payroll it is suggested
 *    against SALARIES_PAYABLE while the payable can absorb it, otherwise not at
 *    all (never the expense); a company without payroll keeps today's
 *    suggestion (the bank line IS its salary expense).
 * Also: the run's period is validated (YYYY-MM). The accrual DATE is not
 * changed (AQ-7, open).
 *
 * The Batch 4B/S1 proof `phase18-s1-dr41-payroll-double-count.test.ts` lands
 * beside this file (its premise 2 amended with the owner's approval).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3205";
process.env.SESSION_SECRET ??= "dr41-payroll-pay-path-regression-000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { payrollRepository } from "../repositories/payroll.repository";
import { payrollService } from "../services/payroll.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "DR41RegressionPw123!";

describeMaybe("DR-41 / DR-39 — salaries are expensed once; paying them settles the payable", () => {
  const h = g04Harness("dr41reg");
  let orgId = "";
  let coA = "";
  let coB = "";
  let otherOrgId = "";
  let adminId = 0;
  let bankId = 0;
  let otherBankId = 0;
  let seq = 0;

  /** A company's GL balance of an account (debit − credit), in the books. */
  const glDr = async (company: string, code: string) => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.company_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [company, code],
  )).rows[0].v);
  const bankGl = async (bank: number) => Number((await pool.query(
    `SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text AS v FROM journal_line_bank_identity v
       JOIN journal_entries e ON e.id = v.journal_entry_id WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bank],
  )).rows[0].v);
  const entries = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);

  async function approvedRun(period: string) {
    const created = await h.api("bookkeeper", "POST", "/payroll", { period });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as number;
    expect((await h.api("admin", "POST", `/payroll/${id}/approve`, {})).status).toBe(200);
    const r = (await pool.query(`SELECT (total_basic_salary + total_allowances)::text AS g, total_net_pay::text AS n FROM payroll_runs WHERE id = $1`, [id])).rows[0];
    return { id, gross: Number(r.g), net: Number(r.n) };
  }
  /** Upload salary lines (auto-categorised) and read back each line's suggestion. */
  async function salaryLines(who: string, bank: number, amounts: number[]) {
    const descs = amounts.map(() => `SALARY PAYMENT DR41REG ${++seq}`);
    const up = await h.api(who, "POST", "/transactions/upload", {
      rows: amounts.map((amount, i) => ({ date: "2026-10-05", description: descs[i], amount, currency: "SAR", type: "debit" })),
      autoCategrize: true, bankAccountId: bank,
    });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    return Promise.all(descs.map(async (d) => (await pool.query(
      `SELECT t.id, t.review_status, t.confidence_score::text AS confidence, c.system_code FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.description = $1`, [d],
    )).rows[0]));
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    coA = await h.mkCompany(orgId, "DR41 Co A", "318181818181887");
    await new Promise((r) => setTimeout(r, 20)); // company A is the org's FIRST company: the one a request acts in
    coB = await h.mkCompany(orgId, "DR41 Co B", "318181818181888");
    otherOrgId = await h.mkOrg("other");
    await h.mkCompany(otherOrgId, "DR41 Other Co", "318181818181889");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.mkUser("otheradmin", PW, otherOrgId, "admin");
    for (const [org, co, n] of [[orgId, coA, "A"], [orgId, coB, "B"]] as const) {
      await pool.query(`INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, housing_allowance, transport_allowance, other_allowances, status)
                        VALUES ($1,$2,$3,$4,'IN',8000,1500,500,0,'active')`, [org, co, `DR41-E-${n}`, `DR41 Employee ${n}`]);
    }
    await h.start();
    for (const who of ["admin", "bookkeeper", "otheradmin"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const b = await h.api("admin", "POST", "/bank-accounts", { name: "DR41 Payroll Bank", bankName: "SNB", currency: "SAR" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    bankId = b.body.id;
    const ob = await h.api("otheradmin", "POST", "/bank-accounts", { name: "DR41 Other Bank", bankName: "SNB", currency: "SAR" });
    expect(ob.status, JSON.stringify(ob.body)).toBe(201);
    otherBankId = ob.body.id;
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("the run's PERIOD is validated: a month (YYYY-MM), never free text", async () => {
    for (const bad of ["2026-13", "September", "2026-9", ""]) {
      expect((await h.api("bookkeeper", "POST", "/payroll", { period: bad })).status, `period ${JSON.stringify(bad)}`).toBe(400);
    }
  }, 60_000);

  it("CONTROL: a company that does NOT run payroll keeps today's suggestion — a salary line is its salary expense", async () => {
    const [line] = await salaryLines("otheradmin", otherBankId, [7_000]);
    expect([line.system_code, Number(line.confidence) >= 0.7]).toEqual(["SALARIES", true]);
  }, 60_000);

  it("🔴 the PAY PATH settles the payable and never touches SALARIES: Dr Salaries Payable / Cr the bank; one payment per run", async () => {
    const run = await approvedRun("2026-08");
    expect(await glDr(coA, "SALARIES")).toBe(run.gross);
    const bank0 = await bankGl(bankId);
    const noBank = await h.api("admin", "POST", `/payroll/${run.id}/pay`, {});
    expect(noBank.status, "the bank is named (D-3)").toBe(400);
    const paid = await h.api("admin", "POST", `/payroll/${run.id}/pay`, { bankAccountId: bankId, paidAt: "2026-09-01" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.status).toBe("paid");
    expect(await glDr(coA, "SALARIES"), "salaries expensed ONCE, by the approval").toBe(run.gross);
    expect(await glDr(coA, "SALARIES_PAYABLE"), "the payable is settled").toBe(0);
    expect(await bankGl(bankId) - bank0, "the bank moved by the net, once").toBe(-run.net);
    const e0 = await entries();
    const again = await h.api("admin", "POST", `/payroll/${run.id}/pay`, { bankAccountId: bankId });
    expect([again.status, again.body?.code]).toEqual([409, "payroll_already_paid"]);
    expect(await entries(), "a refused payment writes nothing").toBe(e0);
    // nothing is owed now: a salary line for this run is NOT suggested at all — neither the expense nor the payable
    const [line] = await salaryLines("bookkeeper", bankId, [run.net]);
    expect([line.review_status, line.system_code]).toEqual(["pending_review", null]);
    await pool.query(`DELETE FROM transactions WHERE id = $1`, [line.id]); // leave the next test a clean payable
  }, 60_000);

  it("🔴 a draft run cannot be paid; a run whose salary line is already waiting against the payable cannot be paid twice over", async () => {
    const draft = await h.api("bookkeeper", "POST", "/payroll", { period: "2026-07" });
    expect(draft.status).toBe(201);
    const r1 = await h.api("admin", "POST", `/payroll/${draft.body.id}/pay`, { bankAccountId: bankId });
    expect([r1.status, r1.body?.code]).toEqual([409, "payroll_not_approved"]);
    await h.api("admin", "POST", `/payroll/${draft.body.id}/reject`, {});
    const run = await approvedRun("2026-09");
    const [line] = await salaryLines("bookkeeper", bankId, [run.net]);
    expect(line.system_code, "the line is suggested against the payable").toBe("SALARIES_PAYABLE");
    const e0 = await entries();
    const r2 = await h.api("admin", "POST", `/payroll/${run.id}/pay`, { bankAccountId: bankId });
    expect([r2.status, r2.body?.code]).toEqual([409, "payroll_payable_already_settled"]);
    expect(await entries(), "refused: nothing written").toBe(e0);
    expect((await pool.query(`SELECT status FROM payroll_runs WHERE id = $1`, [run.id])).rows[0].status).toBe("approved");
    // accepting the line pays the run through the bank-line door instead: the payable is settled, the expense untouched
    const salaries0 = await glDr(coA, "SALARIES");
    expect((await h.api("bookkeeper", "POST", "/transactions/review/accept", {})).status).toBe(200);
    expect(await glDr(coA, "SALARIES")).toBe(salaries0);
    expect(await glDr(coA, "SALARIES_PAYABLE")).toBe(0);
  }, 60_000);

  it("🔴 two salary lines in one upload: only what the payable can absorb is suggested against it — the rest is not suggested at all", async () => {
    const run = await approvedRun("2026-10");
    const [first, second] = await salaryLines("bookkeeper", bankId, [run.net, run.net]);
    expect([first.system_code, second.system_code]).toEqual(["SALARIES_PAYABLE", null]);
    await pool.query(`DELETE FROM transactions WHERE id = ANY($1::int[])`, [[first.id, second.id]]);
  }, 60_000);

  it("🔴 ISOLATION within one organisation: company A's payroll never changes company B's suggestion (presence, absence, movement)", async () => {
    const inA = await h.inTenant(orgId, coA, adminId, () => payrollRepository.salaryPayableContext());
    const inB = await h.inTenant(orgId, coB, adminId, () => payrollRepository.salaryPayableContext());
    expect(inA.usesPayroll, "presence: A runs payroll").toBe(true);
    expect(inA.openPayable, "presence: A owes its October net").toBeGreaterThan(0);
    expect(inB, "absence: B sees none of A's payroll").toEqual({ usesPayroll: false, openPayable: 0 });
    // movement: B's OWN approved run moves B alone
    const runB = await h.inTenant(orgId, coB, adminId, () => payrollService.create({ period: "2026-10" }, adminId));
    await h.inTenant(orgId, coB, adminId, () => payrollService.approve(runB.id, adminId));
    const inB2 = await h.inTenant(orgId, coB, adminId, () => payrollRepository.salaryPayableContext());
    expect(inB2.usesPayroll).toBe(true);
    expect(inB2.openPayable).toBe(Number(runB.totalNetPay));
    expect(await h.inTenant(orgId, coA, adminId, () => payrollRepository.salaryPayableContext()), "A is unchanged by B's run").toEqual(inA);
  }, 60_000);
});
