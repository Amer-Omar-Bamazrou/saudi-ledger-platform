/**
 * 🔴 Phase 18 owner decision A15 (2026-11-16) — the generic journal reverse refuses a payroll entry, naming the next
 * step; a payroll run's status is never reset through it.
 *
 * The audit's A15: reversing a payroll run's entry through the generic reverse cancelled the posting while the run
 * still read approved/paid, and paying it again was refused — the books and the run disagreed, with no way back. DR-34
 * already refuses the entries a document owns (an invoice, a note, an allocation …) with words naming that document's
 * own correction. The owner's rule: payroll's entries — the run's accrual, its net pay and its GOSI payment — are
 * refused the same way. Payroll's own correction path is a build item; until it exists the refusal says so.
 *
 * Presence, absence, movement: each of the three payroll entries is refused 409 in words naming payroll and the next
 * step, and nothing moves (no mirror, the entry and the run unchanged); a manual entry still reverses. DB-backed.
 */
process.env.PORT ??= "3392";
process.env.SESSION_SECRET ??= "phase18-owner-a15-payroll-reverse-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "OwnerA15PayrollReversePw1!";

describeMaybe("Phase 18 owner decision A15 — the generic reverse refuses payroll's entries", () => {
  const h = g04Harness("owna15");
  let orgId = "", companyId = "", bankId = 0, runId = 0;

  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await h.api("admin", method, path, body);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body;
  };
  const entryOf = async (sourceType: string) => (await pool.query(
    `SELECT id FROM journal_entries WHERE company_id = $1 AND source_type = $2 AND source_id = $3 AND reversal_of IS NULL`,
    [companyId, sourceType, runId])).rows[0]?.id as number | undefined;
  const state = async (entryId: number) => ({
    status: (await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [entryId])).rows[0].status,
    mirrors: Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE reversal_of = $1`, [entryId])).rows[0].n),
    run: (await pool.query(`SELECT status, gosi_paid_at IS NOT NULL AS gosi_paid FROM payroll_runs WHERE id = $1`, [runId])).rows[0],
  });

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "Owner A15 Co", "318181818181772");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    bankId = (await ok("POST", "/bank-accounts", { name: "A15 Bank", bankName: "SNB", currency: "SAR" })).id;
    await pool.query(
      `INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, housing_allowance, transport_allowance, other_allowances, status, gosi_regime)
       VALUES ($1,$2,'A15-1','A15 Employee','SA',10000,2500,300,0,'active','law_2024')`, [orgId, companyId]);
    runId = (await ok("POST", "/payroll", { period: "2026-10" })).id;
    await ok("POST", `/payroll/${runId}/approve`, {});
    await ok("POST", `/payroll/${runId}/pay`, { bankAccountId: bankId, paidAt: "2026-11-01" });
    await ok("POST", `/payroll/${runId}/gosi/pay`, { bankAccountId: bankId, paidAt: "2026-11-10" });
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  for (const [sourceType, what] of [["payroll_run", "the run's accrual"], ["payroll_net_pay", "its net pay"], ["payroll_gosi_payment", "its GOSI payment"]] as const) {
    it(`🔴 ${what} (${sourceType}) is refused by the generic reverse, in words naming payroll and the next step — and nothing moves`, async () => {
      const id = await entryOf(sourceType);
      expect(id, `fixture: the run posted ${sourceType}`).toBeDefined();
      const before = await state(id!);
      const r = await h.api("admin", "POST", `/journal-entries/${id}/reverse`, { date: "2026-11-15" });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(String(r.body?.error)).toMatch(/payroll/i);
      expect(String(r.body?.error), "the next step is named").toMatch(/journal entry/i);
      expect(await state(id!), "no mirror; the entry and the run as they were").toEqual(before);
      expect(before.status).toBe("posted");
    });
  }

  it("movement: a manual entry still reverses through the generic reverse", async () => {
    const acct = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
    const je = await ok("POST", "/journal-entries", {
      date: "2026-11-02", description: "A15 manual",
      lines: [
        { accountId: await acct("RENT_UTILITIES"), accountName: "rent", debitAmount: 100, creditAmount: 0 },
        { accountId: await acct("OFFICE_SUPPLIES"), accountName: "supplies", debitAmount: 0, creditAmount: 100 },
      ],
    });
    await ok("POST", `/journal-entries/${je.id}/approve`, {});
    const r = await h.api("admin", "POST", `/journal-entries/${je.id}/reverse`, { date: "2026-11-15" });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  });
});
