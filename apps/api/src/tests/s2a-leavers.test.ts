/**
 * 🔴 19B S2a follow-up (owner item 3, 2026-11-23) — LEAVERS IN A PAYROLL RUN, AND DELETING A PAID EMPLOYEE.
 *
 *  - A run never pays an employee whose end date is before the period starts, whatever their status. An ACTIVE one is
 *    named in the run (`ended_before_period`): their record says they left, yet nobody marked them inactive.
 *  - An employee whose end date falls inside the period — the first day and the last day included — is named in the
 *    run (`ends_in_period`) and NOT paid automatically, whatever their status, until the accountant answers how a final
 *    part-month is paid (advisor-questions.md Block N). Before, an `active` leaver was paid a full month and an
 *    `inactive` one silently dropped.
 *  - An end date after the period is an ordinary month: paid (movement — the same employee is paid in the month
 *    before they leave and named in the month they leave).
 *  - A run that would pay nobody is refused by name, with every employee it would leave out; nothing is created.
 *  - Deleting an employee who appears on a payroll run is refused with a named 409, in both languages, offering
 *    "Mark inactive" — never the 500 the foreign key used to surface. One who never did is deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s2a-leavers-password-2026";
const h = g04Harness("s2a-lvr");

type Left = { employeeId: number; employeeNumber: string; name: string; reason: string };

describeDb("19B S2a — leavers in a payroll run; deleting a paid employee", () => {
  const ids: Record<string, number> = {};
  let octoberRun = 0;
  let novemberRun = 0;

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S2a Leavers Co", "319191919191983");
    const lone = await h.mkOrg("lone");
    await h.mkCompany(lone, "S2a Leavers Lone Co", "319191919191993");
    await h.mkUser("accountant", PW, orgId, "accountant");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("lone", PW, lone, "accountant");
    for (const k of ["accountant", "admin", "lone"]) expect(await h.login(k, h.email(k), PW)).toBe(200);
    const mk = async (who: string, number: string, basic: number, extra: Record<string, unknown>) => {
      const r = await h.api(who, "POST", "/employees", { employeeNumber: number, name: number, nationality: "IN", basicSalary: basic, joiningDate: "2025-01-01", ...extra });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as number;
    };
    // distinct salaries, so a total names exactly who is in it
    ids.endedMarchActive = await mk("accountant", "LV-ENDED-MARCH-ACTIVE", 5101, { endDate: "2026-03-15", status: "active" });
    ids.endedOct31Active = await mk("accountant", "LV-ENDED-OCT31-ACTIVE", 5203, { endDate: "2026-10-31", status: "active" });
    ids.endsNov1Active = await mk("accountant", "LV-ENDS-NOV1-ACTIVE", 5307, { endDate: "2026-11-01", status: "active" });
    ids.endsMidNovActive = await mk("accountant", "LV-ENDS-MIDNOV-ACTIVE", 5411, { endDate: "2026-11-15", status: "active" });
    ids.endsMidNovInactive = await mk("accountant", "LV-ENDS-MIDNOV-INACTIVE", 5513, { endDate: "2026-11-15", status: "inactive" });
    ids.endsNov30Terminated = await mk("accountant", "LV-ENDS-NOV30-TERMINATED", 5617, { endDate: "2026-11-30", status: "terminated" });
    ids.endedJuneTerminated = await mk("accountant", "LV-ENDED-JUNE-TERMINATED", 5719, { endDate: "2026-06-30", status: "terminated" });
    ids.endsDecemberActive = await mk("accountant", "LV-ENDS-DEC-ACTIVE", 5823, { endDate: "2026-12-31", status: "active" });
    ids.control = await mk("accountant", "LV-CONTROL", 5929, {});
    ids.neverPaid = await mk("accountant", "LV-NEVER-PAID", 6031, { status: "inactive" });
    ids.loneLeaver = await mk("lone", "LV-LONE-LEAVER", 6133, { endDate: "2026-11-20", status: "active" });
  });
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  const paidIn = async (runId: number) =>
    (await pool.query(`SELECT employee_id, basic_salary::float8 AS basic FROM payroll_items WHERE payroll_run_id = $1 ORDER BY employee_id`, [runId])).rows as { employee_id: number; basic: number }[];

  it("October: a month before the November leavers' end dates — each is paid an ordinary month (presence)", async () => {
    const run = await h.api("accountant", "POST", "/payroll", { period: "2026-10" });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    octoberRun = run.body.id;
    const paid = (await paidIn(octoberRun)).map((r) => r.employee_id);
    for (const k of ["endsNov1Active", "endsMidNovActive", "endsDecemberActive", "control"]) expect(paid, k).toContain(ids[k]);
    // October 31 is inside October: named, not paid; March is before October: named, not paid
    expect(paid).not.toContain(ids.endedOct31Active);
    expect(paid).not.toContain(ids.endedMarchActive);
    const reasons = Object.fromEntries((run.body.leftOut as Left[]).map((l) => [l.employeeId, l.reason]));
    expect(reasons[ids.endedOct31Active]).toBe("ends_in_period");
    expect(reasons[ids.endedMarchActive]).toBe("ended_before_period");
  });

  it("🔴 November: an end date before the period is never paid, whatever the status; an active one is named", async () => {
    const run = await h.api("accountant", "POST", "/payroll", { period: "2026-11" });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    novemberRun = run.body.id;
    const paid = (await paidIn(novemberRun)).map((r) => r.employee_id);
    for (const k of ["endedMarchActive", "endedOct31Active", "endedJuneTerminated"]) expect(paid, k).not.toContain(ids[k]);
    const left = run.body.leftOut as Left[];
    const reasonOf = (k: string) => left.find((l) => l.employeeId === ids[k])?.reason ?? null;
    expect(reasonOf("endedMarchActive")).toBe("ended_before_period");
    expect(reasonOf("endedOct31Active")).toBe("ended_before_period"); // the day before the period starts
    // a terminated employee who left in June is simply not a candidate — listing every past leaver in every run is noise
    expect(reasonOf("endedJuneTerminated")).toBeNull();
  });

  it("🔴 November: an end date inside the period (first and last day included) is named and NOT paid, whatever the status", async () => {
    const detail = await h.api("accountant", "GET", `/payroll/${novemberRun}`);
    expect(detail.status).toBe(200);
    const paid = (await paidIn(novemberRun)).map((r) => r.employee_id);
    const left = detail.body.leftOut as Left[];
    for (const k of ["endsNov1Active", "endsMidNovActive", "endsMidNovInactive", "endsNov30Terminated"]) {
      expect(paid, k).not.toContain(ids[k]);
      expect(left.find((l) => l.employeeId === ids[k]), k).toMatchObject({ reason: "ends_in_period", name: expect.any(String), employeeNumber: expect.any(String) });
    }
    // movement: paid in October, named in November
    const octPaid = (await paidIn(octoberRun)).map((r) => r.employee_id);
    expect(octPaid).toContain(ids.endsMidNovActive);
  });

  it("November: an end date after the period is an ordinary month; the run's totals are exactly the paid lines'", async () => {
    const lines = await paidIn(novemberRun);
    expect(lines.map((r) => r.employee_id).sort((a, b) => a - b)).toEqual([ids.endsDecemberActive, ids.control].sort((a, b) => a - b));
    const [run] = (await pool.query(`SELECT total_basic_salary::float8 AS basic FROM payroll_runs WHERE id = $1`, [novemberRun])).rows;
    expect(run.basic).toBe(5823 + 5929);
  });

  it("🔴 a run that would pay nobody is refused by name, with every employee it would leave out; nothing is created", async () => {
    const before = (await pool.query(`SELECT count(*)::int n FROM payroll_runs WHERE organization_id = (SELECT organization_id FROM employees WHERE id = $1)`, [ids.loneLeaver])).rows[0].n;
    const r = await h.api("lone", "POST", "/payroll", { period: "2026-11" });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.code).toBe("payroll_nobody_payable");
    expect(r.body.error).toContain("LV-LONE-LEAVER");
    expect(r.body.errorAr).toContain("LV-LONE-LEAVER");
    expect(r.body.leftOut).toEqual([expect.objectContaining({ employeeId: ids.loneLeaver, reason: "ends_in_period" })]);
    const after = (await pool.query(`SELECT count(*)::int n FROM payroll_runs WHERE organization_id = (SELECT organization_id FROM employees WHERE id = $1)`, [ids.loneLeaver])).rows[0].n;
    expect(after).toBe(before);
  });

  it("🔴 deleting an employee on a payroll run: a named 409 in both languages offering Mark inactive — the row stays", async () => {
    // the October run is approved, so the control has been paid through an approved run
    const approve = await h.api("accountant", "POST", `/payroll/${octoberRun}/submit`);
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    const ok = await h.api("accountant", "POST", `/payroll/${octoberRun}/approve`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const r = await h.api("admin", "DELETE", `/employees/${ids.control}`);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe("employee_on_payroll_run");
    expect(r.body.nextStep).toBe("mark_inactive");
    expect(r.body.error).toMatch(/Mark .*inactive/i);
    expect(r.body.error).toContain("2026-10");
    expect(r.body.errorAr).toMatch(/[؀-ۿ]/);
    expect(r.body.errorAr).toContain("غير نشط");
    expect(r.body.payrollRuns).toEqual(expect.arrayContaining(["2026-10", "2026-11"]));
    expect((await pool.query(`SELECT count(*)::int n FROM employees WHERE id = $1`, [ids.control])).rows[0].n).toBe(1);
  });

  it("deleting an employee who appears only on a draft run is refused the same way (the run's line keeps the record)", async () => {
    const r = await h.api("admin", "DELETE", `/employees/${ids.endsDecemberActive}`);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe("employee_on_payroll_run");
    expect(r.body.payrollRuns).toEqual(expect.arrayContaining(["2026-10", "2026-11"]));
  });

  it("an employee never on a run is deleted (the refusal is not a blanket one)", async () => {
    const r = await h.api("admin", "DELETE", `/employees/${ids.neverPaid}`);
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    expect((await pool.query(`SELECT count(*)::int n FROM employees WHERE id = $1`, [ids.neverPaid])).rows[0].n).toBe(0);
  });

  it("the Mark inactive step the refusal offers works", async () => {
    const r = await h.api("admin", "PATCH", `/employees/${ids.control}`, { status: "inactive" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe("inactive");
  });
});
