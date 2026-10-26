/**
 * 🔴 GOSI CONTRIBUTIONS (Phase 18, owner decision 2026-10-26 night, item 2; HIGH).
 *
 * The platform applied the 1421H-law rates (9.75% / 11.75%) to every Saudi
 * employee, on basic pay alone, with no ceiling, and had no way to pay GOSI
 * (register §11.19, GO-01..GO-06). This proof states the corrected rule through
 * the real API, each figure computed independently below:
 *  - the rate comes from the employee's LAW (stated by the employer) and the
 *    run's PERIOD; the wage is basic + housing, capped at SAR 45,000;
 *  - each payroll line records what it used;
 *  - an unstated law, or a period no rate covers, is refused — never guessed;
 *  - a run computed before the change is refused at approval until regenerated;
 *  - GOSI is paid from a bank (Dr GOSI Payable / Cr bank), once, never to the expense;
 *  - a GOSI bank line is never suggested as the expense while the run's GOSI is owed;
 *  - the obligations calendar dates GOSI to the 15th of the next month, with the
 *    uncapped 2%-per-month-or-part estimate when late.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3231";
process.env.SESSION_SECRET ??= "phase18-gosi-contributions-proof-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18GosiProofPw1!";

// Independent arithmetic (not imported from the code under test): rates as stated in research finding 3.
const r2 = (n: number) => Math.round(n * 100) / 100;
const LAW_2024 = { employee: 0.1075, employer: 0.1275 };
const LAW_1421H = { employee: 0.0975, employer: 0.1175 };
const NON_SAUDI = { employee: 0, employer: 0.02 };

describeMaybe("GOSI — the law, the period, the contributory wage; paid from a bank; dated", () => {
  const h = g04Harness("p18gosi");
  let orgId = "";
  let companyId = "";
  let bankId = 0;

  const gl = async (code: string) => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.company_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [companyId, code],
  )).rows[0].v);
  const employee = async (num: string, nationality: string, regime: string | null, basic: number, housing: number, status = "active") =>
    Number((await pool.query(
      `INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, housing_allowance, transport_allowance, other_allowances, status, gosi_regime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,300,0,$8,$9) RETURNING id`,
      [orgId, companyId, num, `GOSI Proof ${num}`, nationality, basic, housing, status, regime],
    )).rows[0].id);
  const items = async (runId: number) => (await pool.query(
    `SELECT e.employee_number AS num, i.gosi_employee::float8 AS emp, i.gosi_employer::float8 AS er, i.gosi_regime AS regime,
            i.gosi_wage_base::float8 AS wage, i.gosi_employee_rate::float8 AS emp_rate, i.gosi_employer_rate::float8 AS er_rate
       FROM payroll_items i JOIN employees e ON e.id = i.employee_id WHERE i.payroll_run_id = $1 ORDER BY e.employee_number`, [runId],
  )).rows;
  const runCount = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM payroll_runs WHERE organization_id = $1`, [orgId])).rows[0].n);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "GOSI Proof Co", "318181818181880");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    const b = await h.api("admin", "POST", "/bank-accounts", { name: "GOSI Proof Bank", bankName: "SNB", currency: "SAR" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    bankId = b.body.id;
  }, 120_000);

  beforeEach(async () => {
    // Each case sets up its own employees; payroll runs and their entries stay (append-only GL).
    await pool.query(`UPDATE employees SET status = 'terminated' WHERE organization_id = $1`, [orgId]);
  });

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 each line: the law's rate for the run's period, on basic + housing capped at SAR 45,000, and the line records what it used", async () => {
    await employee("G1-A-2024", "SA", "law_2024", 10_000, 2_500);   // wage 12,500
    await employee("G1-B-1421", "SA", "law_1421h", 50_000, 5_000);  // wage capped at 45,000
    await employee("G1-C-NON", "IN", null, 8_000, 2_000);           // wage 10,000, employer 2% only
    const run = await h.api("admin", "POST", "/payroll", { period: "2026-10" });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(await items(run.body.id)).toEqual([
      { num: "G1-A-2024", emp: r2(12_500 * LAW_2024.employee), er: r2(12_500 * LAW_2024.employer), regime: "law_2024", wage: 12_500, emp_rate: LAW_2024.employee, er_rate: LAW_2024.employer },
      { num: "G1-B-1421", emp: r2(45_000 * LAW_1421H.employee), er: r2(45_000 * LAW_1421H.employer), regime: "law_1421h", wage: 45_000, emp_rate: LAW_1421H.employee, er_rate: LAW_1421H.employer },
      { num: "G1-C-NON", emp: 0, er: r2(10_000 * NON_SAUDI.employer), regime: "non_saudi", wage: 10_000, emp_rate: 0, er_rate: NON_SAUDI.employer },
    ]);
  });

  it("🔴 a Saudi employee whose law is not stated: the run is refused by name, and nothing is created", async () => {
    await employee("G2-A-SET", "SA", "law_1421h", 9_000, 1_000);
    await employee("G2-B-UNSTATED", "SA", null, 9_000, 1_000);
    const before = await runCount();
    const res = await h.api("admin", "POST", "/payroll", { period: "2026-11" });
    expect([res.status, res.body?.code], JSON.stringify(res.body)).toEqual([422, "gosi_regime_required"]);
    expect((res.body.employees as Array<{ name: string }>).map((e) => e.name)).toEqual(["GOSI Proof G2-B-UNSTATED"]);
    expect(await runCount()).toBe(before);
  });

  it("🔴 a period no rate covers for a law (a 2024-law period before July 2024, when that law took effect): refused, nothing created", async () => {
    await employee("G3-A-2024", "SA", "law_2024", 9_000, 1_000);
    const before = await runCount();
    const res = await h.api("admin", "POST", "/payroll", { period: "2024-06" });
    expect([res.status, res.body?.code], JSON.stringify(res.body)).toEqual([422, "gosi_rate_unknown_for_period"]);
    expect(await runCount()).toBe(before);
    // The control: the same employee in a covered period is computed.
    expect((await h.api("admin", "POST", "/payroll", { period: "2024-07" })).status).toBe(201);
  });

  it("🔴 a run computed before the change (lines without a GOSI record) is refused at approval until regenerated, and posts nothing", async () => {
    const emp = await employee("G4-A-OLD", "SA", "law_1421h", 7_000, 1_000);
    const runId = Number((await pool.query(
      `INSERT INTO payroll_runs (organization_id, company_id, period, status, total_basic_salary, total_allowances, total_gosi_employee, total_gosi_employer, total_deductions, total_net_pay)
       VALUES ($1,$2,'2026-09','draft',7000,1300,682.5,822.5,0,7617.5) RETURNING id`, [orgId, companyId],
    )).rows[0].id);
    await pool.query(
      `INSERT INTO payroll_items (organization_id, company_id, payroll_run_id, employee_id, basic_salary, housing_allowance, transport_allowance, other_allowances, gross_salary, gosi_employee, gosi_employer, additions, deductions, net_pay)
       VALUES ($1,$2,$3,$4,7000,1000,300,0,8300,682.5,822.5,0,0,7617.5)`, [orgId, companyId, runId, emp],
    );
    const entriesBefore = Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE company_id = $1`, [companyId])).rows[0].n);
    const res = await h.api("admin", "POST", `/payroll/${runId}/approve`, {});
    expect([res.status, res.body?.code], JSON.stringify(res.body)).toEqual([422, "payroll_run_regenerate_required"]);
    expect((await pool.query(`SELECT status FROM payroll_runs WHERE id = $1`, [runId])).rows[0].status).toBe("draft");
    expect(Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE company_id = $1`, [companyId])).rows[0].n)).toBe(entriesBefore);
  });

  it("🔴 GOSI is paid from a bank once: Dr GOSI Payable / Cr bank for the run's contributions; the expense is never touched", async () => {
    await employee("G5-A-2024", "SA", "law_2024", 20_000, 4_000); // wage 24,000
    const created = await h.api("admin", "POST", "/payroll", { period: "2026-12" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as number;
    expect((await h.api("admin", "POST", `/payroll/${id}/approve`, {})).status).toBe(200);
    const due = r2(r2(24_000 * LAW_2024.employee) + r2(24_000 * LAW_2024.employer));
    const [payableBefore, expenseBefore] = [await gl("GOSI_PAYABLE"), await gl("GOSI_EXPENSE")];
    const paid = await h.api("admin", "POST", `/payroll/${id}/gosi/pay`, { bankAccountId: bankId, paidAt: "2027-01-10" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.gosiPaidAt).toBe("2027-01-10");
    expect(r2((await gl("GOSI_PAYABLE")) - payableBefore), "the payable is settled by the run's contributions").toBe(due);
    expect(await gl("GOSI_EXPENSE"), "the expense is untouched").toBe(expenseBefore);
    const again = await h.api("admin", "POST", `/payroll/${id}/gosi/pay`, { bankAccountId: bankId });
    expect([again.status, again.body?.code]).toEqual([409, "payroll_gosi_already_paid"]);
  });

  it("🔴 a GOSI bank line is suggested against GOSI Payable while a run's GOSI is owed, never as the expense", async () => {
    await employee("G6-A-1421", "SA", "law_1421h", 10_000, 0); // wage 10,000
    const created = await h.api("admin", "POST", "/payroll", { period: "2027-01" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await h.api("admin", "POST", `/payroll/${created.body.id}/approve`, {})).status).toBe(200);
    const owed = r2(r2(10_000 * LAW_1421H.employee) + r2(10_000 * LAW_1421H.employer));
    const up = await h.api("admin", "POST", "/transactions/upload", {
      rows: [{ date: "2027-02-10", description: "GOSI CONTRIBUTION P18GOSI JAN", amount: owed, currency: "SAR", type: "debit" }],
      autoCategrize: true, bankAccountId: bankId,
    });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const row = (await pool.query(
      `SELECT c.system_code FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.description = 'GOSI CONTRIBUTION P18GOSI JAN'`,
    )).rows[0];
    expect(row.system_code).toBe("GOSI_PAYABLE");
  });

  it("🔴 the obligations calendar dates a run's GOSI to the 15th of the next month, with the uncapped late-fine estimate", async () => {
    await employee("G7-A-1421", "SA", "law_1421h", 12_000, 0);
    const created = await h.api("admin", "POST", "/payroll", { period: "2026-08" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await h.api("admin", "POST", `/payroll/${created.body.id}/approve`, {})).status).toBe(200);
    const res = await h.api("admin", "GET", "/tax/obligations");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = (res.body.obligations as Array<{ kind: string; reference: string; amount: number; dueDate: string; fineEstimate: number }>).find((o) => o.kind === "gosi" && o.reference === "2026-08");
    const amount = r2(r2(12_000 * LAW_1421H.employee) + r2(12_000 * LAW_1421H.employer));
    expect(row && [row.amount, row.dueDate], JSON.stringify(res.body.obligations)).toEqual([amount, "2026-09-15"]);
    // Months or parts of months after 2026-09-15, as of today; 2% each, uncapped.
    const today = businessToday();
    const [y, m, d] = today.split("-").map(Number) as [number, number, number];
    const months = Math.max(0, (y - 2026) * 12 + (m - 9) + (d > 15 ? 1 : 0));
    expect(row!.fineEstimate).toBe(Math.round(Math.round(amount * 100) * 0.02 * months) / 100);
  });
});
