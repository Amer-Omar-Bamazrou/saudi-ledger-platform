/**
 * 🔴 GOSI decisions 19, 21 and 22 (owner 2026-10-27 afternoon; decision 21's
 * scope corrected by the owner the same day; final-run memo §2 F). Each
 * DECIDED 2026-10-27, owner decision based on research, not a professional
 * opinion; reversible; to be reviewed before go-live.
 *
 *  - 22: the GOSI payment step accepts GOSI's INVOICED amount: the bank pays
 *    that, GOSI Payable is debited with it, and the difference from the accrued
 *    amount is SHOWN as a reconciling item on the run — never posted to an
 *    account the platform would have to guess.
 *  - 21: the SAR 400 occupational-hazards minimum (1421H Registration and
 *    Contributions Regulation Art. 19(1)) is for members outside the pension
 *    branch. Every employee whose law is recorded (1421H or 2024) is Saudi and
 *    a pension member, so no recorded employee is in its scope; a non-Saudi
 *    employee below SAR 400 gets a WARNING, never a refusal and never a changed
 *    figure, until GOSI answers in writing.
 *  - 19: the 1421H SANED split's source note names GOSI's news of 13/1/2022.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3243";
process.env.SESSION_SECRET ??= "phase18-gosi-decisions-21-22-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { GOSI_SCHEDULE } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18GosiDecisionsPw1!";
const r2 = (n: number) => Math.round(n * 100) / 100;

describe("GOSI decision 19 — the 1421H SANED split names its source", () => {
  it("🔴 the 1421H entry's sources include GOSI's news of 13/1/2022", () => {
    const entry = GOSI_SCHEDULE.find((e) => e.regime === "law_1421h")!;
    expect(entry.sources.some((s) => s.includes("news106en") && s.includes("13/1/2022"))).toBe(true);
  });
});

describeMaybe("GOSI decisions 21 and 22 — the invoiced amount reconciled; the SAR 400 hazards minimum warned, never applied", () => {
  const h = g04Harness("p18gosi22");
  let orgId = "";
  let bankId = 0;

  const employee = async (num: string, body: Record<string, unknown>) => {
    const res = await h.api("admin", "POST", "/employees", { employeeNumber: num, name: `GOSI D ${num}`, nationality: "SA", status: "active", ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };
  const approvedRun = async (period: string) => {
    const created = await h.api("admin", "POST", "/payroll", { period });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const approved = await h.api("admin", "POST", `/payroll/${created.body.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return { id: created.body.id as number, accrued: r2(Number(approved.body.totalGosiEmployee) + Number(approved.body.totalGosiEmployer)) };
  };
  const gosiPayable = async () => Number((await pool.query(
    `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::float AS owed FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND e.status IN ('posted', 'reversed') AND c.system_code = 'GOSI_PAYABLE'`, [orgId])).rows[0].owed);
  const paymentLines = async (runId: number) => (await pool.query(
    `SELECT coalesce(c.system_code, 'BANK') AS code, l.debit_amount::float AS dr, l.credit_amount::float AS cr FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.source_type = 'payroll_gosi_payment' AND e.source_id = $1 ORDER BY l.debit_amount DESC`, [runId])).rows;
  const items = async (runId: number) => (await pool.query(
    `SELECT e.employee_number AS num, to_jsonb(i.*) AS j FROM payroll_items i JOIN employees e ON e.id = i.employee_id
      WHERE i.payroll_run_id = $1 ORDER BY e.employee_number`, [runId])).rows
    .map(({ num, j }) => ({ num, er: Number(j.gosi_employer), wage: Number(j.gosi_wage_base), warned: j.gosi_hazards_floor_open as boolean | undefined }));

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "GOSI Decisions Co", "318181818181911");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "GOSI D Main", bankName: "GOSI D Bank", isDefault: true });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id;
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`UPDATE employees SET status = 'terminated' WHERE organization_id = $1`, [orgId]);
  });

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 22: GOSI's invoiced amount is paid; the difference from the accrual is shown on the run, and posted to no other account", async () => {
    await employee("R1", { basicSalary: 5_000, gosiRegime: "law_2024" });
    const run = await approvedRun("2026-08");
    const owedBefore = await gosiPayable();
    const invoiced = r2(run.accrued + 12.5);
    const paid = await h.api("admin", "POST", `/payroll/${run.id}/gosi/pay`, { bankAccountId: bankId, paidAt: "2026-09-10", invoicedAmount: invoiced, gosiInvoiceReference: "GOSI-INV-2026-08" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect({
      recorded: [paid.body.gosiInvoicedAmount, paid.body.gosiInvoiceReference, paid.body.gosiReconcilingDifference],
      entry: await paymentLines(run.id),
      payableAfter: r2(await gosiPayable() - owedBefore),
    }).toEqual({
      recorded: [invoiced, "GOSI-INV-2026-08", 12.5],
      entry: [{ code: "GOSI_PAYABLE", dr: invoiced, cr: 0 }, { code: "BANK", dr: 0, cr: invoiced }].map((x) => ({ ...x, code: x.code === "BANK" ? expect.any(String) : x.code })),
      payableAfter: r2(-invoiced),
    });
  });

  it("control 22: with no invoiced amount the accrual is paid, as before, and nothing is shown as a difference", async () => {
    await employee("R2", { basicSalary: 4_000, gosiRegime: "law_2024" });
    const run = await approvedRun("2026-09");
    const paid = await h.api("admin", "POST", `/payroll/${run.id}/gosi/pay`, { bankAccountId: bankId, paidAt: "2026-10-10" });
    const lines = await paymentLines(run.id);
    expect([paid.status, lines[0]?.dr, paid.body.gosiInvoicedAmount ?? null, paid.body.gosiReconcilingDifference ?? null], JSON.stringify(paid.body))
      .toEqual([200, run.accrued, null, null]);
  });

  it("🔴 22: an invoiced amount that is not a positive amount is refused, and nothing is paid", async () => {
    await employee("R3", { basicSalary: 3_000, gosiRegime: "law_2024" });
    const run = await approvedRun("2026-07");
    const zero = await h.api("admin", "POST", `/payroll/${run.id}/gosi/pay`, { bankAccountId: bankId, paidAt: "2026-08-10", invoicedAmount: 0 });
    expect([zero.status, zero.body.code, (await paymentLines(run.id)).length], JSON.stringify(zero.body)).toEqual([422, "gosi_invoiced_amount_invalid", 0]);
  });

  it("🔴 21: a non-Saudi employee below SAR 400 is WARNED — never refused, the hazards share unchanged; a recorded-law employee is not in the minimum's scope", async () => {
    await employee("W1-NS-300", { basicSalary: 300, nationality: "EG" });
    await employee("W2-NS-400", { basicSalary: 400, nationality: "EG" });
    await employee("W3-1421-300", { basicSalary: 300, gosiRegime: "law_1421h" });
    const created = await h.api("admin", "POST", "/payroll", { period: "2026-06" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const got = await items(created.body.id);
    const ns300 = got.find((x) => x.num === "W1-NS-300")!;
    expect([ns300.er, ns300.wage]).toEqual([r2(300 * 0.02), 300]);
    expect(got.map((x) => [x.num, x.warned])).toEqual([["W1-NS-300", true], ["W2-NS-400", false], ["W3-1421-300", false]]);
  });
});
