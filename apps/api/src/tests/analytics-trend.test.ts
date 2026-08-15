/**
 * M19.1 — the trend read model.
 *
 * Two things are load-bearing here, and the second is the one a rewrite loses.
 *
 * 🔴 1. THE TREND MUST AGREE WITH THE BALANCE SHEET IT CHARTS. The trend is a
 * single-pass fold; `reports.balanceSheet(as_of)` is a cumulative re-read. They
 * are two computations of one fact, which is exactly the shape of
 * meta-finding #9 — an income statement showing 0.00 beside a dashboard showing
 * 45,063.25. The M13 AR-agreement pattern applies: when one figure can be
 * derived two ways, PIN THAT THEY AGREE.
 *
 * 🔴 2. PER-POINT `claimable` SURVIVES. M18.3 withholds the liquidity claim
 * when it cannot be stood behind, and Analytics must not chart over time what
 * the hub refuses to state today. But a blocker is a fact about a MOMENT: a
 * suspense balance appearing in June must not retroactively poison March.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { analyticsService } from "../services/analytics.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[analytics-trend] no real DATABASE_URL — skipping.");

const SLUG = "m19-trend";
const EMAIL = "m19-trend@test.local";

describeMaybe("M19.1 — the liquidity/solvency trend", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let entryNo = 0;

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

  async function acct(code: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`,
      [orgId, code],
    );
    return Number(rows[0].id);
  }

  async function post(date: string, debitAccount: number, creditAccount: number, amount: number) {
    entryNo += 1;
    const { rows } = await pool.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status)
       VALUES ($1,$2,$3,$4,'trend fixture','posted') RETURNING id`,
      [orgId, companyId, `TR-${entryNo}`, date],
    );
    const jeId = rows[0].id;
    for (const [account, debit, credit] of [
      [debitAccount, amount, 0],
      [creditAccount, 0, amount],
    ] as const) {
      const { rows: n } = await pool.query(`SELECT name FROM categories WHERE id = $1`, [account]);
      await pool.query(
        `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, companyId, jeId, account, n[0].name, debit, credit],
      );
    }
  }

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const U = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O} OR user_id IN ${U}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U} OR organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Trend Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'TR Co','1010101022') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','TR',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );

    // Feb: cash in, financed by a payable.        → clean
    // Mar: inventory bought on credit.            → clean
    // May: NOTHING happens.                       → balance must persist
    // Jun: a SUSPENSE posting appears.            → Jun onward unclaimable
    await post("2026-02-10", await acct("CASH"), await acct("AP"), 30000);
    await post("2026-03-12", await acct("INVENTORY"), await acct("AP"), 8000);
    await post("2026-04-20", await acct("FIXED_ASSETS"), await acct("LOANS"), 50000);
    await post("2026-06-05", await acct("SUSPENSE"), await acct("CASH"), 1200);
  });

  afterAll(cleanup);

  it("🔴 THE AGREEMENT: every point equals `balanceSheet(as_of)` for that month end", async () => {
    // Two computations of one fact — pinned to agree, the M13 AR pattern.
    const trend = await inTenant(() => analyticsService.trend("2026-02", "2026-06"));
    expect(trend).toHaveLength(5);

    for (const point of trend) {
      const [y, m] = point.period.split("-").map(Number);
      const asOf = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const bs = await inTenant(() => reportsService.balanceSheet(asOf));

      expect(point.currentAssets, `${point.period} current assets`).toBeCloseTo(bs.assets.current.total, 2);
      expect(point.quickAssets, `${point.period} quick assets`).toBeCloseTo(bs.assets.quickTotal, 2);
      expect(point.currentLiabilities, `${point.period} current liabilities`).toBeCloseTo(
        bs.liabilities.current.total,
        2,
      );
      expect(point.netWorth, `${point.period} net worth`).toBeCloseTo(
        bs.assets.total - bs.liabilities.total,
        2,
      );
    }
  });

  it("🔴 PER-POINT claimable: a June blocker does NOT poison March", async () => {
    // The thing a restructuring loses. A blocker is a fact about a moment.
    const trend = await inTenant(() => analyticsService.trend("2026-02", "2026-06"));
    const by = Object.fromEntries(trend.map((p) => [p.period, p]));

    expect(by["2026-02"]!.claimable).toBe(true);
    expect(by["2026-03"]!.claimable).toBe(true);
    expect(by["2026-04"]!.claimable).toBe(true);
    expect(by["2026-05"]!.claimable).toBe(true);

    // June is when the suspense posting lands.
    expect(by["2026-06"]!.claimable).toBe(false);
    const blocker = by["2026-06"]!.blockers.find((b) => b.code === "suspense_balance");
    expect(blocker).toBeDefined();
    expect(blocker!.amount).toBeCloseTo(1200, 2);
  });

  it("a month with NO movement still produces a point, carrying the balance forward", async () => {
    // A balance persists whether or not anything happened. A missing point
    // would read as "no data" when it means "nothing changed".
    const trend = await inTenant(() => analyticsService.trend("2026-02", "2026-06"));
    const april = trend.find((p) => p.period === "2026-04")!;
    const may = trend.find((p) => p.period === "2026-05")!;
    expect(may.currentAssets).toBeCloseTo(april.currentAssets, 2);
    expect(may.currentLiabilities).toBeCloseTo(april.currentLiabilities, 2);
  });

  it("🔴 the window's FIRST point includes everything before it, not just its own month", async () => {
    // The opening position is the whole history. Asking for June alone must not
    // report June's movements as if the company started that month.
    const juneOnly = await inTenant(() => analyticsService.trend("2026-06", "2026-06"));
    const full = await inTenant(() => analyticsService.trend("2026-02", "2026-06"));
    expect(juneOnly).toHaveLength(1);
    expect(juneOnly[0]!.currentAssets).toBeCloseTo(full[4]!.currentAssets, 2);
    expect(juneOnly[0]!.currentLiabilities).toBeCloseTo(full[4]!.currentLiabilities, 2);
  });

  it("inventory is current but NOT quick, and the ratios follow", async () => {
    const trend = await inTenant(() => analyticsService.trend("2026-03", "2026-03"));
    const p = trend[0]!;
    // Cash 30,000 + inventory 8,000 current; only cash is quick.
    expect(p.currentAssets).toBeCloseTo(38000, 2);
    expect(p.quickAssets).toBeCloseTo(30000, 2);
    expect(p.currentLiabilities).toBeCloseTo(38000, 2); // AP
    expect(p.currentRatio).toBeCloseTo(1, 2);
    expect(p.quickRatio).toBeCloseTo(30000 / 38000, 2);
  });

  it("🔴 ratios are NULL, not zero, when there are no current liabilities", async () => {
    // Same discipline as M18.3 — a debt-free position is undefined, not
    // catastrophic. Asserted on a fresh org so the fixture cannot interfere.
    const otherOrg = (
      await pool.query(`INSERT INTO organizations (name, slug) VALUES ('No Debt','${SLUG}-nd') RETURNING id`)
    ).rows[0].id;
    const otherCompany = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'ND','1010101023') RETURNING id`,
        [otherOrg],
      )
    ).rows[0].id;
    try {
      const conn = await beginTenantConnection({
        organizationId: otherOrg,
        companyId: otherCompany,
        role: "authenticated",
      });
      const trend = await conn.run(() =>
        auditContext.run({ userId, organizationId: otherOrg, ipAddress: null }, () =>
          analyticsService.trend("2026-01", "2026-02"),
        ),
      );
      await conn.commit();
      expect(trend).toHaveLength(2);
      expect(trend[0]!.currentRatio).toBeNull();
      expect(trend[0]!.quickRatio).toBeNull();
      expect(trend[0]!.debtToEquity).toBeNull();
      expect(trend[0]!.claimable).toBe(true); // nothing wrong — there is simply nothing
    } finally {
      await pool.query(`DELETE FROM categories WHERE organization_id = $1`, [otherOrg]);
      await pool.query(`DELETE FROM companies WHERE organization_id = $1`, [otherOrg]);
      await pool.query(`DELETE FROM organizations WHERE id = $1`, [otherOrg]);
    }
  });
});
