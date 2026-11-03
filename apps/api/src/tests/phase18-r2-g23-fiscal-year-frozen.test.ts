/**
 * 🔴 Phase 18 R-2 — G23: the fiscal-year start is FIXED once the company has
 * any journal entry in the books (posted or reversed). A change of month, of
 * calendar (the month is read IN the calendar) or a withdrawal is refused with
 * a bilingual refusal naming why; the same value is not a change; a draft
 * freezes nothing. Owner answer 2026-11-01 (register §11.82); the scoped D-4
 * is §11.85, appended before this file.
 *
 * Acts over HTTP, plus one raw statement for the database's own refusal.
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3268";
process.env.SESSION_SECRET ??= "phase18-r2-fiscal-year-frozen-1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18R2OwnPw1!";

describeMaybe("Phase 18 R-2 — G23: the fiscal-year start is fixed once anything is posted", () => {
  const h = g04Harness("p18r2fyf");
  let orgId = "", companyId = "", office = 0, sales = 0;
  const company = async () => (await h.api("admin", "GET", "/companies/current")).body as { fiscalYearStart: number | null; fiscalCalendar: string; fiscalYearStartFrozen?: boolean };
  const patch = (body: Record<string, unknown>) => h.api("admin", "PATCH", "/companies/current", body);
  const rowOf = async () => (await pool.query(`SELECT fiscal_year_start AS m, fiscal_calendar AS cal FROM companies WHERE id = $1`, [companyId])).rows[0] as { m: number | null; cal: string };
  const account = async (code: string) =>
    Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id);
  const entry = async (n: number) => {
    const r = await h.api("admin", "POST", "/journal-entries", {
      date: "2026-05-10", description: `G23 entry ${n}`,
      lines: [
        { accountId: office, accountName: "Office", debitAmount: 100, creditAmount: 0 },
        { accountId: sales, accountName: "Sales", debitAmount: 0, creditAmount: 100 },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const refused = async (body: Record<string, unknown>, what: string) => {
    const r = await patch(body);
    expect([what, r.status, r.body?.code], what).toEqual([what, 409, "fiscal_year_start_frozen"]);
    expect(String(r.body?.error), `${what}: English names why`).toMatch(/posted/i);
    expect(String(r.body?.errorAr), `${what}: Arabic names why`).toMatch(/[؀-ۿ]/);
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "G23 Fiscal Co", "399999999999969");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    office = await account("OFFICE_SUPPLIES");
    sales = await account("SALES");
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("control: with nothing posted the start is free — month, calendar, withdrawal and re-declaration all write, and the company reads NOT frozen", async () => {
    expect((await patch({ fiscalYearStart: 4 })).status).toBe(200);
    expect((await patch({ fiscalCalendar: "hijri", fiscalYearStart: 1 })).status).toBe(200);
    expect((await patch({ fiscalYearStart: null })).status).toBe(200);
    expect((await patch({ fiscalCalendar: "gregorian", fiscalYearStart: 1 })).status).toBe(200);
    const c = await company();
    expect([c.fiscalYearStart, c.fiscalCalendar, c.fiscalYearStartFrozen]).toEqual([1, "gregorian", false]);
  });

  it("a DRAFT entry freezes nothing — it moves nothing in the books", async () => {
    await entry(1);
    expect((await patch({ fiscalYearStart: 7 })).status).toBe(200);
    expect((await patch({ fiscalYearStart: 1 })).status).toBe(200);
    expect((await company()).fiscalYearStartFrozen).toBe(false);
  });

  it("🔴 one POSTED entry: the company reads frozen; a month, a calendar and a withdrawal are each refused with a bilingual refusal, and the row is unchanged", async () => {
    const id = await entry(2);
    expect((await h.api("admin", "POST", `/journal-entries/${id}/post`)).status).toBe(200);
    expect((await company()).fiscalYearStartFrozen).toBe(true);
    await refused({ fiscalYearStart: 4 }, "another month");
    await refused({ fiscalCalendar: "hijri" }, "another calendar");
    await refused({ fiscalYearStart: null }, "a withdrawal");
    await refused({ fiscalCalendar: "hijri", fiscalYearStart: 1 }, "the same month in another calendar");
    expect(await rowOf()).toEqual({ m: 1, cal: "gregorian" });
  });

  it("the SAME month and calendar are not a change, and the company's other fields stay editable", async () => {
    expect((await patch({ fiscalYearStart: 1, fiscalCalendar: "gregorian" })).status).toBe(200);
    const r = await patch({ name: "G23 Fiscal Co (renamed)", fiscalYearStart: 1 });
    expect([r.status, r.body?.name]).toEqual([200, "G23 Fiscal Co (renamed)"]);
    expect(await rowOf()).toEqual({ m: 1, cal: "gregorian" });
  });

  it("🔴 the DATABASE refuses too — a raw update of the start meets the trigger, whatever wrote it", async () => {
    await expect(pool.query(`UPDATE companies SET fiscal_year_start = 4 WHERE id = $1`, [companyId])).rejects.toMatchObject({ constraint: "company_fiscal_year_frozen" });
    await expect(pool.query(`UPDATE companies SET fiscal_calendar = 'hijri' WHERE id = $1`, [companyId])).rejects.toMatchObject({ constraint: "company_fiscal_year_frozen" });
    expect(await rowOf()).toEqual({ m: 1, cal: "gregorian" });
  });

  it("🔴 a REVERSED entry is still in the books: reversing the only posted entry leaves the company frozen", async () => {
    const posted = (await pool.query(`SELECT id FROM journal_entries WHERE company_id = $1 AND status = 'posted' ORDER BY id`, [companyId])).rows as Array<{ id: number }>;
    expect(posted.length).toBeGreaterThan(0);
    for (const e of posted) expect((await h.api("admin", "POST", `/journal-entries/${e.id}/reverse`, { reason: "G23 proof" })).status, `reverse ${e.id}`).toBe(200);
    expect((await company()).fiscalYearStartFrozen).toBe(true);
    await refused({ fiscalYearStart: 4 }, "another month after the reversal");
  });
});
