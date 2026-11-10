/**
 * 🔴 Phase 18 audit (2026-11-09), findings A12 and A13 — a VAT return's months are filed ONCE.
 *
 * A12: `recordVatFiling` checked only a 1–3 month span, and the unique index covers IDENTICAL periods only. A
 * monthly return for May and then a quarterly return for April–June were both accepted, and the quarter's
 * clearing (which subtracts only clearings of the identical period) cleared May's VAT a second time — VAT
 * payable overstated, output VAT pushed to a debit, and nothing able to undo it (filings are append-only and
 * the generic reverse refuses a filing's entry). An ORIGINAL whose months overlap another original's is now
 * refused; the recorded way to change a filed period is an amendment.
 *
 * A13: an amendment was checked only for its reference existing; an amendment of February's return could be
 * recorded for March. It must cover the period of the filing it amends.
 *
 * Presence, absence and movement: the overlapping filing is refused and writes nothing (no row, no clearing,
 * the VAT accounts unmoved); the NON-overlapping return for the same new VAT is accepted and clears it once.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3391";
process.env.SESSION_SECRET ??= "phase18-audit-a12-vat-filing-periods-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18AuditA12FilingsPw1!";

describeMaybe("Phase 18 audit A12/A13 — a VAT return's months are filed once", () => {
  const h = g04Harness("p18auda12");
  let orgId = "", customerId = 0;

  const gl = async (code: string) => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  const counts = async () => {
    const f = (await pool.query(`SELECT count(*)::int n FROM vat_return_filings WHERE organization_id = $1`, [orgId])).rows[0].n;
    const c = (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1 AND source_type = 'vat_return_filing'`, [orgId])).rows[0].n;
    return { filings: f as number, clearings: c as number };
  };
  const sale = async (date: string, unitPrice: number) => {
    const inv = await h.api("admin", "POST", "/invoices", { customerId, date, items: [{ description: "Sale", quantity: 1, unitPrice, vatRate: 15 }] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect((await h.api("admin", "POST", `/invoices/${inv.body.id}/approve`, {})).status).toBe(200);
  };
  const file = (periodFrom: string, periodTo: string, filedOn: string, zatcaReference: string, extra: Record<string, unknown> = {}) =>
    h.api("admin", "POST", "/tax/vat-return-filings", { periodFrom, periodTo, filedOn, zatcaReference, ...extra });

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Audit A12 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'A12 Buyer') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 A12: a quarter ENDING in a filed month is refused and writes nothing; the month that was NOT filed clears once through its own return", async () => {
    await sale("2026-05-10", 1_000); // output VAT 150 in May
    const may = await file("2026-05", "2026-05", "2026-06-20", "A12-RET-2026-05");
    expect(may.status, JSON.stringify(may.body)).toBe(201);
    expect(await gl("VAT_OUTPUT"), "May's output VAT cleared").toBe(0);
    expect(await gl("VAT_PAYMENT"), "May's VAT payable").toBe(-150);

    await sale("2026-06-10", 1_000); // output VAT 150 in June
    const before = await counts();
    const quarter = await file("2026-03", "2026-05", "2026-07-20", "A12-RET-2026-MAR-MAY"); // its last month is the filed May
    expect([quarter.status, quarter.body?.code], JSON.stringify(quarter.body)).toEqual([409, "vat_period_overlaps"]);
    expect(quarter.body?.field).toBe("periodFrom");
    expect(await counts(), "absence: no filing row and no clearing entry").toEqual(before);
    expect(await gl("VAT_OUTPUT"), "absence: May is not cleared twice — June's 150 stands uncleared").toBe(-150);
    expect(await gl("VAT_PAYMENT"), "absence: VAT payable is not overstated").toBe(-150);

    // movement: June, which no return covers yet, is filed on its own and clears exactly once
    const june = await file("2026-06", "2026-06", "2026-07-21", "A12-RET-2026-06");
    expect(june.status, JSON.stringify(june.body)).toBe(201);
    expect(await counts()).toEqual({ filings: before.filings + 1, clearings: before.clearings + 1 });
    expect(await gl("VAT_OUTPUT")).toBe(0);
    expect(await gl("VAT_PAYMENT")).toBe(-300);
  });

  it("🔴 A12: the LAST month of an already-filed quarter is refused too (the overlap is checked at both edges)", async () => {
    await sale("2026-08-10", 2_000); // 300
    const q3 = await file("2026-07", "2026-09", "2026-10-20", "A12-RET-2026-Q3");
    expect(q3.status, JSON.stringify(q3.body)).toBe(201);
    const before = await counts();
    const aug = await file("2026-09", "2026-09", "2026-10-21", "A12-RET-2026-09"); // September is Q3's last month
    expect([aug.status, aug.body?.code], JSON.stringify(aug.body)).toEqual([409, "vat_period_overlaps"]);
    expect(await counts()).toEqual(before);
  });

  it("🔴 A12: two overlapping originals sent at the same moment — exactly one is recorded, and it clears once", async () => {
    await sale("2026-01-10", 1_000); // 150, no return covers January yet
    const before = await counts();
    const vatBefore = await gl("VAT_OUTPUT");
    const [a, b] = await Promise.all([
      file("2026-01", "2026-01", "2026-02-20", "A12-RACE-M01"),
      file("2026-01", "2026-03", "2026-04-20", "A12-RACE-Q1"),
    ]);
    expect([a.status, b.status].sort(), JSON.stringify([a.body, b.body])).toEqual([201, 409]);
    expect(await counts()).toEqual({ filings: before.filings + 1, clearings: before.clearings + 1 });
    expect(await gl("VAT_OUTPUT"), "January's 150 cleared once, not twice").toBe(vatBefore + 150);
  });

  it("🔴 A13: an amendment must cover the period of the filing it amends", async () => {
    const feb = await file("2026-02", "2026-02", "2026-03-20", "A13-RET-2026-02");
    // February is inside the race case's quarter only if that one won; file February only when it is free
    if (feb.status !== 201) expect(feb.body?.code).toBe("vat_period_overlaps");
    const original = feb.status === 201 ? "A13-RET-2026-02" : "A12-RACE-Q1";
    const period = feb.status === 201 ? { from: "2026-02", to: "2026-02" } : { from: "2026-01", to: "2026-03" };
    const before = await counts();
    const wrong = await file("2026-04", "2026-04", "2026-05-20", "A13-AMD-WRONG", { kind: "amendment", amendsZatcaReference: original });
    expect([wrong.status, wrong.body?.code], JSON.stringify(wrong.body)).toEqual([422, "amended_period_mismatch"]);
    expect(await counts(), "nothing written").toEqual(before);
    // the same first month, a different last month: still not the amended return's period
    const wrongEnd = period.from === period.to ? { from: period.from, to: "2026-03" } : { from: period.from, to: period.from };
    const wrong2 = await file(wrongEnd.from, wrongEnd.to, "2026-05-20", "A13-AMD-WRONG-END", { kind: "amendment", amendsZatcaReference: original });
    expect([wrong2.status, wrong2.body?.code], JSON.stringify(wrong2.body)).toEqual([422, "amended_period_mismatch"]);
    expect(await counts(), "nothing written").toEqual(before);
    const right = await file(period.from, period.to, "2026-05-21", "A13-AMD-RIGHT", { kind: "amendment", amendsZatcaReference: original });
    expect(right.status, JSON.stringify(right.body)).toBe(201);
  });
});
