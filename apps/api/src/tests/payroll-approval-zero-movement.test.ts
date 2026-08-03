/**
 * Payroll draft/approval — ZERO-MOVEMENT proof (M10.5), the entity template
 * applied to payroll runs (spec §7).
 *
 * A payroll run's only ledger effect is the GL entry posted at approval — no
 * report reads `payroll_runs` directly. So this proves, through the REAL report
 * services, that a run at every pre-approval state (`draft` AND `submitted`)
 * posts NOTHING to the ledger (zero in the trial balance and the salaries-expense
 * general ledger), and that APPROVAL is what posts the payroll GL entry — plus
 * the submit → send-back → resubmit → approve loop, reject hard-delete, and the
 * audited transitions.
 *
 * Needs a real database; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { payrollService } from "../services/payroll.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[payroll-approval] no real DATABASE_URL — skipping zero-movement test.");
}

describeMaybe("Payroll draft/approval — pre-approval states post nothing; approval posts the GL", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;

  // One Saudi employee, basic 10000, no allowances:
  //   gross 10000, GOSI emp 975 (9.75%), GOSI er 1175 (11.75%), net 9025.
  //   GL Dr Salaries 10000 + Dr GOSI-er 1175 = 11175 ; Cr Net 9025 + Cr GOSI 2150 = 11175.
  const GROSS = 10000;
  const TOTAL_DEBIT = 11175;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.13" }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    if (orgId) {
      await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM journal_entries WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM payroll_items WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM payroll_runs WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM employees WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [orgId]);
    }
    if (userId) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE email = 'pay-approval@test.local'`);
    await pool.query(`DELETE FROM companies WHERE name = 'PAY-APPR Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'pay-appr'`);
  };

  beforeAll(async () => {
    await pool.query(`DELETE FROM organizations WHERE slug = 'pay-appr'`);
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('PAY-APPR Org','pay-appr') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'PAY-APPR Co','1010101010','399999999999993') RETURNING id`, [orgId])).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('pay-approval@test.local','Pay Approver',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    await pool.query(
      `INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, status)
       VALUES ($1,$2,'E001','Salem Al-Otaibi','SA','10000.00','active')`,
      [orgId, companyId],
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  async function expectZeroLedger(label: string) {
    const tb = await reportsService.trialBalance();
    expect(tb.totalDebit, `${label}: trial-balance debit`).toBe(0);
    expect(tb.totalCredit, `${label}: trial-balance credit`).toBe(0);
    const gl = await reportsService.generalLedger(undefined, "Salaries and Wages Expense");
    expect(gl.movements, `${label}: salaries GL movements`).toHaveLength(0);
  }

  let runId = 0;

  it("creates a payroll run as a draft", async () => {
    const run = await inTenant(() => payrollService.create({ period: "2026-06" }, userId));
    runId = run.id;
    expect(run.status).toBe("draft");
    expect(run.totalNetPay).toBe(9025);
  });

  it("DRAFT: posts nothing to the ledger", async () => {
    await inTenant(() => expectZeroLedger("draft"));
  });

  it("SUBMIT (draft → submitted): still posts nothing", async () => {
    const run = await inTenant(() => payrollService.submit(runId, userId));
    expect(run.status).toBe("submitted");
    await inTenant(() => expectZeroLedger("submitted"));
  });

  it("SEND-BACK (submitted → draft) with a note: still nothing, note surfaced", async () => {
    const run = await inTenant(() => payrollService.sendBack(runId, "Re-check GOSI for expats", userId));
    expect(run.status).toBe("draft");
    expect(run.reviewNote).toBe("Re-check GOSI for expats");
    await inTenant(() => expectZeroLedger("sent-back draft"));
  });

  it("RESUBMIT then APPROVE posts the payroll GL entry", async () => {
    await inTenant(() => payrollService.submit(runId, userId));
    const approved = await inTenant(() => payrollService.approve(runId, userId));
    expect(approved.status).toBe("approved");
    expect(approved.processedAt).not.toBeNull();
    expect(approved.reviewNote).toBeNull();
  });

  it("APPROVED: the payroll movement now appears in the ledger", async () => {
    await inTenant(async () => {
      const tb = await reportsService.trialBalance();
      expect(tb.totalDebit).toBe(TOTAL_DEBIT);
      expect(tb.totalCredit).toBe(TOTAL_DEBIT);
      expect(tb.balanced).toBe(true);

      const gl = await reportsService.generalLedger(undefined, "Salaries and Wages Expense");
      expect(gl.movements).toHaveLength(1);
      expect(gl.movements[0].debit).toBe(GROSS);
    });
  });

  it("records every transition in the audit trail", async () => {
    const rows = (
      await pool.query(
        `SELECT action FROM audit_logs WHERE entity_type = 'payroll_run' AND entity_id = $1 ORDER BY created_at ASC`,
        [String(runId)],
      )
    ).rows.map((r) => r.action);
    for (const action of ["create", "submit", "send_back", "approve"]) {
      expect(rows, `audit should contain ${action}`).toContain(action);
    }
  });

  it("reject hard-deletes a non-approved run (items cascade)", async () => {
    const run = await inTenant(() => payrollService.create({ period: "2026-07" }, userId));
    await inTenant(() => payrollService.reject(run.id, userId));
    expect((await pool.query(`SELECT id FROM payroll_runs WHERE id = $1`, [run.id])).rowCount).toBe(0);
    expect((await pool.query(`SELECT id FROM payroll_items WHERE payroll_run_id = $1`, [run.id])).rowCount).toBe(0);
  });
});
