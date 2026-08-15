/**
 * M18.2 — current vs non-current on the balance sheet.
 *
 * The Finance Hub answers "can I pay what I owe?" from current assets and
 * current liabilities (design Q1). This is the report change that makes those
 * two figures exist.
 *
 * Two owner requirements, both stated as REQUIREMENTS rather than preferences,
 * and both asserted here as properties rather than as fixed numbers:
 *
 *   1. **The breakout must keep `balanced` reconciling** — the M13 AR-agreement
 *      pattern: when one figure can be derived two ways, pin that they agree.
 *   2. **Unclassified accounts must surface in the totals, visibly**, rather
 *      than vanish. An account that fits no bucket is exactly what a control
 *      surface exists to report.
 *
 * 🔴 The second requirement is enforced by the FIRST one's arithmetic. Because
 * the three buckets partition the same item list, `current + nonCurrent +
 * unclassified === total` can only hold if unclassified items are counted. A
 * future change that quietly dropped them — or folded them into `current` —
 * breaks the partition test, not merely a cosmetic one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[balance-sheet-breakout] no real DATABASE_URL — skipping.");

const SLUG = "m18-breakout";
const EMAIL = "m18-breakout@test.local";
const AS_OF = "2026-12-31";

describeMaybe("M18.2 — the balance sheet splits current from non-current", () => {
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

  /** Account id for a system code in this org. */
  async function acct(code: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`,
      [orgId, code],
    );
    return Number(rows[0].id);
  }

  /** Post a balanced two-line entry directly, so the fixture is unambiguous. */
  async function post(debitAccount: number, creditAccount: number, amount: number) {
    entryNo += 1;
    const { rows } = await pool.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status)
       VALUES ($1,$2,$3,'2026-06-15','breakout fixture','posted') RETURNING id`,
      [orgId, companyId, `BRK-${entryNo}`],
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Breakout Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'BRK Co','1010101018') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','BR',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );

    // A deliberately mixed balance sheet:
    //   Dr CASH 10,000        / Cr LOANS 10,000          current asset / current liability
    //   Dr FIXED_ASSETS 6,000 / Cr AP 6,000              non-current asset / current liability
    //   Dr <unclassified> 900 / Cr AP 900                🔴 the bucket under test
    await post(await acct("CASH"), await acct("LOANS"), 10000);
    await post(await acct("FIXED_ASSETS"), await acct("AP"), 6000);

    // An asset account the tenant never classified. Created directly so it is
    // genuinely NULL — the state the hub must report rather than absorb.
    const { rows: u } = await pool.query(
      `INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable)
       VALUES ($1,'Unclassified Deposit','وديعة غير مصنفة','asset',false) RETURNING id`,
      [orgId],
    );
    await post(Number(u[0].id), await acct("AP"), 900);
  });

  afterAll(cleanup);

  it("🔴 REQUIREMENT 1: the sheet still balances after the breakout", async () => {
    const bs = await inTenant(() => reportsService.balanceSheet(AS_OF));
    expect(bs.balanced, bs.warning ?? "").toBe(true);
    expect(bs.assets.total).toBeCloseTo(bs.totalLiabilitiesAndEquity, 2);
  });

  it("🔴 REQUIREMENT 1: the three buckets PARTITION the total — assets", async () => {
    // The reconciling assertion. Because the buckets are a partition of the
    // same item list, this can only hold if every item lands in exactly one.
    const { assets } = await inTenant(() => reportsService.balanceSheet(AS_OF));
    const sum = assets.current.total + assets.nonCurrent.total + assets.unclassified.total;
    expect(sum).toBeCloseTo(assets.total, 2);
    // …and no item is counted twice.
    const counted =
      assets.current.items.length + assets.nonCurrent.items.length + assets.unclassified.items.length;
    expect(counted).toBe(assets.items.length);
  });

  it("🔴 REQUIREMENT 1: the three buckets PARTITION the total — liabilities", async () => {
    const { liabilities } = await inTenant(() => reportsService.balanceSheet(AS_OF));
    const sum =
      liabilities.current.total + liabilities.nonCurrent.total + liabilities.unclassified.total;
    expect(sum).toBeCloseTo(liabilities.total, 2);
    const counted =
      liabilities.current.items.length +
      liabilities.nonCurrent.items.length +
      liabilities.unclassified.items.length;
    expect(counted).toBe(liabilities.items.length);
  });

  it("🔴 REQUIREMENT 2: an unclassified account SURFACES — it does not vanish or hide in current", async () => {
    const { assets } = await inTenant(() => reportsService.balanceSheet(AS_OF));
    const names = assets.unclassified.items.map((i) => i.name);
    expect(names).toContain("Unclassified Deposit");
    expect(assets.unclassified.total).toBeCloseTo(900, 2);
    // 🔴 And specifically NOT absorbed into current, which is what would
    // silently inflate every liquidity ratio the hub is about to publish.
    expect(assets.current.items.map((i) => i.name)).not.toContain("Unclassified Deposit");
  });

  it("classifies the seeded accounts into the buckets the owner chose", async () => {
    const { assets, liabilities } = await inTenant(() => reportsService.balanceSheet(AS_OF));
    expect(assets.current.items.map((i) => i.name)).toContain("Cash and Bank");
    expect(assets.nonCurrent.items.map((i) => i.name)).toContain("Fixed Assets");
    // LOANS → current, deliberately conservative (design §3.2): it OVERSTATES
    // current liabilities and so understates the ratio.
    expect(liabilities.current.items.map((i) => i.name)).toContain("Loans & Financing");
    expect(liabilities.nonCurrent.items).toEqual([]);
  });

  it("🔴 quickTotal excludes what is current-but-not-quick", async () => {
    // The acid-test numerator M18.3 consumes. Cash is quick; the unclassified
    // deposit is not, even though it is an asset — "we do not know what this
    // is" must never count as "money you can pay with".
    const { assets } = await inTenant(() => reportsService.balanceSheet(AS_OF));
    expect(assets.quickTotal).toBeCloseTo(10000, 2);
    expect(assets.quickTotal).toBeLessThanOrEqual(assets.current.total);
  });

  it("the pre-existing shape is unchanged — items, totals and AR still answer as before", async () => {
    // The breakout is additive. Existing consumers (the Balance Sheet page)
    // read `items` and `total`, and must keep working untouched.
    const bs = await inTenant(() => reportsService.balanceSheet(AS_OF));
    expect(Array.isArray(bs.assets.items)).toBe(true);
    expect(typeof bs.assets.accountsReceivable).toBe("number");
    expect(bs.assets.total).toBeCloseTo(16900, 2); // 10,000 + 6,000 + 900
  });
});
