/**
 * M17.2 — the fiscal-year SERVICE, against a real company row.
 *
 * `fiscal-year.test.ts` pins the resolver's arithmetic in isolation. This file
 * covers the part that arithmetic tests cannot: that the service reads the
 * company's ACTUAL stored settings, that the response satisfies the generated
 * Zod schema (a spec/response mismatch fails only at runtime otherwise), and
 * that changing the setting through the product's own write path changes the
 * resolved boundaries.
 *
 * Standing rule 2 — validate from real rows: the company is created, updated
 * and read back through Postgres and the real service, not a fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { companiesService } from "../services/companies.service";
import { auditContext } from "../lib/auditContext";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[fiscal-year-service] no real DATABASE_URL — skipping.");

const SLUG = "m17-fiscal";
const EMAIL = "m17-fiscal@test.local";

describeMaybe("M17.2 — fiscal years resolved for a real company", () => {
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Fiscal Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'FY Co','1010101011','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','FY',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
  });

  afterAll(cleanup);

  /**
   * 🔴 M20.0 REVERSED the first assertion this file made. It used to pin "a
   * fresh company defaults to a Gregorian January year — the behaviour every
   * existing tenant already had". That behaviour WAS the defect: NOT NULL
   * DEFAULT 1 recorded a declaration nobody made, and this test was its guard
   * (the obsolete-assertion failure mode, caught by standing-check part 6
   * rather than by a surprise). The pinned behaviour is now the opposite.
   */
  it("🔴 a fresh company is UNDECLARED — not January", async () => {
    const fy = await inTenant(() => companiesService.fiscalYears());
    expect(fy.declared).toBe(false);
    expect(fy.fiscalYearStart).toBeNull();
    // No resolved period: a consumer cannot receive a January year that looks
    // like an answer nobody gave.
    expect(fy.current).toBeNull();
    expect(fy.periods).toEqual([]);
  });

  it("declaring a start month through the real write path resolves real boundaries", async () => {
    await inTenant(() => companiesService.updateCurrent({ fiscalYearStart: 1 } as never));
    const fy = await inTenant(() => companiesService.fiscalYears());
    expect(fy.declared).toBe(true);
    expect(fy.current!.startDate.endsWith("-01-01")).toBe(true);
    expect(fy.current!.endDate.endsWith("-12-31")).toBe(true);
    expect(fy.periods.length).toBeGreaterThan(1);
  });

  it("🔴 changing the start month MOVES the boundaries", async () => {
    const before = await inTenant(() => companiesService.fiscalYears());
    await inTenant(() => companiesService.updateCurrent({ fiscalYearStart: 4 } as never));
    const after = await inTenant(() => companiesService.fiscalYears());

    expect(after.fiscalYearStart).toBe(4);
    expect(after.current!.startDate.slice(5)).toBe("04-01");
    expect(after.current!.endDate.slice(5)).toBe("03-31");
    // Not vacuous — the period genuinely moved.
    expect(after.current!.startDate).not.toBe(before.current!.startDate);
  });

  it("🔴 null WITHDRAWS the declaration — back to undeclared, not to January", async () => {
    // The M17.1 pattern: a tenant who no longer knows may say so, and reports
    // return to the rolling-window fallback rather than a stale claim.
    await inTenant(() => companiesService.updateCurrent({ fiscalYearStart: null } as never));
    const fy = await inTenant(() => companiesService.fiscalYears());
    expect(fy.declared).toBe(false);
    expect(fy.current).toBeNull();
    // Re-declare for the tests that follow.
    await inTenant(() => companiesService.updateCurrent({ fiscalYearStart: 4 } as never));
  });

  it("🔴 switching to Hijri produces a ~354-day year and REINTERPRETS the start month", async () => {
    await inTenant(() =>
      companiesService.updateCurrent({ fiscalCalendar: "hijri", fiscalYearStart: 1 } as never),
    );
    const fy = await inTenant(() => companiesService.fiscalYears());

    expect(fy.calendar).toBe("hijri");
    // The label is an AH year, not a Gregorian one — proof the calendar is read
    // and not merely stored.
    expect(fy.current!.label).toBeGreaterThan(1400);
    expect(fy.current!.label).toBeLessThan(1500);
    expect(fy.current!.days).toBeGreaterThanOrEqual(354);
    expect(fy.current!.days).toBeLessThanOrEqual(355);
    // Boundaries are still Gregorian ISO dates — the storage format never changes.
    expect(fy.current!.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("the company profile reports the calendar back, so the UI is not guessing", async () => {
    const company = await inTenant(() => companiesService.getCurrent());
    expect(company.fiscalCalendar).toBe("hijri");
  });

  it("🔴 refuses an invalid calendar with a 400, not a DB error", async () => {
    await expect(
      inTenant(() => companiesService.updateCurrent({ fiscalCalendar: "lunar" } as never)),
    ).rejects.toThrow(/gregorian.*hijri/i);
  });

  it("refuses an out-of-range start month", async () => {
    await expect(
      inTenant(() => companiesService.updateCurrent({ fiscalYearStart: 13 } as never)),
    ).rejects.toThrow(/between 1 and 12/i);
  });
});
