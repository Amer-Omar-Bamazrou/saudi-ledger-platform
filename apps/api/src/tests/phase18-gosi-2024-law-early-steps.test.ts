/**
 * 🔴 GOSI — THE 2024 LAW'S FIRST TWO PENSION STEPS (Phase 18, owner decision
 * 2026-10-26 late, item 2). Royal Decree M/273 item 3 fixes the 2024-law
 * pension at 9% each side from July 2024 and 9.5% each side from July 2025;
 * each step takes effect on 1 July (Saudi Press Agency, 30 June 2025). #238
 * covered only July 2026 onwards and refused every earlier 2024-law period.
 *
 * Through the real API, each figure computed independently below:
 *  - 2024-07 and 2025-06: employee 9.75%, employer 11.75%;
 *  - 2025-07 and 2026-06: employee 10.25%, employer 12.25%;
 *  - 2026-07: unchanged (10.75% / 12.75%), the control;
 *  - 2024-06, before the 2024 law took effect: still refused, nothing created.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3232";
process.env.SESSION_SECRET ??= "phase18-gosi-2024-law-steps-proof-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18GosiStepsPw1!";

// Independent arithmetic (not imported from the code under test): pension each side + SANED 0.75% each side + employer OH 2%.
const r2 = (n: number) => Math.round(n * 100) / 100;
const STEP_2024 = { employee: 0.0975, employer: 0.1175 }; // pension 9%
const STEP_2025 = { employee: 0.1025, employer: 0.1225 }; // pension 9.5%
const STEP_2026 = { employee: 0.1075, employer: 0.1275 }; // pension 10%
const WAGE = 12_500; // basic 10,000 + housing 2,500

describeMaybe("GOSI — the 2024 law from July 2024 (9%) and July 2025 (9.5%), each step on 1 July", () => {
  const h = g04Harness("p18gosi2");
  let orgId = "";
  let companyId = "";

  const runCount = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM payroll_runs WHERE organization_id = $1`, [orgId])).rows[0].n);
  const line = async (runId: number) => (await pool.query(
    `SELECT i.gosi_employee::float8 AS emp, i.gosi_employer::float8 AS er, i.gosi_regime AS regime,
            i.gosi_wage_base::float8 AS wage, i.gosi_employee_rate::float8 AS emp_rate, i.gosi_employer_rate::float8 AS er_rate
       FROM payroll_items i WHERE i.payroll_run_id = $1`, [runId],
  )).rows;
  const expected = (rates: { employee: number; employer: number }) => [
    { emp: r2(WAGE * rates.employee), er: r2(WAGE * rates.employer), regime: "law_2024", wage: WAGE, emp_rate: rates.employee, er_rate: rates.employer },
  ];
  const generate = async (period: string) => {
    const res = await h.api("admin", "POST", "/payroll", { period });
    expect(res.status, `${period}: ${JSON.stringify(res.body)}`).toBe(201);
    return line(res.body.id);
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "GOSI Steps Proof Co", "318181818181890");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    await pool.query(
      `INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, housing_allowance, transport_allowance, other_allowances, status, gosi_regime)
       VALUES ($1,$2,'S-2024','GOSI Steps Proof S-2024','SA',10000,2500,300,0,'active','law_2024')`,
      [orgId, companyId],
    );
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 from July 2024: pension 9% each side (employee 9.75%, employer 11.75%), through June 2025", async () => {
    expect(await generate("2024-07")).toEqual(expected(STEP_2024));
    expect(await generate("2025-06")).toEqual(expected(STEP_2024));
  });

  it("🔴 from July 2025: pension 9.5% each side (employee 10.25%, employer 12.25%), through June 2026", async () => {
    expect(await generate("2025-07")).toEqual(expected(STEP_2025));
    expect(await generate("2026-06")).toEqual(expected(STEP_2025));
  });

  it("the control: July 2026 is unchanged (employee 10.75%, employer 12.75%)", async () => {
    expect(await generate("2026-07")).toEqual(expected(STEP_2026));
  });

  it("🔴 a 2024-law period before the law took effect (June 2024) is still refused, and nothing is created", async () => {
    const before = await runCount();
    const res = await h.api("admin", "POST", "/payroll", { period: "2024-06" });
    expect([res.status, res.body?.code], JSON.stringify(res.body)).toEqual([422, "gosi_rate_unknown_for_period"]);
    expect(await runCount()).toBe(before);
  });
});
