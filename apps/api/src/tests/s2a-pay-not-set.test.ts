/**
 * 🔴 19B S2a (v4 §10.1, D8 O2; owner 2026-11-22) — "PAY NOT SET", AND THE EDIT PATH THAT ENDS IT.
 *
 *  - An employee created without a basic salary is `payNotSet`: no salary, no gross, no GOSI figure — never a zero.
 *  - The list's totals count it apart (payNotSetCount) and leave it out of pay and of "GOSI law not stated".
 *  - A payroll run LEAVES IT OUT AND NAMES IT (leftOut): no line is written for it, and the run's totals are exactly
 *    the others'. Presence, absence and movement: setting the pay brings it into the next run.
 *  - A run where every active employee lacks pay is refused by name; nothing is created.
 *  - The edit path (the owner's item 1): pay, status and the end date are changed after creation, and an end date
 *    before the joining date, or a status outside the three, is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s2a-pay-not-set-password-2026";
const h = g04Harness("s2a-pns");

describeDb("19B S2a — pay not set, the left-out list, and the edit path", () => {
  let paidId = 0;
  let unpaidId = 0;

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S2a PNS Co", "319191919191963");
    const lone = await h.mkOrg("lone");
    await h.mkCompany(lone, "S2a PNS Lone Co", "319191919191973");
    await h.mkUser("accountant", PW, orgId, "accountant");
    await h.mkUser("lone", PW, lone, "accountant");
    expect(await h.login("accountant", h.email("accountant"), PW)).toBe(200);
    expect(await h.login("lone", h.email("lone"), PW)).toBe(200);
    const paid = await h.api("accountant", "POST", "/employees", { employeeNumber: "PNS-PAID", name: "Paid", nationality: "EX", basicSalary: 6000, housingAllowance: 1500, joiningDate: "2025-01-01" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    paidId = paid.body.id;
    const unpaid = await h.api("accountant", "POST", "/employees", { employeeNumber: "PNS-UNPAID", name: "Unpaid", nationality: "EX", joiningDate: "2025-01-01" });
    expect(unpaid.status, JSON.stringify(unpaid.body)).toBe(201);
    unpaidId = unpaid.body.id;
  });
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 an employee created without pay is `payNotSet`: no salary, no gross, no GOSI figure — never a zero", async () => {
    const r = await h.api("accountant", "GET", `/employees/${unpaidId}`);
    expect(r.status).toBe(200);
    expect(r.body.payNotSet).toBe(true);
    expect([r.body.basicSalary, r.body.grossSalary, r.body.gosiEmployee, r.body.gosiEmployer, r.body.gosiWageBase]).toEqual([null, null, null, null, null]);
    const p = await h.api("accountant", "GET", `/employees/${paidId}`);
    expect([p.body.payNotSet, p.body.basicSalary, p.body.grossSalary]).toEqual([false, 6000, 7500]); // presence: the other is paid
    expect((await pool.query(`SELECT basic_salary FROM employees WHERE id = $1`, [unpaidId])).rows[0].basic_salary).toBeNull();
  });

  it("the list's totals count it apart: not in pay, not as a missing GOSI law", async () => {
    const r = await h.api("accountant", "GET", "/employees?status=active");
    expect(r.body.totals.payNotSetCount).toBe(1);
    expect(r.body.totals.gosiUnstatedCount).toBe(0);
    expect(r.body.totals.grossSalary).toBe(7500);
    // The employer's GOSI over the PAID employee only (an expat: 2% of 7,500) — the unpaid one adds nothing, never the
    // SAR 45,000 ceiling (Postgres's LEAST ignores a NULL wage; mutant P4 found it).
    expect(r.body.totals.gosiEmployer).toBe(150);
    expect(r.body.page.total).toBe(2);
  });

  it("🔴 a run LEAVES IT OUT AND NAMES IT; no line for it; the totals are exactly the others'", async () => {
    const run = await h.api("accountant", "POST", "/payroll", { period: "2026-10" });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.leftOut).toEqual([{ employeeId: unpaidId, employeeNumber: "PNS-UNPAID", name: "Unpaid", reason: "pay_not_set" }]);
    const detail = await h.api("accountant", "GET", `/payroll/${run.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.items.map((i: { employeeId: number }) => i.employeeId)).toEqual([paidId]);
    expect(detail.body.leftOut).toEqual(run.body.leftOut);
    expect(detail.body.totalBasicSalary).toBe(6000);
    expect(detail.body.totalNetPay).toBe(detail.body.items[0].netPay);
    const lines = (await pool.query(`SELECT count(*)::int n FROM payroll_items WHERE payroll_run_id = $1 AND employee_id = $2`, [run.body.id, unpaidId])).rows[0].n;
    expect(lines).toBe(0);
  });

  it("🔴 movement: once an accountant sets the pay, the next run includes the employee and leaves no one out", async () => {
    const set = await h.api("accountant", "PATCH", `/employees/${unpaidId}`, { basicSalary: 5000 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect([set.body.payNotSet, set.body.basicSalary]).toEqual([false, 5000]);
    const run = await h.api("accountant", "POST", "/payroll", { period: "2026-11" });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.leftOut).toEqual([]);
    const detail = await h.api("accountant", "GET", `/payroll/${run.body.id}`);
    expect(detail.body.items.map((i: { employeeId: number }) => i.employeeId).sort()).toEqual([paidId, unpaidId].sort());
  });

  it("🔴 a run where every active employee lacks pay is refused by name, and nothing is created", async () => {
    const e = await h.api("lone", "POST", "/employees", { employeeNumber: "PNS-LONE", name: "Lone", nationality: "EX" });
    expect(e.status).toBe(201);
    const before = (await pool.query(`SELECT count(*)::int n FROM payroll_runs r JOIN organizations o ON o.id = r.organization_id WHERE o.slug = 's2a-pns-lone'`)).rows[0].n;
    const run = await h.api("lone", "POST", "/payroll", { period: "2026-10" });
    expect(run.status).toBe(422);
    expect(run.body.code).toBe("payroll_no_pay_set");
    expect(run.body.leftOut.map((l: { name: string }) => l.name)).toEqual(["Lone"]);
    expect(run.body.errorAr).toBeTruthy();
    const after = (await pool.query(`SELECT count(*)::int n FROM payroll_runs r JOIN organizations o ON o.id = r.organization_id WHERE o.slug = 's2a-pns-lone'`)).rows[0].n;
    expect(after).toBe(before);
  });

  it("🔴 the edit path: a raise, and a departure (status and end date) are recorded after creation", async () => {
    const raise = await h.api("accountant", "PATCH", `/employees/${paidId}`, { basicSalary: 6500 });
    expect([raise.status, raise.body.basicSalary]).toEqual([200, 6500]);
    const leave = await h.api("accountant", "PATCH", `/employees/${paidId}`, { status: "terminated", endDate: "2026-11-30" });
    expect(leave.status, JSON.stringify(leave.body)).toBe(200);
    expect([leave.body.status, leave.body.endDate]).toEqual(["terminated", "2026-11-30"]);
  });

  it("an end date before the joining date, and a status outside the three, are refused; nothing is saved", async () => {
    const early = await h.api("accountant", "PATCH", `/employees/${unpaidId}`, { endDate: "2024-12-31" });
    expect([early.status, early.body.code]).toEqual([422, "employee_end_before_joining"]);
    const typo = await h.api("accountant", "PATCH", `/employees/${unpaidId}`, { status: "Active" });
    expect(typo.status).toBe(400);
    const row = (await pool.query(`SELECT status, end_date FROM employees WHERE id = $1`, [unpaidId])).rows[0];
    expect(row).toEqual({ status: "active", end_date: null });
  });
});
