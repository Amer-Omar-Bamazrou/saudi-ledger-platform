/**
 * THE LISTS THAT ARE DELIBERATELY NOT PAGINATED, AND THE TEST THAT KEEPS THAT
 * A DECISION RATHER THAN AN ACCIDENT.
 *
 * ── 🔴 WHY SOME LISTS SHOULD NOT PAGINATE ──────────────────────────────────
 * B-6's rule cuts both ways: "capped where it should be unbounded and unbounded
 * where it should be capped is ONE disease pointing both ways". The question is
 * never "is there a limit" but "does the number shown describe the set the user
 * thinks it describes".
 *
 * These four lists are bounded by a real-world fact, not by business volume:
 *
 *   /bank-accounts  a tenant has a handful, and it fills the account picker on
 *                   the statement-upload screen
 *   /categories     the chart of accounts, seeded per organization — and the
 *                   account picker on the journal-entry screen, which is the
 *                   posting path. A page of 50 there would silently remove
 *                   accounts a tenant cannot then post to.
 *   /budgets        one per category per period
 *   /payroll        one run per month
 *   /recurring      a handful of rules a tenant set up by hand
 *
 * Paginating them would add a control nobody needs and, for the two picker
 * sources, would quietly remove options — the worse half of the same disease.
 *
 * ── WHY THIS IS A TEST AND NOT A COMMENT ───────────────────────────────────
 * Their pages compute headline figures by `reduce`ing over the fetched array,
 * which is correct EXACTLY while the list is complete. So "unbounded" stops
 * being a preference and becomes a precondition of those figures being true.
 * The day someone adds `.limit(50)` for performance, every one of those
 * headlines silently becomes "the total of the first 50" — and nothing would
 * have said so.
 *
 * 🔴 The fixture is LARGER than the default page, because a test at page size
 * passes against both the capped and the uncapped code. That is B-6's other
 * lesson: small fixtures are structurally blind to any defect whose trigger is
 * volume.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3143";
process.env.SESSION_SECRET ??= "unpaginated-by-decision-secret-0123456789";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { DEFAULT_PAGE } from "../lib/httpParams";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "unpaginated-by-decision";
/** Deliberately more than one page, and not a multiple of it. */
const ROWS = DEFAULT_PAGE + 13; // 63

async function inTenant<T>(orgId: string, companyId: string, fn: () => Promise<T>): Promise<T> {
  const { beginTenantConnection } = await import("@workspace/db");
  const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
  try {
    const out = await conn.run(fn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  }
}

describeMaybe("lists that are unbounded by decision stay unbounded", () => {
  let orgId = "";
  let companyId = "";

  const wipe = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    for (const t of ["recurring_runs", "recurring_rules", "payroll_runs", "budgets", "bank_accounts", "categories"]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
    }
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await wipe();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status)
         VALUES ('Unbounded Org','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Unbounded Co') RETURNING id`, [
        orgId,
      ])
    ).rows[0].id;

    const catValues: string[] = [];
    const bankValues: string[] = [];
    const runValues: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      const n = String(i).padStart(3, "0");
      catValues.push(`($1, 'Unbounded Cat ${n}', 'فئة ${n}', 'expense')`);
      bankValues.push(`($1, $2, 'Unbounded Acct ${n}', 'Unbounded Bank')`);
      // One run per month, walking back from 2026-12 so the periods are distinct.
      const month = String((i % 12) + 1).padStart(2, "0");
      runValues.push(`($1, $2, '${2020 + Math.floor(i / 12)}-${month}')`);
    }
    await pool.query(
      `INSERT INTO categories (organization_id, name, name_ar, type) VALUES ${catValues.join(",")}`,
      [orgId],
    );
    await pool.query(
      `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ${bankValues.join(",")}`,
      [orgId, companyId],
    );
    await pool.query(
      `INSERT INTO payroll_runs (organization_id, company_id, period) VALUES ${runValues.join(",")}`,
      [orgId, companyId],
    );

    const ruleValues: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      ruleValues.push(
        `($1, $2, 'invoice', '{}'::jsonb, 'monthly', 1, '2026-01-01', '2026-02-01')`,
      );
    }
    await pool.query(
      `INSERT INTO recurring_rules (organization_id, company_id, entity, template, frequency,
                                    day_of_month, starts_on, next_run_on)
       VALUES ${ruleValues.join(",")}`,
      [orgId, companyId],
    );

    // Budgets need a category; one is enough, the period makes each row distinct.
    const catId = (
      await pool.query(`SELECT id FROM categories WHERE organization_id = $1 LIMIT 1`, [orgId])
    ).rows[0].id;
    const budgetValues: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      budgetValues.push(`($1, $2, 'Unbounded Budget ${i}', '${1960 + i}', $3, 1000)`);
    }
    await pool.query(
      `INSERT INTO budgets (organization_id, company_id, name, period, category_id, budgeted_amount)
       VALUES ${budgetValues.join(",")}`,
      [orgId, companyId, catId],
    );
  }, 60_000);

  afterAll(wipe);

  it("the fixture is LARGER than a page (anti-vacuity)", async () => {
    const { rows } = await pool.query(`SELECT count(*)::int n FROM categories WHERE organization_id = $1`, [orgId]);
    expect(rows[0].n).toBeGreaterThanOrEqual(ROWS);
    expect(ROWS).toBeGreaterThan(DEFAULT_PAGE);
  });

  /**
   * The expected count is READ FROM THE DATABASE, not asserted as ROWS: the
   * org-seed trigger plants a chart of accounts on every new organization, so
   * this tenant holds the fixture PLUS the seed. Hard-coding the fixture size
   * would have been a wrong number that happened to look deliberate.
   */
  const cases: Array<[string, string, () => Promise<{ length: number }>]> = [
    ["/categories", "categories", async () => (await import("../services/categories.service")).categoriesService.list()],
    ["/bank-accounts", "bank_accounts", async () => (await import("../services/bankAccounts.service")).bankAccountsService.list()],
    ["/budgets", "budgets", async () => (await import("../services/budgets.service")).budgetsService.list()],
    ["/payroll", "payroll_runs", async () => (await import("../services/payroll.service")).payrollService.list()],
    ["/recurring", "recurring_rules", async () => (await import("../services/recurring/recurring.service")).recurringService.list()],
  ];

  for (const [endpoint, table, list] of cases) {
    it(`🔴 ${endpoint} returns every row, not a page`, async () => {
      const { rows: countRows } = await pool.query(
        `SELECT count(*)::int n FROM ${table} WHERE organization_id = $1`,
        [orgId],
      );
      const expected = countRows[0].n as number;
      expect(expected, `${table} holds ${expected} rows, which is not more than a page`).toBeGreaterThan(
        DEFAULT_PAGE,
      );
      const rows = await inTenant(orgId, companyId, list);
      expect(
        rows.length,
        `${endpoint} returned ${rows.length} of ${expected} rows.\n\n` +
          `This list is unbounded BY DECISION: it is bounded by a real-world fact (a handful of\n` +
          `bank accounts, one budget per category, one payroll run per month, one chart of\n` +
          `accounts), and its page computes headline figures by reducing over the fetched array.\n` +
          `A cap here does not truncate a table — it silently turns every one of those figures\n` +
          `into "the total of the first ${DEFAULT_PAGE}", and for /categories and /bank-accounts it also\n` +
          `removes options from a picker on the posting path.\n\n` +
          `If this list must be capped, paginate it PROPERLY: move its totals into SQL and give\n` +
          `the page a control, the way /customers and /invoices do. Do not just add a limit.`,
      ).toBe(expected);
    });
  }
});
