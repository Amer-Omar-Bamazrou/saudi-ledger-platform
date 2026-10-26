/**
 * 🔴 GOSI GO-10..GO-13 (Phase 18, owner decisions 2026-10-27; register §11.26).
 *
 * Four rules from the contribution parts of the two Implementing Regulations,
 * each proven through the real API, each figure computed independently below:
 *  - GO-10, 1421H law only: the PENSION contribution is never less than that for
 *    a SAR 1,500 monthly wage, both shares (1421H Registration and Contributions
 *    Regulation Art. 19(1)). The 2024 law sets its floor as "the minimum wage set
 *    by the competent authority" (Law Art. 8(1)), with no figure: none applied (G1).
 *  - GO-11, 1421H law only: the late-fine estimate never exceeds 100% of the
 *    contribution (Art. 30(1)). The 2024 texts state no cap: none applied (G1).
 *  - GO-12: 1421H law: the contributory wage is the one due in January, or in a
 *    joiner's first month, for the whole year (Art. 21(2)(a),(b)). 2024 law: the
 *    joining and leaving months are charged by days of service (2024 Regulation
 *    Art. 20(2)), divided by the month's actual days (its Arts. 36(1), 53(3)).
 *    1421H proration is HELD by the owner; the 2024 texts state no annual wage (G1).
 *  - GO-13, both laws: in-kind housing counts in the contributory wage (1421H
 *    Art. 16(c); 2024 Art. 17(c)) at basic × 2 ÷ 12 a month — an INTERPRETATION
 *    (owner, 2026-10-27): the texts say "two months' basic" with no time unit.
 *    A per-employee exempt flag (the Governor's cases) removes it.
 * Every payroll line records what it used.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3233";
process.env.SESSION_SECRET ??= "phase18-gosi-go10-go13-proof-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18GosiGoProofPw1!";

// Independent arithmetic (not imported from the code under test).
const r2 = (n: number) => Math.round(n * 100) / 100;
const L1421H = { employee: 0.0975, employer: 0.1175, pension: 0.09 };
const L2024_2025_07 = { employee: 0.1025, employer: 0.1225 };
const L2024_2026_07 = { employee: 0.1075, employer: 0.1275 };
const L2024_2027_07 = { employee: 0.1125, employer: 0.1325 };
const NON_SAUDI_ER = 0.02;

type Line = {
  num: string; emp: number; er: number; wage: number;
  floor: number | null; inKind: number | null; days: number | null; monthDays: number | null; fixedFrom: string | null;
};

describeMaybe("GOSI GO-10..GO-13 — the 1421H floor and fine cap, the year's wage, 2024-law proration, in-kind housing", () => {
  const h = g04Harness("p18gosigo");
  let orgId = "";

  const employee = async (num: string, body: Record<string, unknown>) => {
    const res = await h.api("admin", "POST", "/employees", { employeeNumber: num, name: `GOSI GO ${num}`, nationality: "SA", status: "active", ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: number; gosiWageBase: number | null; gosiEmployee: number | null; gosiEmployer: number | null };
  };
  const run = async (period: string) => {
    const res = await h.api("admin", "POST", "/payroll", { period });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as number;
  };
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
  const plain = { floor: null, inKind: null, days: null, monthDays: null };
  // The figures first, then what each line records: on code without the record columns, a wrong FIGURE is what fails.
  const expectLines = (got: Line[], want: Line[]) => {
    const fig = (l: Line) => ({ num: l.num, emp: l.emp, er: l.er, wage: l.wage });
    expect(got.map(fig), "the figures").toEqual(want.map(fig));
    expect(got, "what each line records").toEqual(want);
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "GOSI GO Proof Co", "318181818181900");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`UPDATE employees SET status = 'terminated' WHERE organization_id = $1`, [orgId]);
  });

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 GO-10: a 1421H-law pension contribution is never less than that for SAR 1,500 (both shares); 2024 law: no floor", async () => {
    await employee("F1-1421-1000", { basicSalary: 1_000, gosiRegime: "law_1421h" });
    await employee("F2-1421-1500", { basicSalary: 1_500, gosiRegime: "law_1421h" });
    await employee("F3-2024-1000", { basicSalary: 1_000, gosiRegime: "law_2024" });
    const got = await lines(await run("2026-10"));
    // The pension share is lifted to 9% of 1,500; SANED and occupational hazards stay on the actual wage.
    const lift = (1_500 - 1_000) * L1421H.pension;
    expectLines(got, [
      { num: "F1-1421-1000", emp: r2(1_000 * L1421H.employee + lift), er: r2(1_000 * L1421H.employer + lift), wage: 1_000, ...plain, floor: 1_500, fixedFrom: "2026-10" },
      { num: "F2-1421-1500", emp: r2(1_500 * L1421H.employee), er: r2(1_500 * L1421H.employer), wage: 1_500, ...plain, fixedFrom: "2026-10" },
      { num: "F3-2024-1000", emp: r2(1_000 * L2024_2026_07.employee), er: r2(1_000 * L2024_2026_07.employer), wage: 1_000, ...plain, fixedFrom: null },
    ]);
  });

  it("🔴 GO-11: the late-fine estimate caps the 1421H-law part at 100% of its contribution; the rest stays 2% a month, uncapped", async () => {
    await employee("C1-1421", { basicSalary: 10_000, gosiRegime: "law_1421h" });
    await employee("C2-NON", { basicSalary: 5_000, nationality: "IN" });
    const id = await run("2021-01");
    expect((await h.api("admin", "POST", `/payroll/${id}/approve`, {})).status).toBe(200);
    const part1421 = r2(r2(10_000 * L1421H.employee) + r2(10_000 * L1421H.employer));
    const partOther = r2(5_000 * NON_SAUDI_ER);
    // Months or parts of months after the due date (2021-02-15), as of today.
    const [y, m, d] = businessToday().split("-").map(Number) as [number, number, number];
    const months = (y - 2021) * 12 + (m - 2) + (d > 15 ? 1 : 0);
    expect(months, "the case needs more than 50 months late, where 2% a month passes 100%").toBeGreaterThan(50);
    const res = await h.api("admin", "GET", "/tax/obligations");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = (res.body.obligations as Array<{ kind: string; reference: string; amount: number; fineEstimate: number }>)
      .find((o) => o.kind === "gosi" && o.reference === "2021-01");
    expect(row?.amount, JSON.stringify(res.body.obligations)).toBe(r2(part1421 + partOther));
    expect(row!.fineEstimate).toBe(r2(part1421 + r2(partOther * 0.02 * months)));
  });

  it("🔴 GO-12: a 1421H-law wage is the year's first (January's) until the next year; a 2024-law raise applies from its month", async () => {
    const fix = await employee("Y1-1421", { basicSalary: 10_000, gosiRegime: "law_1421h" });
    const move = await employee("Y2-2024", { basicSalary: 10_000, gosiRegime: "law_2024" });
    const jan = await lines(await run("2027-01"));
    for (const e of [fix, move]) expect((await h.api("admin", "PATCH", `/employees/${e.id}`, { basicSalary: 12_000 })).status).toBe(200);
    const feb = await lines(await run("2027-02"));
    const nextJan = await lines(await run("2028-01")); // the next insurance year takes the new wage
    // All three runs' figures first, then their records (see expectLines).
    const want: Line[][] = [
      [
        { num: "Y1-1421", emp: r2(10_000 * L1421H.employee), er: r2(10_000 * L1421H.employer), wage: 10_000, ...plain, fixedFrom: "2027-01" },
        { num: "Y2-2024", emp: r2(10_000 * L2024_2026_07.employee), er: r2(10_000 * L2024_2026_07.employer), wage: 10_000, ...plain, fixedFrom: null },
      ],
      [
        { num: "Y1-1421", emp: r2(10_000 * L1421H.employee), er: r2(10_000 * L1421H.employer), wage: 10_000, ...plain, fixedFrom: "2027-01" },
        { num: "Y2-2024", emp: r2(12_000 * L2024_2026_07.employee), er: r2(12_000 * L2024_2026_07.employer), wage: 12_000, ...plain, fixedFrom: null },
      ],
      [
        { num: "Y1-1421", emp: r2(12_000 * L1421H.employee), er: r2(12_000 * L1421H.employer), wage: 12_000, ...plain, fixedFrom: "2028-01" },
        { num: "Y2-2024", emp: r2(12_000 * L2024_2027_07.employee), er: r2(12_000 * L2024_2027_07.employer), wage: 12_000, ...plain, fixedFrom: null },
      ],
    ];
    expectLines([...jan, ...feb, ...nextJan], want.flat());
  });

  it("🔴 GO-12: a 2024-law joining or leaving month is charged by days of service over the month's actual days; 1421H is not (held)", async () => {
    const base = { basicSalary: 9_300, gosiRegime: "law_2024" };
    await employee("P1-JOIN", { ...base, joiningDate: "2025-10-21" });                      // 21..31 = 11 days
    await employee("P2-LEAVE", { ...base, joiningDate: "2020-03-01", endDate: "2025-10-10" }); // 1..10 = 10 days
    await employee("P3-BOTH", { ...base, joiningDate: "2025-10-05", endDate: "2025-10-24" });  // 5..24 = 20 days
    await employee("P4-FULL", { ...base, joiningDate: "2025-01-01" });
    await employee("P5-1421-JOIN", { basicSalary: 9_300, gosiRegime: "law_1421h", joiningDate: "2025-10-21" });
    const got = await lines(await run("2025-10")); // October: 31 days (a 30-day divisor would differ)
    const by = (days: number) => ({
      emp: r2(9_300 * L2024_2025_07.employee * days / 31), er: r2(9_300 * L2024_2025_07.employer * days / 31),
      wage: 9_300, floor: null, inKind: null, days, monthDays: 31, fixedFrom: null,
    });
    expectLines(got, [
      { num: "P1-JOIN", ...by(11) },
      { num: "P2-LEAVE", ...by(10) },
      { num: "P3-BOTH", ...by(20) },
      { num: "P4-FULL", emp: r2(9_300 * L2024_2025_07.employee), er: r2(9_300 * L2024_2025_07.employer), wage: 9_300, ...plain, fixedFrom: null },
      { num: "P5-1421-JOIN", emp: r2(9_300 * L1421H.employee), er: r2(9_300 * L1421H.employer), wage: 9_300, ...plain, fixedFrom: "2025-10" },
    ]);
  });

  it("🔴 GO-13: in-kind housing adds basic × 2 ÷ 12 to the contributory wage under both laws, within the cap; an exempt employee adds nothing", async () => {
    const a = await employee("K1-1421-INKIND", { basicSalary: 6_000, gosiRegime: "law_1421h", gosiInKindHousing: true });
    await employee("K2-1421-EXEMPT", { basicSalary: 6_000, gosiRegime: "law_1421h", gosiInKindHousing: true, gosiInKindHousingExempt: true });
    await employee("K3-2024-INKIND", { basicSalary: 6_000, gosiRegime: "law_2024", gosiInKindHousing: true });
    await employee("K4-1421-CAP", { basicSalary: 42_000, gosiRegime: "law_1421h", gosiInKindHousing: true });
    // The employee's own preview follows the same rule.
    expect([a.gosiWageBase, a.gosiEmployee, a.gosiEmployer]).toEqual([7_000, r2(7_000 * L1421H.employee), r2(7_000 * L1421H.employer)]);
    const got = await lines(await run("2026-11"));
    expectLines(got, [
      { num: "K1-1421-INKIND", emp: r2(7_000 * L1421H.employee), er: r2(7_000 * L1421H.employer), wage: 7_000, ...plain, inKind: 1_000, fixedFrom: "2026-11" },
      { num: "K2-1421-EXEMPT", emp: r2(6_000 * L1421H.employee), er: r2(6_000 * L1421H.employer), wage: 6_000, ...plain, fixedFrom: "2026-11" },
      { num: "K3-2024-INKIND", emp: r2(7_000 * L2024_2026_07.employee), er: r2(7_000 * L2024_2026_07.employer), wage: 7_000, ...plain, inKind: 1_000, fixedFrom: null },
      { num: "K4-1421-CAP", emp: r2(45_000 * L1421H.employee), er: r2(45_000 * L1421H.employer), wage: 45_000, ...plain, inKind: 7_000, fixedFrom: "2026-11" },
    ]);
  });

  it("🔴 GO-13: an exempt flag without in-kind housing means nothing, and is refused by name; nothing is created", async () => {
    const before = Number((await pool.query(`SELECT count(*)::int AS n FROM employees WHERE organization_id = $1`, [orgId])).rows[0].n);
    const res = await h.api("admin", "POST", "/employees", {
      employeeNumber: "K9-BAD", name: "GOSI GO K9", nationality: "SA", basicSalary: 6_000, gosiRegime: "law_1421h", gosiInKindHousingExempt: true,
    });
    expect([res.status, res.body?.code], JSON.stringify(res.body)).toEqual([422, "gosi_in_kind_exempt_without_in_kind"]);
    expect(Number((await pool.query(`SELECT count(*)::int AS n FROM employees WHERE organization_id = $1`, [orgId])).rows[0].n)).toBe(before);
  });

  it("🔴 the employee list's GOSI total equals the sum of the employees' own previews, with the floor and in-kind housing in it", async () => {
    const made = [
      await employee("T1-1421-FLOOR", { basicSalary: 1_000, gosiRegime: "law_1421h" }),
      await employee("T2-1421-INKIND", { basicSalary: 6_000, gosiRegime: "law_1421h", gosiInKindHousing: true }),
      await employee("T3-2024-INKIND", { basicSalary: 6_000, gosiRegime: "law_2024", gosiInKindHousing: true }),
      await employee("T4-NON-INKIND", { basicSalary: 6_000, nationality: "IN", gosiInKindHousing: true }),
    ];
    const res = await h.api("admin", "GET", "/employees?status=active");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sum = r2(made.reduce((s, e) => s + (e.gosiEmployer ?? 0), 0));
    // Independently: the floor lifts T1's pension share; in-kind adds 1,000 for T2..T4.
    const today = businessToday().slice(0, 7);
    const l2024 = today >= "2027-07" ? L2024_2027_07 : L2024_2026_07;
    const expected = r2(r2(1_000 * L1421H.employer + 500 * L1421H.pension) + r2(7_000 * L1421H.employer) + r2(7_000 * l2024.employer) + r2(7_000 * NON_SAUDI_ER));
    expect(sum, "the previews").toBe(expected);
    expect(r2(res.body.totals.gosiEmployer), "the list total, computed in SQL").toBe(expected);
  });
});
