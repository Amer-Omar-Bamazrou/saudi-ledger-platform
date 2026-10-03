/**
 * M19.0 → Phase 15 — budget actuals respect DIRECTION, now from THE LEDGER.
 *
 * 🔴 The M19.0 defect: actuals were `sum(amount)`, so a refund INCREASED
 * "spent" — buy 5,000, refund 5,000, and the budget reported 10,000 consumed.
 * The fix was direction by ACCOUNT TYPE. Phase 15 (D15-06) moved the source
 * from `transactions` to the posted GL (the P&L's own basis), so every property
 * this file pinned is re-pinned on journal lines the product posted:
 *
 *   · a credit to an expense account (a refund) REDUCES spend;
 *   · an income account runs the other way;
 *   · a negative actual is REPORTED, not clamped;
 *   · what is not in the books (a DRAFT entry) and what is outside the fiscal
 *     year does not count — the successors of M19's "pending" and "period"
 *     filters (a transfer never reaches a P&L account under A, so M19's
 *     transfer filter has no ledger counterpart).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { budgetsService } from "../services/budgets.service";
import { journalEntriesService } from "../services/journalEntries.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[budget-actuals] no real DATABASE_URL — skipping.");

const SLUG = "m19-budget-actuals";
const EMAIL = "m19-budget@test.local";

describeMaybe("M19.0 / Phase 15 — budget actuals are the ledger, signed by account type", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let expenseCat = 0;
  let incomeCat = 0;
  let clearing = 0;
  let seq = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  /** Post (or leave as a draft) one two-line entry: `account` debited or credited against a clearing account. */
  async function je(account: number, side: "debit" | "credit", amount: number, opts: { date?: string; draft?: boolean } = {}) {
    const lines = side === "debit"
      ? [{ accountId: account, debitAmount: amount, creditAmount: 0 }, { accountId: clearing, debitAmount: 0, creditAmount: amount }]
      : [{ accountId: clearing, debitAmount: amount, creditAmount: 0 }, { accountId: account, debitAmount: 0, creditAmount: amount }];
    await inTenant(async () => {
      const e = (await journalEntriesService.create({ entryNumber: `BA-${++seq}`, date: opts.date ?? "2026-06-15", description: `${side} ${amount}`, lines }, userId)) as { id: number };
      if (!opts.draft) await journalEntriesService.approve(e.id, userId);
    });
  }

  /** A fresh approved budget holding ONE annual line, and its year-to-date figure for that account. */
  async function actualFor(account: number, budgeted: number) {
    return inTenant(async () => {
      const b = await budgetsService.create({ name: `B${++seq}`, fiscalYearLabel: 2026 }, userId);
      await budgetsService.replaceLines(b.id, b.version!.id, { lines: [{ accountId: account, periods: Array(12).fill(budgeted / 12) }] });
      await budgetsService.approve(b.id, b.version!.id, userId);
      const vs = await budgetsService.vsActual(b.id, { through_period: 12 });
      return vs.lines[0]!;
    });
  }

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const U = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // approved budget versions are immutable at the database (0112): triggers off, children first
      await client.query("SET LOCAL session_replication_role = replica");
      for (const t of ["budget_lines", "budget_versions", "budgets", "journal_entry_lines", "journal_entries"]) await client.query(`DELETE FROM ${t} WHERE organization_id IN ${O}`);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O} OR user_id IN ${U}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U} OR organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('Budget Org','${SLUG}','approved') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'BG Co','1010101021',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','BG',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    const cat = async (name: string, type: string) => (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable) VALUES ($1,$2,$2,$3,false) RETURNING id`, [orgId, name, type])).rows[0].id as number;
    expenseCat = await cat("Office Supplies", "expense");
    incomeCat = await cat("Service Income", "income");
    clearing = await cat("Budget test clearing", "asset");
  }, 60_000);

  afterAll(cleanup);

  it("🔴 THE DEFECT: a refund REDUCES spend on an expense budget — it does not add to it", async () => {
    await je(expenseCat, "debit", 5000); // bought
    await je(expenseCat, "credit", 5000); // returned it
    const line = await actualFor(expenseCat, 24000);
    // Pre-M19.0 this was 10,000: the refund counted as more spending.
    expect([line.ytd.actual, line.ytd.variance, line.ytd.favourable]).toEqual([0, -24000, true]);
  });

  it("an ordinary expense accumulates normally", async () => {
    await je(expenseCat, "debit", 3000);
    expect((await actualFor(expenseCat, 24000)).ytd.actual).toBe(3000);
  });

  it("🔴 INCOME runs the OTHER WAY — earning is a credit, a reversal a debit; and a shortfall is unfavourable", async () => {
    await je(incomeCat, "credit", 40000); // earned
    await je(incomeCat, "debit", 1000); // a credit note / reversal
    const line = await actualFor(incomeCat, 120000);
    expect([line.accountType, line.ytd.actual, line.ytd.variance, line.ytd.favourable]).toEqual(["income", 39000, -81000, false]);
  });

  it("🔴 a negative actual is REPORTED, not clamped to zero", async () => {
    await je(expenseCat, "credit", 3750); // a refund beyond the 3,000 spent
    expect((await actualFor(expenseCat, 12000)).ytd.actual).toBe(-750);
  });

  it("what is not in the books does not count — a DRAFT entry, or one outside the fiscal year", async () => {
    const before = (await actualFor(expenseCat, 12000)).ytd.actual;
    await je(expenseCat, "debit", 9999, { draft: true }); // not in the books
    await je(expenseCat, "debit", 7777, { date: "2025-12-31" }); // the previous fiscal year
    await je(expenseCat, "debit", 6666, { date: "2027-01-01" }); // the next one
    expect((await actualFor(expenseCat, 12000)).ytd.actual).toBe(before);
  });
});
