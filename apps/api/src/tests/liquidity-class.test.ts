/**
 * M18.1 — the chart of accounts learns current vs non-current.
 *
 * The Finance Hub answers "can I pay what I owe?" from current assets and
 * current liabilities. Before this milestone the chart could not express that
 * distinction at all, so the ratios were unbuildable.
 *
 * Three things are pinned here, and the third is the one that matters most:
 *   1. the classification is complete and correct for the seeded accounts;
 *   2. the invariant holds at the WRITE BOUNDARY, not just in the service;
 *   3. 🔴 the TWO seeding paths agree — the TS chart and the SQL templates are
 *      two id spaces for the same fact, and this is their forcing function.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection, SYSTEM_CHART_OF_ACCOUNTS } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { categoriesService } from "../services/categories.service";

const VALID = ["cash", "quick", "current", "non_current"];

describe("M18.1 — the seeded chart classifies every balance-sheet account", () => {
  it("🔴 every asset/liability in SYSTEM_CHART_OF_ACCOUNTS has a liquidity class", () => {
    // An unclassified seeded account is worse than an unclassified user
    // account: the user never chose it, and it silently drops out of the
    // hub's figures.
    const unclassified = SYSTEM_CHART_OF_ACCOUNTS.filter(
      (a) => (a.type === "asset" || a.type === "liability") && !a.liquidityClass,
    ).map((a) => a.code);
    expect(unclassified, `seeded accounts with no liquidity class: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("🔴 no income/expense/equity account carries one — the distinction is meaningless there", () => {
    const wrong = SYSTEM_CHART_OF_ACCOUNTS.filter(
      (a) => a.type !== "asset" && a.type !== "liability" && a.liquidityClass,
    ).map((a) => a.code);
    expect(wrong).toEqual([]);
  });

  it("only emits values the database will accept", () => {
    for (const a of SYSTEM_CHART_OF_ACCOUNTS) {
      if (a.liquidityClass) expect(VALID).toContain(a.liquidityClass);
    }
  });

  it("CASH is the only `cash` account, and SUSPENSE is current but NOT quick", () => {
    // Suspense is bank money that already moved, so it is current — but the
    // platform cannot say what it IS, so counting it as a QUICK asset would let
    // "money we could not identify" pass as "money you can pay with".
    expect(SYSTEM_CHART_OF_ACCOUNTS.find((a) => a.code === "CASH")?.liquidityClass).toBe("cash");
    expect(SYSTEM_CHART_OF_ACCOUNTS.find((a) => a.code === "SUSPENSE")?.liquidityClass).toBe("current");
  });
});

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[liquidity-class] no real DATABASE_URL — skipping.");

const SLUG = "m18-liquidity";
const EMAIL = "m18-liquidity@test.local";

describeMaybe("M18.1 — against a real database", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;

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

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const U = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O} OR user_id IN ${U}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U} OR organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Liquidity Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'LQ Co','1010101013','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','LQ',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
  });

  afterAll(cleanup);

  it("🔴 THE FORCING FUNCTION: a NEW org is seeded with every balance-sheet account classified", async () => {
    // This org was created by the INSERT above, so the DB TRIGGER seeded it —
    // the other path from `seedChartOfAccounts()`. Migration 0041 had to
    // redefine that trigger to carry the new column; if a future migration adds
    // a column and forgets the trigger again, the next org silently arrives
    // with NULLs and this fails.
    const { rows } = await pool.query(
      `SELECT system_code, type, liquidity_class FROM categories
        WHERE organization_id = $1 AND type IN ('asset','liability')`,
      [orgId],
    );
    expect(rows.length).toBeGreaterThan(5);
    const unclassified = rows.filter((r) => r.liquidity_class == null).map((r) => r.system_code);
    expect(unclassified, `seeded via trigger with no class: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("the owner's two decisions are what actually landed", async () => {
    const { rows } = await pool.query(
      `SELECT system_code, liquidity_class FROM categories
        WHERE organization_id = $1 AND system_code IN ('LOANS','INVESTMENTS','CASH','INVENTORY')`,
      [orgId],
    );
    const byCode = Object.fromEntries(rows.map((r) => [r.system_code, r.liquidity_class]));
    // Deliberately conservative: a loan is all-current, which OVERSTATES current
    // liabilities and so understates the ratio (design §3.2).
    expect(byCode.LOANS).toBe("current");
    // Non-current understates liquidity, the safe direction here.
    expect(byCode.INVESTMENTS).toBe("non_current");
    expect(byCode.CASH).toBe("cash");
    // Current but not quick — inventory is not cash you can pay with.
    expect(byCode.INVENTORY).toBe("current");
  });

  it("🔴 the DB refuses a liquidity class on a non-balance-sheet account", async () => {
    // The invariant lives at the write boundary: an income account marked
    // `quick` would be summed into current assets by any reader that trusts
    // the column.
    await expect(
      pool.query(
        `UPDATE categories SET liquidity_class = 'quick' WHERE organization_id = $1 AND type = 'income'`,
        [orgId],
      ),
    ).rejects.toThrow(/liquidity_class_balance_sheet_only/);
  });

  it("…and refuses a value outside the four", async () => {
    await expect(
      pool.query(
        `UPDATE categories SET liquidity_class = 'someday' WHERE organization_id = $1 AND system_code = 'CASH'`,
        [orgId],
      ),
    ).rejects.toThrow(/liquidity_class_values/);
  });

  it("…but permits NULL, because UNCLASSIFIED must remain expressible", async () => {
    // The hub reports unclassified accounts as a control signal. Forcing a
    // value would mean inventing one, which is how a wrong ratio gets built.
    await expect(
      pool.query(
        `UPDATE categories SET liquidity_class = NULL WHERE organization_id = $1 AND system_code = 'INVENTORY'`,
        [orgId],
      ),
    ).resolves.toBeDefined();
    await pool.query(
      `UPDATE categories SET liquidity_class = 'current' WHERE organization_id = $1 AND system_code = 'INVENTORY'`,
      [orgId],
    );
  });

  it("the service creates a classified asset account, and reads it back", async () => {
    const created = await inTenant(() =>
      categoriesService.create({
        name: "Prepaid Rent",
        nameAr: "إيجار مدفوع مقدماً",
        type: "asset",
        vatApplicable: false,
        liquidityClass: "current",
      } as never),
    );
    expect((created as { liquidityClass?: string }).liquidityClass).toBe("current");

    const list = await inTenant(() => categoriesService.list());
    const found = (list as { name: string; liquidityClass: string | null }[]).find((c) => c.name === "Prepaid Rent");
    expect(found?.liquidityClass).toBe("current");
  });

  it("🔴 the service refuses one on an income account with a readable 400", async () => {
    await expect(
      inTenant(() =>
        categoriesService.create({
          name: "Consulting Income",
          nameAr: "إيرادات استشارية",
          type: "income",
          vatApplicable: true,
          liquidityClass: "quick",
        } as never),
      ),
    ).rejects.toThrow(/asset and liability/i);
  });
});
