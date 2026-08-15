/**
 * M18.3 — "can I pay what I owe?"
 *
 * The hub turns these figures into a SENTENCE, and a sentence removes the
 * reader's ability to sanity-check the inputs. So the tests that matter are not
 * the arithmetic ones — they are the ones about when the platform REFUSES to
 * draw a conclusion.
 *
 * 🔴 Owner decision: ANY non-zero suspense balance blocks the plain-language
 * claim. Not a threshold — a threshold would be a number we cannot justify, and
 * a control surface should surface. "Money you could not identify is not money
 * you can pay with", and the error runs OPTIMISTIC, which is the dangerous
 * direction for this particular question.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { financeHubService } from "../services/financeHub.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[finance-hub-liquidity] no real DATABASE_URL — skipping.");

const SLUG = "m18-liquidity-hub";
const EMAIL = "m18-liqhub@test.local";
const AS_OF = "2026-12-31";

describeMaybe("M18.3 — the liquidity block", () => {
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

  async function post(debitAccount: number, creditAccount: number, amount: number) {
    entryNo += 1;
    const { rows } = await pool.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status)
       VALUES ($1,$2,$3,'2026-06-15','liquidity fixture','posted') RETURNING id`,
      [orgId, companyId, `LIQ-${entryNo}`],
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Liq Hub','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'LH Co','1010101019') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','LH',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );

    // Dr CASH 40,000 / Cr AP 40,000
    // Dr INVENTORY 10,000 / Cr AP 10,000
    // Dr FIXED_ASSETS 50,000 / Cr LOANS 50,000
    //   current assets = 40,000 cash + 10,000 inventory      = 50,000
    //   quick assets   = 40,000 cash (inventory is NOT quick) = 40,000
    //   current liabs  = 50,000 AP + 50,000 LOANS             = 100,000
    //     (LOANS counts as current by the owner's deliberately conservative
    //      decision — design §3.2 — which is what makes it 100,000 not 50,000)
    await post(await acct("CASH"), await acct("AP"), 40000);
    await post(await acct("INVENTORY"), await acct("AP"), 10000);
    await post(await acct("FIXED_ASSETS"), await acct("LOANS"), 50000);
  });

  afterAll(cleanup);

  it("computes the figures from the GL, with inventory current but not quick", async () => {
    const l = await inTenant(() => financeHubService.liquidity(AS_OF));
    expect(l.currentAssets).toBeCloseTo(50000, 2);
    expect(l.quickAssets).toBeCloseTo(40000, 2); // 🔴 inventory excluded
    expect(l.currentLiabilities).toBeCloseTo(100000, 2);
    expect(l.workingCapital).toBeCloseTo(-50000, 2);
  });

  it("the ratios are the standard definitions", async () => {
    const l = await inTenant(() => financeHubService.liquidity(AS_OF));
    expect(l.currentRatio).toBeCloseTo(0.5, 2); // 50,000 / 100,000
    expect(l.quickRatio).toBeCloseTo(0.4, 2); // 40,000 / 100,000
  });

  it("a clean book CAN be claimed, and a sub-1 ratio is only an OBSERVATION", async () => {
    const l = await inTenant(() => financeHubService.liquidity(AS_OF));
    expect(l.claimable).toBe(true);
    expect(l.blockers).toEqual([]);
    // 🔴 Severity never exceeds "watch". No standard sets these numbers, so the
    // UI must never render them as a compliance failure.
    expect(l.observations.length).toBeGreaterThan(0);
    expect(l.observations.every((o) => o.severity === "watch")).toBe(true);
  });

  it("🔴 ANY non-zero suspense balance BLOCKS the claim — no threshold", async () => {
    // One riyal is enough, deliberately: a threshold would be a number we
    // cannot justify. Suspense is typed `asset`, so without this it would count
    // toward "money you can pay with" and a MESSIER import would produce a
    // BETTER-looking ratio.
    await post(await acct("SUSPENSE"), await acct("CASH"), 1);

    const l = await inTenant(() => financeHubService.liquidity(AS_OF));
    expect(l.claimable).toBe(false);
    const blocker = l.blockers.find((b) => b.code === "suspense_balance");
    expect(blocker).toBeDefined();
    expect(blocker!.amount).toBeCloseTo(1, 2);
    // The figures are still returned — it is the CLAIM that is withheld, so the
    // user can see the breakdown and the reason together.
    expect(l.currentAssets).toBeGreaterThan(0);
    // …and no observation is offered on figures we just said are unreliable.
    expect(l.observations).toEqual([]);
  });

  it("🔴 an UNCLASSIFIED balance-sheet account also blocks, and reports its size", async () => {
    const { rows } = await pool.query(
      `INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable)
       VALUES ($1,'Unclassified Deposit','وديعة','asset',false) RETURNING id`,
      [orgId],
    );
    await post(Number(rows[0].id), await acct("CASH"), 750);

    const l = await inTenant(() => financeHubService.liquidity(AS_OF));
    expect(l.claimable).toBe(false);
    const blocker = l.blockers.find((b) => b.code === "unclassified_accounts");
    expect(blocker).toBeDefined();
    expect(blocker!.count).toBe(1);
    expect(blocker!.amount).toBeCloseTo(750, 2);
  });

  it("🔴 no current liabilities ⇒ the ratio is NULL, not zero and not Infinity", async () => {
    // A real case (a debt-free company). Zero would read as catastrophic and
    // Infinity renders as garbage; the UI says "you have no short-term
    // obligations" instead. Asserted on a fresh org so the fixture above does
    // not interfere.
    const otherOrg = (
      await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Debt Free','${SLUG}-df') RETURNING id`)
    ).rows[0].id;
    const otherCompany = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'DF Co','1010101020') RETURNING id`,
        [otherOrg],
      )
    ).rows[0].id;
    try {
      const conn = await beginTenantConnection({
        organizationId: otherOrg,
        companyId: otherCompany,
        role: "authenticated",
      });
      const l = await conn.run(() =>
        auditContext.run({ userId, organizationId: otherOrg, ipAddress: null }, () =>
          financeHubService.liquidity(AS_OF),
        ),
      );
      await conn.commit();
      expect(l.currentLiabilities).toBe(0);
      expect(l.currentRatio).toBeNull();
      expect(l.quickRatio).toBeNull();
      expect(l.claimable).toBe(true); // nothing is wrong — there is simply no debt
    } finally {
      await pool.query(`DELETE FROM categories WHERE organization_id = $1`, [otherOrg]);
      await pool.query(`DELETE FROM companies WHERE organization_id = $1`, [otherOrg]);
      await pool.query(`DELETE FROM organizations WHERE id = $1`, [otherOrg]);
    }
  });
});
