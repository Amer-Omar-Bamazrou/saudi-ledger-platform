/**
 * M19.0 — budget actuals respect DIRECTION.
 *
 * 🔴 The defect: actuals were `sum(amount)`. Amounts are stored POSITIVE with
 * the direction in `type` (CLAUDE.md §4), so every movement counted the same
 * way and **a refund INCREASED "spent"** — buy 5,000, refund 5,000, and the
 * budget reported 10,000 consumed against it instead of nothing.
 *
 * It was tolerable while budgets were an unused corner (a tracked audit
 * leftover). It stops being tolerable the moment Analytics charts the variance
 * (design-analytics.md §7): a wrong number nobody looks at becomes a wrong
 * claim on a chart.
 *
 * The fix is direction by ACCOUNT TYPE — the same split the income statement
 * already applies to GL lines — so both the expense and the income case are
 * pinned here, plus the filters that were already correct and must stay so.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { budgetsService } from "../services/budgets.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[budget-actuals] no real DATABASE_URL — skipping.");

const SLUG = "m19-budget-actuals";
const EMAIL = "m19-budget@test.local";
const YEAR = "2026";

describeMaybe("M19.0 — budget actuals are signed by account type", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let expenseCat = 0;
  let incomeCat = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  /** Insert one accepted, operating transaction against a category. */
  async function tx(
    categoryId: number,
    type: "debit" | "credit",
    amount: number,
    opts: { reviewStatus?: string; kind?: string; date?: string } = {},
  ) {
    await pool.query(
      `INSERT INTO transactions
         (organization_id, company_id, date, description, amount, currency, type,
          category_id, review_status, kind)
       VALUES ($1,$2,$3,$4,$5,'SAR',$6,$7,$8,$9)`,
      [
        orgId,
        companyId,
        opts.date ?? `${YEAR}-06-15`,
        `${type} ${amount}`,
        String(amount),
        type,
        categoryId,
        opts.reviewStatus ?? "accepted",
        opts.kind ?? "operating",
      ],
    );
  }

  async function budgetFor(categoryId: number, amount: number) {
    await pool.query(
      `INSERT INTO budgets (organization_id, company_id, name, name_ar, period, category_id, budgeted_amount)
       VALUES ($1,$2,'Budget','ميزانية',$3,$4,$5)`,
      [orgId, companyId, YEAR, categoryId, String(amount)],
    );
  }

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const U = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM budgets WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O} OR user_id IN ${U}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U} OR organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Budget Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'BG Co','1010101021') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','BG',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    expenseCat = (
      await pool.query(
        `INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable)
         VALUES ($1,'Office Supplies','لوازم مكتبية','expense',false) RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    incomeCat = (
      await pool.query(
        `INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable)
         VALUES ($1,'Service Income','إيرادات خدمات','income',true) RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  });

  afterAll(cleanup);

  it("🔴 THE DEFECT: a refund REDUCES spend on an expense budget — it does not add to it", async () => {
    await budgetFor(expenseCat, 20000);
    await tx(expenseCat, "debit", 5000); // bought
    await tx(expenseCat, "credit", 5000); // returned it

    const [row] = (await inTenant(() => budgetsService.list(YEAR))) as Array<{
      actualAmount: number;
      variance: number;
      categoryName: string | null;
    }>;

    // Pre-fix this was 10,000: sum(amount) counted the refund as more spending.
    expect(row.actualAmount).toBe(0);
    expect(row.variance).toBe(20000);
  });

  it("an ordinary expense still accumulates normally", async () => {
    await tx(expenseCat, "debit", 3000);
    const [row] = (await inTenant(() => budgetsService.list(YEAR))) as Array<{ actualAmount: number }>;
    expect(row.actualAmount).toBe(3000);
  });

  it("🔴 INCOME budgets run the OTHER WAY — earning is credits, a reversal is a debit", async () => {
    // The reason the sign cannot live in the SQL: direction depends on the
    // ACCOUNT TYPE, not on the transaction.
    await pool.query(`DELETE FROM budgets WHERE organization_id = $1`, [orgId]);
    await budgetFor(incomeCat, 100000);
    await tx(incomeCat, "credit", 40000); // earned
    await tx(incomeCat, "debit", 1000); // credit note / reversal

    const [row] = (await inTenant(() => budgetsService.list(YEAR))) as Array<{ actualAmount: number }>;
    expect(row.actualAmount).toBe(39000);
  });

  it("🔴 a negative actual is REPORTED, not clamped to zero", async () => {
    // Refunds exceeding spend is a real state. Flooring it at zero would be the
    // same class of lie as the original bug — a number chosen to look sensible.
    await pool.query(`DELETE FROM budgets WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM transactions WHERE organization_id = $1`, [orgId]);
    await budgetFor(expenseCat, 10000);
    await tx(expenseCat, "credit", 750); // a refund with no matching spend

    const [row] = (await inTenant(() => budgetsService.list(YEAR))) as Array<{ actualAmount: number }>;
    expect(row.actualAmount).toBe(-750);
  });

  it("the filters that were already right stay right — pending and transfers are excluded", async () => {
    await pool.query(`DELETE FROM budgets WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM transactions WHERE organization_id = $1`, [orgId]);
    await budgetFor(expenseCat, 10000);
    await tx(expenseCat, "debit", 1000); // counts
    await tx(expenseCat, "debit", 9999, { reviewStatus: "pending_review" }); // M15 holding area
    await tx(expenseCat, "debit", 8888, { kind: "transfer" }); // M16.2 — not spending
    await tx(expenseCat, "debit", 7777, { date: "2025-06-15" }); // outside the period

    const [row] = (await inTenant(() => budgetsService.list(YEAR))) as Array<{ actualAmount: number }>;
    expect(row.actualAmount).toBe(1000);
  });
});
