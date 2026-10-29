/**
 * 🔴 Phase 18 H-5 — G68 (DR-03; DR-39), the payroll accrual date. The owner's
 * final-run memo §H (2026-10-27): "G68 dates the payroll accrual to the last
 * day of the run's service period, and a closed month refuses approval with a
 * clear message (correct by reopening with a reason)." IAS 19.11. Register
 * §11.51 (the scoped D-4 statement, appended before this file; it records the
 * §11.1 2.9 hold as superseded by the memo).
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3255";
process.env.SESSION_SECRET ??= "phase18-h5-g68-accrual-date-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H5G68Pw123!";

describeMaybe("Phase 18 H-5 — G68: payroll is accrued on the last day of its service period; a closed month refuses approval", () => {
  const h = g04Harness("p18h5g68");
  let orgId = "";
  const entryDate = async (runId: number) => (await pool.query(
    `SELECT e.date::text AS d FROM journal_entries e WHERE e.organization_id = $1 AND e.source_type = 'payroll_run' AND e.source_id = $2`, [orgId, runId])).rows.map((r) => r.d);
  const entries = async () => (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n as number;
  const run = async (period: string) => {
    const created = await h.api("admin", "POST", "/payroll", { period });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as number;
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    const co = await h.mkCompany(orgId, "H5 Co", "318181818181880");
    await h.mkUser("admin", PW, orgId, "admin");
    await pool.query(`INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, housing_allowance, transport_allowance, other_allowances, status)
                      VALUES ($1,$2,'H5-E-1','H5 Employee','IN',8000,1500,500,0,'active')`, [orgId, co]);
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a run for August, approved today, is accrued on 31 August — its own service period, not the approval day", async () => {
    const id = await run("2026-08");
    const r = await h.api("admin", "POST", `/payroll/${id}/approve`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await entryDate(id)).toEqual(["2026-08-31"]);
  });

  it("🔴 the month's LAST day, whatever its length: February 2026 ends on the 28th", async () => {
    const id = await run("2026-02");
    expect((await h.api("admin", "POST", `/payroll/${id}/approve`, {})).status).toBe(200);
    expect(await entryDate(id)).toEqual(["2026-02-28"]);
  });

  it("🔴 a run whose month is CLOSED is refused before anything is written — the message says how to correct it", async () => {
    const closed = await h.api("admin", "POST", "/period-locks", { period: "2026-07" });
    expect([200, 201], JSON.stringify(closed.body)).toContain(closed.status);
    const id = await run("2026-07");
    const before = await entries();
    const r = await h.api("admin", "POST", `/payroll/${id}/approve`, {});
    expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([423, "payroll_period_closed"]);
    expect(r.body.error).toMatch(/2026-07-31/);
    expect(r.body.error).toMatch(/reopen/i);
    expect(await entries(), "nothing written").toBe(before);
    expect((await pool.query(`SELECT status FROM payroll_runs WHERE id = $1`, [id])).rows[0].status, "the run is not approved").not.toBe("approved");
  });
});
