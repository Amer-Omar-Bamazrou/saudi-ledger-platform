/**
 * PHASE 18 · S1 · DR-41 PROOF (research OBS-1) — a payroll run, then the
 * salary bank line accepted as the product suggests. PROOF ONLY, NOT A FIX.
 *
 * Authorised by the owner on 2026-10-11 ("Phase 18 S1: proof tests only").
 * Definition: the owner decision register, DR-41 ("Release a focused proof
 * test: an approved payroll run, then accepting the salary bank line"; the
 * proposed severity is "HIGH if reproduced … MEDIUM if a proof test shows the
 * salary line is not pre-assigned in practice"), and research report §6.16
 * OBS-1.
 *
 * The mechanism (read at HEAD 44427b23):
 *  - payroll approval posts Dr SALARIES (gross) and Cr SALARIES_PAYABLE (net)
 *    (services/payroll.approvable.ts:33-47). Nothing ever debits
 *    SALARIES_PAYABLE: there is no pay path;
 *  - a statement line uploaded with auto-categorisation and described as salary
 *    is PRE-ASSIGNED to the SALARIES expense. The categoriser's rule gives 0.92
 *    (services/categorization/categorizer.ts:855-875), above
 *    AUTO_ASSIGN_CONFIDENCE 0.7 (resolveCategory.ts:72; transactions.service.ts:339);
 *  - "accept ready" (POST /transactions/review/accept with no ids) takes it,
 *    and ACCEPTANCE POSTS Dr SALARIES / Cr bank (transactions.service.ts:542-582;
 *    transactionPosting.service.ts:106-111). The route resolves to the `create`
 *    action (rbac.ts:61), which a BOOKKEEPER holds.
 *
 * The test is driven over HTTP on the real app, as the roles that do this
 * work. The bookkeeper drafts payroll, uploads the statement and accepts; the
 * admin approves payroll.
 *
 * The SAFE invariant: **salaries are expensed ONCE.** After one payroll run and
 * the bank line that pays its net salaries, the SALARIES expense equals the
 * run's gross. It is expected to FAIL on the code as it stands: a failure is
 * the reproduction. The fix (suggest SALARIES_PAYABLE when a run is open, or
 * build a pay path) is DR-39's decision and is not part of S1.
 *
 * Two PREMISE tests carry the evidence the severity depends on. They pass on
 * today's code: the payroll run posts as designed, and the salary line IS
 * pre-assigned to the expense in practice.
 *
 * 🔴 AMENDED 2026-10-21, owner-approved ("re-point premise 2 only"), before landing with the DR-41 fix: owner
 * decision 2.9 stops suggesting the SALARIES expense for salary lines, so the second PREMISE — which asserted that
 * very suggestion, the precondition of the defect — now asserts its replacement: while a payroll run is open, the
 * salary line is pre-assigned to SALARIES_PAYABLE, not the SALARIES expense. PREMISE 1, the PROOF and every other
 * assertion are unchanged.
 *
 * 🔴 KNOWN-FAILING BY DESIGN while DR-41 is present (the G04 proof convention).
 * Uncommitted S1 working-tree file: it stays red until a fix is authorised,
 * and it must not be merged red.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3143";
process.env.SESSION_SECRET ??= "phase18-s1-dr41-proof-session-secret-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "S1DR41ProofPw123!";
const LINE = "SALARY PAYMENT SEP 2026";

describeMaybe("Phase 18 S1 · DR-41 proof — payroll run, then the salary bank line accepted as suggested", () => {
  const h = g04Harness("s1dr41");
  let orgId = "";
  let companyId = "";
  let bankId = 0;
  let gross = 0;
  let netPay = 0;

  /** The company's in-books balance on a system account: Σ (Dr − Cr). */
  const glDr = async (code: string) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.company_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [companyId, code],
    )).rows[0].v);
  const bankGl = async () =>
    Number((await pool.query(
      `SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text AS v
         FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id
        WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bankId],
    )).rows[0].v);
  const salaryLine = async () =>
    (await pool.query(
      `SELECT t.id, t.review_status, t.confidence_score::text AS confidence, t.is_manually_overridden, c.system_code, c.type
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.organization_id = $1 AND t.description = $2`, [orgId, LINE],
    )).rows[0];

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "S1 DR41 Co", "318181818181823");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    // One Saudi employee on 10,000 basic: the fixture the existing payroll suite uses.
    await pool.query(
      `INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, status)
       VALUES ($1,$2,'S1-E001','Salem Al-Otaibi','SA','10000.00','active')`, [orgId, companyId],
    );
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const bank = await h.api("bookkeeper", "POST", "/bank-accounts", { name: "S1 DR41 Main", bankName: "Al Rajhi", currency: "SAR", balance: 0, openingBalance: 0 });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id;
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("PREMISE (control): the approved payroll run posts the gross ONCE to SALARIES and the net to SALARIES_PAYABLE", async () => {
    const created = await h.api("bookkeeper", "POST", "/payroll", { period: "2026-09" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const runId = created.body.id as number;
    expect((await h.api("bookkeeper", "POST", `/payroll/${runId}/submit`, {})).status).toBe(200);
    const approved = await h.api("admin", "POST", `/payroll/${runId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    // Gross as the approval itself computes it (payroll.approvable.ts:27): basic + allowances.
    const run = (await pool.query(`SELECT (total_basic_salary + total_allowances)::text AS g, total_net_pay::text AS n FROM payroll_runs WHERE id = $1`, [runId])).rows[0];
    gross = Number(run.g);
    netPay = Number(run.n);
    // eslint-disable-next-line no-console
    console.warn("[S1 DR41] PAYROLL", JSON.stringify({ gross, netPay, SALARIES: await glDr("SALARIES"), SALARIES_PAYABLE: await glDr("SALARIES_PAYABLE") }));
    expect(gross).toBeGreaterThan(0);
    expect(netPay).toBeGreaterThan(0);
    expect(await glDr("SALARIES")).toBe(gross);
    expect(await glDr("SALARIES_PAYABLE")).toBe(-netPay);
  });

  it("PREMISE (amended 2026-10-21, decision 2.9): while a payroll run is open, the uploaded salary bank line is PRE-ASSIGNED to SALARIES_PAYABLE — not the SALARIES expense — at ≥ 0.7 and waits as 'ready'", async () => {
    expect(netPay, "the payroll premise must have run first").toBeGreaterThan(0);
    const up = await h.api("bookkeeper", "POST", "/transactions/upload", {
      rows: [{ date: "2026-10-05", description: LINE, amount: netPay, currency: "SAR", type: "debit" }],
      autoCategrize: true,
      bankAccountId: bankId,
    });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const row = await salaryLine();
    // eslint-disable-next-line no-console
    console.warn("[S1 DR41] UPLOADED LINE", JSON.stringify(row));
    expect(row.review_status).toBe("pending_review");
    expect([row.system_code, row.type]).toEqual(["SALARIES_PAYABLE", "liability"]);
    expect(Number(row.confidence)).toBeGreaterThanOrEqual(0.7);
    expect(row.is_manually_overridden).toBe(false);
  });

  it("🔴 PROOF: after 'accept ready' on that line, salaries are expensed ONCE (SALARIES = the run's gross)", async () => {
    expect(netPay, "the payroll premise must have run first").toBeGreaterThan(0);
    const bankBefore = await bankGl();
    const accept = await h.api("bookkeeper", "POST", "/transactions/review/accept", {});
    const row = await salaryLine();
    const evidence = {
      accept: { status: accept.status, body: accept.body },
      line: row,
      gross,
      netPay,
      SALARIES: await glDr("SALARIES"),
      SALARIES_PAYABLE: await glDr("SALARIES_PAYABLE"),
      bankMovement: Math.round(((await bankGl()) - bankBefore) * 100) / 100,
    };
    // eslint-disable-next-line no-console
    console.warn("[S1 DR41] AFTER ACCEPT", JSON.stringify(evidence));
    // Precondition: the line was really accepted and posted (otherwise the proof is vacuous).
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);
    expect(row.review_status).toBe("accepted");
    expect(evidence.bankMovement, "precondition: the bank moved by the net pay").toBe(-netPay);
    expect.soft(evidence.SALARIES, "salaries must be expensed once: SALARIES = the run's gross").toBe(gross);
  });
});
