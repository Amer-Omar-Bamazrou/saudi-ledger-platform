/**
 * M18.4 — closing an accounting period, now that a tenant can actually do it.
 *
 * The capability has been real and tested since M13 (the posting-path guard)
 * and M14 (the company-scoped route fix), but it had NO UI: period locks
 * existed only for tests and manual API calls, and `/period-locks` sat in the
 * route-reachability guard's known-gap list from that guard's creation. The
 * Finance Hub is its first surface.
 *
 * 🔴 The headline test is the M14 REGRESSION, which CLAUDE.md calls "the
 * serious one": before it was fixed, one company's UNLOCK deleted every other
 * company's lock for that period — silently reopening closed books across a
 * multi-company organization. RLS confines these rows to the ORGANIZATION, not
 * to the company, so nothing in the database prevents it; only the explicit
 * `company_id` filter in the repository does.
 *
 * That fix had no permanent test. It has one now, because M18.4 is the
 * milestone that puts the button in front of a user.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { periodLocksService } from "../services/periodLocks.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[period-locks] no real DATABASE_URL — skipping.");

const SLUG = "m18-period-locks";
const EMAIL = "m18-locks@test.local";

describeMaybe("M18.4 — period locks, per company", () => {
  let orgId = "";
  let companyA = "";
  let companyB = "";
  let userId = 0;

  /** Run inside ONE company's tenant context — the distinction under test. */
  async function inCompany<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
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
    await pool.query(`DELETE FROM period_locks WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O} OR user_id IN ${U}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U} OR organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Locks Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyA = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'Company A','1010101016') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    companyB = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'Company B','1010101017') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','LK',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
  });

  afterAll(cleanup);

  it("closes a month, and it comes back in the list", async () => {
    const lock = await inCompany(companyA, () => periodLocksService.lock({ period: "2026-03", userId, notes: "reviewed" }));
    expect(lock.period).toBe("2026-03");
    const list = await inCompany(companyA, () => periodLocksService.list());
    expect(list.map((l) => l.period)).toContain("2026-03");
  });

  it("refuses a malformed period rather than storing it", async () => {
    for (const bad of ["2026", "2026-3", "March 2026", ""]) {
      await expect(
        inCompany(companyA, () => periodLocksService.lock({ period: bad, userId })),
      ).rejects.toThrow(/YYYY-MM/);
    }
  });

  it("refuses to close the same month twice (409)", async () => {
    await expect(
      inCompany(companyA, () => periodLocksService.lock({ period: "2026-03", userId })),
    ).rejects.toThrow(/already locked/i);
  });

  it("🔴 the same month can be closed INDEPENDENTLY by another company", async () => {
    // Pre-M14 this threw "already locked": findByPeriod ignored company_id, so
    // company B could never close a month company A had closed.
    const lock = await inCompany(companyB, () => periodLocksService.lock({ period: "2026-03", userId }));
    expect(lock.period).toBe("2026-03");
  });

  it("🔴 each company sees ONLY its own closed months", async () => {
    await inCompany(companyB, () => periodLocksService.lock({ period: "2026-04", userId }));
    const a = await inCompany(companyA, () => periodLocksService.list());
    const b = await inCompany(companyB, () => periodLocksService.list());
    expect(a.map((l) => l.period).sort()).toEqual(["2026-03"]);
    expect(b.map((l) => l.period).sort()).toEqual(["2026-03", "2026-04"]);
  });

  it("🔴🔴 THE M14 REGRESSION: one company's REOPEN leaves every other company's lock intact", async () => {
    // The defect this pins: `removeByPeriod` without a company filter deleted
    // (organization_id, period) across the board, so company B reopening March
    // silently reopened company A's closed books too. RLS does not prevent it —
    // both rows belong to the same organization.
    await inCompany(companyB, () => periodLocksService.unlock("2026-03"));

    const b = await inCompany(companyB, () => periodLocksService.list());
    expect(b.map((l) => l.period)).not.toContain("2026-03");

    // 🔴 The assertion that matters.
    const a = await inCompany(companyA, () => periodLocksService.list());
    expect(
      a.map((l) => l.period),
      "company A's March lock was destroyed by company B reopening its own March",
    ).toContain("2026-03");

    // …and directly, so the check does not depend on `list()` being correct.
    const { rows } = await pool.query(
      `SELECT company_id FROM period_locks WHERE organization_id = $1 AND period = '2026-03'`,
      [orgId],
    );
    expect(rows.map((r) => r.company_id)).toEqual([companyA]);
  });

  it("reopening is recorded in the audit trail", async () => {
    // Reopening makes frozen figures editable again, so the record of who did
    // it is the only thing that makes the action accountable.
    const { rows } = await pool.query(
      `SELECT action FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'period_lock'
        ORDER BY id DESC LIMIT 10`,
      [orgId],
    );
    const actions = rows.map((r) => String(r.action).toLowerCase()).join(",");
    expect(actions).toMatch(/delete/);
    expect(actions).toMatch(/creat/);
  });

  it("reopening a month that was never closed is a no-op, not an error", async () => {
    await expect(inCompany(companyA, () => periodLocksService.unlock("2019-01"))).resolves.toBeUndefined();
  });
});
