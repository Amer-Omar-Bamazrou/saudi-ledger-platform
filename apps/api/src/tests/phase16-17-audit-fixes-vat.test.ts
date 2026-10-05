/**
 * OB-1 (final audit 2026-10-05; pack phase-16-17 §15) — the VAT obligation reads the SAME return the VAT page files,
 * day 1 of a period included.
 *
 * The obligations calendar passed the period's full DATES to the month-based return, which built "2026-07-01-01" —
 * and, document dates being TEXT, every document dated on a period's FIRST day fell out (obligation 300 where the
 * return was 450; the period to date 0 where 75 was owed). The existing test compared the obligation with the same
 * wrong call, so it confirmed the bug. Here every expected figure is computed FROM THE FIXTURE — each document's VAT,
 * summed by its date window — never by calling the return a second way.
 *
 * Pinned to 2026-11-15: for the QUARTERLY company the last completed period is Q3 (Jul–Sep) and the current one Q4
 * to date; for the MONTHLY company, October and November to date. Documents sit on the first day, the middle and the
 * last day of each period, and on the last day of the PRIOR period (which must stay out).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/shared")>();
  return { ...actual, businessToday: () => "2026-11-15" };
});

import { pool, beginTenantConnection } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { reportsService } from "../services/reports.service";
import { taxObligationsService } from "../services/tax/taxObligations.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-17-audit-fixes-vat] no real DATABASE_URL — skipping.");

describeMaybe("OB-1 — the VAT obligation = the VAT return, day 1 included (pinned 2026-11-15)", () => {
  const SLUG = "p1617-fix-vat", EMAIL = "p1617-fix-vat@test.local";
  let orgId = "", coQ = "", coM = "", userId = 0, customerId = 0, vendorId = 0;
  /** Every VAT-bearing document of the fixture, with its VAT sign (+ output, − claimable input) — the independent truth. */
  const docs: Array<{ co: string; date: string; vat: number }> = [];

  const inCo = async <T,>(company: string, fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId: company, role: "authenticated" });
    try { const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn)); await conn.commit(); return out; }
    catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica");
      const ORGS = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      const { rows } = await c.query(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await c.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email = '${EMAIL}')`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  let seq = 0;
  const sale = async (co: string, date: string, net: number) => {
    const inv = await inCo(co, () => invoicesService.create({ invoiceNumber: `OB1-S-${++seq}`, date, dueDate: date, customerId, items: [{ description: "Service", quantity: 1, unitPrice: net, vatRate: 15 }] }, userId)) as { id: number };
    await inCo(co, () => invoicesService.approve(inv.id, userId));
    docs.push({ co, date, vat: Math.round(net * 15) / 100 });
  };
  const purchase = async (co: string, date: string, net: number) => {
    const b = await inCo(co, () => billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: `OB1-P-${++seq}`, billNumber: `OB1-B-${seq}`, date, dueDate: date, vendorId,
      items: [{ description: "Supply", quantity: 1, unitPrice: net, vatRate: 15 }] }, userId)) as { id: number };
    await inCo(co, () => billsService.approve(b.id, {}, userId));
    docs.push({ co, date, vat: -Math.round(net * 15) / 100 });
  };
  /** The fixture's own VAT for a window — the figure the obligation must equal. */
  const expected = (co: string, from: string, to: string) => Math.round(docs.filter((d) => d.co === co && d.date >= from && d.date <= to).reduce((s, d) => s + d.vat * 100, 0)) / 100;
  const vatRows = async (co: string) => (await inCo(co, () => taxObligationsService.list())).obligations.filter((o) => o.kind === "vat");

  beforeAll(async () => {
    expect(businessToday(), "the pin holds").toBe("2026-11-15");
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('OB-1 VAT','${SLUG}','approved') RETURNING id`)).rows[0].id;
    const company = async (name: string, cr: string, period: string) => {
      const id = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, vat_tax_period) VALUES ($1,$2,1,'gregorian','399999999999993',$3,$4) RETURNING id`, [orgId, name, cr, period])).rows[0].id as string;
      await new Promise((r) => setTimeout(r, 15));
      return id;
    };
    coQ = await company("OB-1 Quarterly", "1010606061", "quarterly");
    coM = await company("OB-1 Monthly", "1010606062", "monthly");
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','OB1',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'OB-1 Customer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'OB-1 Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    // QUARTERLY: prior period's last day · Q3 day 1, middle, last day (+ a day-1 purchase) · Q4 day 1 and to date
    await sale(coQ, "2026-06-30", 800);
    await sale(coQ, "2026-07-01", 1_000);
    await purchase(coQ, "2026-07-01", 400);
    await sale(coQ, "2026-08-15", 2_000);
    await sale(coQ, "2026-09-30", 400);
    await sale(coQ, "2026-10-01", 600);
    await sale(coQ, "2026-11-15", 200);
    // MONTHLY: prior month's last day · October day 1, middle, last day · November day 1
    await sale(coM, "2026-09-30", 500);
    await sale(coM, "2026-10-01", 1_000);
    await sale(coM, "2026-10-16", 300);
    await sale(coM, "2026-10-31", 100);
    await sale(coM, "2026-11-01", 300);
  }, 180_000);
  afterAll(cleanup);

  it("🔴 QUARTERLY — Q3's obligation counts the day-1 sale AND the day-1 purchase, the middle and the last day; the prior quarter stays out", async () => {
    const want = expected(coQ, "2026-07-01", "2026-09-30");
    expect(want, "150 − 60 + 300 + 60 from the fixture").toBe(450);
    const q3 = (await vatRows(coQ)).find((o) => o.reference === "2026-07-01 – 2026-09-30")!;
    expect([q3.returnNet, q3.amount, q3.vatPosition]).toEqual([want, want, "payable"]);
    // the month API the VAT page files from says the same
    expect(Number((await inCo(coQ, () => reportsService.vatReturn("2026-07", "2026-09"))).netVatDue)).toBe(want);
  });

  it("🔴 QUARTERLY — Q4 to date counts its day-1 sale (it read 0 — 'nil' — while VAT was owed)", async () => {
    const want = expected(coQ, "2026-10-01", "2026-11-15");
    expect(want).toBe(120);
    const cur = (await vatRows(coQ)).find((o) => o.reference === "2026-10-01 – 2026-12-31 (to date)")!;
    expect([cur.returnNet, cur.vatPosition]).toEqual([want, "payable"]);
  });

  it("🔴 MONTHLY — October counts day 1, the middle and the last day (the prior month's last day stays out); November to date counts its day 1", async () => {
    const oct = (await vatRows(coM)).find((o) => o.reference === "2026-10-01 – 2026-10-31")!;
    expect(expected(coM, "2026-10-01", "2026-10-31")).toBe(210);
    expect([oct.returnNet, oct.amount]).toEqual([210, 210]);
    const nov = (await vatRows(coM)).find((o) => (o.reference ?? "").startsWith("2026-11-01"))!;
    expect([nov.returnNet, expected(coM, "2026-11-01", "2026-11-15")]).toEqual([45, 45]);
  });

  it("🔴 the month API refuses a full date (it used to build '2026-07-01-01' and drop day 1 silently); the date window refuses a month", async () => {
    for (const [from, to] of [["2026-07-01", "2026-09-30"], ["2026-07", "2026-09-30"]] as const) {
      await expect(inCo(coQ, () => reportsService.vatReturn(from, to))).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(inCo(coQ, () => reportsService.vatReturnBetween("2026-07", "2026-09"))).rejects.toMatchObject({ statusCode: 400 });
    expect(Number((await inCo(coQ, () => reportsService.vatReturnBetween("2026-07-01", "2026-07-01"))).netVatDue), "day 1 alone: 150 − 60").toBe(90);
  });
});
