/**
 * 🔴 GOSI GO-12, 1421H law: the joining and leaving months by days of service
 * (Phase 18, owner decisions 2026-10-27 morning, item 2; register §11.27).
 *
 * The binding text, 1421H Registration and Contributions Regulation Art. 21(3):
 * «تحصل الاشتراكات عن شهر الدخول في الخدمة وعن شهر الخروج من الخدمة على أساس عدد أيام الخدمة»
 * It names no divisor. The month's ACTUAL days, matching the 2024 rule (2024
 * Regulation Arts. 20(2), 36(1), 53(3)), is an INTERPRETATION (owner). GOSI's
 * Employer FAQ #11 reads otherwise (the joining month in full; the leaving month
 * only when service ends on its last day): question G1 asks which GOSI invoices.
 *
 * Proven through the real API, each figure computed independently below:
 *  - a joining, a leaving and a both-in-one month are charged by days; a leaving
 *    date on the month's last day, and a full month, are not; a non-Saudi line
 *    (its law not modelled) is not;
 *  - the divisor is the month's actual days: 30, 28 and 29;
 *  - with the year's wage (Art. 21(2)(b)): the joining month's wage fixes the
 *    year, a raise does not move it, and the leaving month is charged on it;
 *  - with the pension floor (Art. 19(1)) and in-kind housing (Art. 16(c)): the
 *    month's contribution is found first, then charged by days.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3234";
process.env.SESSION_SECRET ??= "phase18-gosi-1421h-proration-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18Gosi1421hProrationPw1!";

// Independent arithmetic (not imported from the code under test).
const r2 = (n: number) => Math.round(n * 100) / 100;
const L1421H = { employee: 0.0975, employer: 0.1175, pension: 0.09 };
const NON_SAUDI_ER = 0.02;

type Line = { num: string; emp: number; er: number; wage: number; floor: number | null; inKind: number | null; days: number | null; monthDays: number | null; fixedFrom: string | null };

describeMaybe("GOSI GO-12, 1421H law — the joining and leaving months by days of service over the month's actual days", () => {
  const h = g04Harness("p18gosi1421p");
  let orgId = "";

  const employee = async (num: string, body: Record<string, unknown>) => {
    const res = await h.api("admin", "POST", "/employees", { employeeNumber: num, name: `GOSI 1421H ${num}`, nationality: "SA", status: "active", gosiRegime: "law_1421h", ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: number };
  };
  const run = async (period: string) => {
    const res = await h.api("admin", "POST", "/payroll", { period });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as number;
  };
  const terminateAll = () => pool.query(`UPDATE employees SET status = 'terminated' WHERE organization_id = $1`, [orgId]);
  // to_jsonb, so a column that does not exist reads as undefined (an assertion failure), not an SQL error.
  const lines = async (runId: number): Promise<Line[]> => (await pool.query(
    `SELECT e.employee_number AS num, to_jsonb(i.*) AS j FROM payroll_items i JOIN employees e ON e.id = i.employee_id
      WHERE i.payroll_run_id = $1 ORDER BY e.employee_number`, [runId],
  )).rows.map(({ num, j }) => {
    const n = (v: unknown) => (v === null || v === undefined ? (v as null) : Number(v));
    return {
      num, emp: Number(j.gosi_employee), er: Number(j.gosi_employer), wage: Number(j.gosi_wage_base),
      floor: n(j.gosi_pension_floor_wage), inKind: n(j.gosi_in_kind_housing),
      days: n(j.gosi_service_days), monthDays: n(j.gosi_period_days), fixedFrom: j.gosi_wage_fixed_period as string | null,
    };
  });
  // The figures first, then what each line records.
  const expectLines = (got: Line[], want: Line[]) => {
    const fig = (l: Line) => ({ num: l.num, emp: l.emp, er: l.er, wage: l.wage });
    expect(got.map(fig), "the figures").toEqual(want.map(fig));
    expect(got, "what each line records").toEqual(want);
  };
  /** A 1421H line of `wage` charged `days` of `monthDays` (null: the full month). */
  const line = (num: string, wage: number, fixedFrom: string, days: number | null, monthDays: number) => ({
    num, wage, fixedFrom, floor: null, inKind: null,
    emp: r2(days === null ? wage * L1421H.employee : wage * L1421H.employee * days / monthDays),
    er: r2(days === null ? wage * L1421H.employer : wage * L1421H.employer * days / monthDays),
    days, monthDays: days === null ? null : monthDays,
  });

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "GOSI 1421H Proration Proof Co", "318181818181911");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  beforeEach(terminateAll);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a 1421H-law joining, leaving or both-in-one month is charged by days of service; a last-day leaving, a full month and a non-Saudi line are not", async () => {
    const W = 9_300;
    await employee("J1-JOIN", { basicSalary: W, joiningDate: "2025-10-21" });                      // 21..31 = 11 days
    await employee("J2-LEAVE", { basicSalary: W, joiningDate: "2020-03-01", endDate: "2025-10-10" }); // 1..10 = 10 days
    await employee("J3-BOTH", { basicSalary: W, joiningDate: "2025-10-05", endDate: "2025-10-24" });  // 5..24 = 20 days
    await employee("J4-LASTDAY", { basicSalary: W, joiningDate: "2020-01-01", endDate: "2025-10-31" });
    await employee("J5-FULL", { basicSalary: W, joiningDate: "2025-01-01" });
    await employee("N1-NON", { basicSalary: W, nationality: "IN", gosiRegime: undefined, joiningDate: "2025-10-21" });
    const id = await run("2025-10"); // October: 31 days
    const want: Line[] = [
      line("J1-JOIN", W, "2025-10", 11, 31),
      line("J2-LEAVE", W, "2025-10", 10, 31),
      line("J3-BOTH", W, "2025-10", 20, 31),
      line("J4-LASTDAY", W, "2025-10", null, 31),
      line("J5-FULL", W, "2025-10", null, 31),
      { num: "N1-NON", emp: 0, er: r2(W * NON_SAUDI_ER), wage: W, floor: null, inKind: null, days: null, monthDays: null, fixedFrom: null },
    ];
    expectLines(await lines(id), want);
    // The run's totals are the lines' own (rounded) figures.
    const { rows: [t] } = await pool.query(`SELECT total_gosi_employee AS e, total_gosi_employer AS r FROM payroll_runs WHERE id = $1`, [id]);
    expect([Number(t.e), Number(t.r)]).toEqual([r2(want.reduce((s, l) => s + l.emp, 0)), r2(want.reduce((s, l) => s + l.er, 0))]);
  });

  it("🔴 the divisor is the month's actual days: 30 (November), 28 (February 2027) and 29 (February 2028)", async () => {
    const W = 9_000;
    const cases = [
      { num: "D30", joiningDate: "2026-11-21", period: "2026-11", days: 10, monthDays: 30 },
      { num: "D28", joiningDate: "2027-02-15", period: "2027-02", days: 14, monthDays: 28 },
      { num: "D29", joiningDate: "2028-02-15", period: "2028-02", days: 15, monthDays: 29 },
    ];
    const got: Line[] = [];
    for (const c of cases) {
      await terminateAll();
      await employee(c.num, { basicSalary: W, joiningDate: c.joiningDate });
      got.push(...await lines(await run(c.period)));
    }
    expectLines(got, cases.map((c) => line(c.num, W, c.period, c.days, c.monthDays)));
  });

  it("🔴 with the year's wage: the joining month's wage fixes the year, a raise does not move it, and the leaving month is charged on it by days", async () => {
    const y = await employee("Y1-JOIN-RAISE-LEAVE", { basicSalary: 10_000, joiningDate: "2027-03-11" }); // 11..31 = 21 days
    const mar = await lines(await run("2027-03"));
    expect((await h.api("admin", "PATCH", `/employees/${y.id}`, { basicSalary: 12_000, endDate: "2027-05-20" })).status).toBe(200);
    const apr = await lines(await run("2027-04"));
    const may = await lines(await run("2027-05")); // 1..20 = 20 days
    expectLines([...mar, ...apr, ...may], [
      line("Y1-JOIN-RAISE-LEAVE", 10_000, "2027-03", 21, 31),
      line("Y1-JOIN-RAISE-LEAVE", 10_000, "2027-03", null, 30),
      line("Y1-JOIN-RAISE-LEAVE", 10_000, "2027-03", 20, 31),
    ]);
  });

  it("🔴 with the pension floor and in-kind housing: the month's contribution is found first, then charged by days", async () => {
    await employee("F1-FLOOR", { basicSalary: 1_000, joiningDate: "2026-04-21" });                       // 21..30 = 10 days
    await employee("K1-INKIND", { basicSalary: 6_000, gosiInKindHousing: true, joiningDate: "2026-04-21" });
    const got = await lines(await run("2026-04")); // April: 30 days
    const lift = (1_500 - 1_000) * L1421H.pension; // the floor lifts the pension share, both sides (Art. 19(1))
    expectLines(got, [
      {
        num: "F1-FLOOR", wage: 1_000, floor: 1_500, inKind: null, days: 10, monthDays: 30, fixedFrom: "2026-04",
        emp: r2((1_000 * L1421H.employee + lift) * 10 / 30), er: r2((1_000 * L1421H.employer + lift) * 10 / 30),
      },
      // In-kind housing adds 6,000 × 2 ÷ 12 = 1,000 to the wage (Art. 16(c), an interpretation).
      { ...line("K1-INKIND", 7_000, "2026-04", 10, 30), inKind: 1_000 },
    ]);
  });
});
