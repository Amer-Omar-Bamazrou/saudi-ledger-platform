/**
 * 🔴 F-25 (pre-merge audit of PR #189, 2026-10-02) — TODAY's ageing and a
 * settlement dated AFTER today.
 *
 * D14-02 / D14-08: an ageing as of a date counts documents dated on or before
 * it and settlements EFFECTIVE on or before it. Phase 14 kept today's ageing on
 * the subledger caches, which hold every settlement whatever its accounting
 * date — so a post-dated payment (or a credit note dated later) took its
 * invoice out of today's ageing while the GL, and the balance sheet as of
 * today, still carried it: AR ageing 230 against a balance-sheet AR of 1,610
 * on the audit's probe, and yesterday's ageing (the replay) read 1,610 — the
 * ageing FELL overnight with nothing having happened.
 *
 * Presence, absence and movement (CLAUDE.md §3):
 *  - presence: a post-dated payment leaves its invoice in today's ageing, and
 *    the ageing equals the GL control as of today, non-zero;
 *  - absence: a document dated after today is not in it;
 *  - movement: a payment dated TODAY does take its invoice out — the ageing is
 *    not simply ignoring payments.
 * Dates are relative to the business day, so "after today" stays after today.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { reportsService } from "../services/reports.service";
import { purgeInputVatLedger } from "./helpers/purgeInputVatLedger";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase14-ageing-post-dated-settlements] no real DATABASE_URL — skipping.");

const SLUG = "p14-postdated";
const EMAIL = "p14-postdated@test.local";
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
};

describeMaybe("F-25 — today's ageing never counts a settlement dated after today", () => {
  const T = businessToday();
  let orgId = "", coId = "";
  let userId = 0;
  const ids: Record<string, number> = {};

  const inCo = async <R,>(fn: () => Promise<R>): Promise<R> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId: coId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    await purgeInputVatLedger(`SELECT id FROM organizations WHERE slug = '${SLUG}'`);
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${O})`);
      await c.query(`DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id IN ${O})`);
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${O}`);
      await c.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const invoice = async (n: string, date: string, due: string, unitPrice: number) => {
    const inv = await inCo(() => invoicesService.create({ invoiceNumber: n, date, dueDate: due, customerId: ids.customer, items: [{ description: "S", quantity: 1, unitPrice, vatRate: 15 }] }, userId)) as { id: number };
    await inCo(() => invoicesService.approve(inv.id, userId));
    return inv.id;
  };
  const position = async () => {
    const [ar, ap, bs] = await Promise.all([inCo(() => reportsService.arAging()), inCo(() => reportsService.apAging()), inCo(() => reportsService.balanceSheet(T))]);
    return { ar, ap, bs, arItems: Object.fromEntries(ar.items.map((i) => [i.invoiceNumber, i.outstanding])), apItems: Object.fromEntries(ap.items.map((i) => [i.billNumber, i.outstanding])) };
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P14 post-dated','${SLUG}','approved') RETURNING id`)).rows[0].id;
    coId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'P14 post-dated co','1010660001','300000000000043',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P14',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    ids.bank = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Main','SNB') RETURNING id`, [orgId, coId])).rows[0].id;
    ids.customer = (await pool.query(`INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'Client','300000000000063') RETURNING id`, [orgId])).rows[0].id;
    ids.vendor = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'Supplier','300000000000073') RETURNING id`, [orgId])).rows[0].id;
    ids.invPast = await invoice("PD-INV-PAST", addDays(T, -20), addDays(T, -10), 1000);  // 1,150
    ids.invC = await invoice("PD-INV-C", addDays(T, -5), addDays(T, 25), 400);            //   460
    ids.invToday = await invoice("PD-INV-TODAY", addDays(T, -3), addDays(T, 27), 100);    //   115
    const bill = await inCo(() => billsService.create({ billNumber: "PD-BILL", date: addDays(T, -20), dueDate: addDays(T, -5), vendorId: ids.vendor, vendorReference: "PD-1", supplierDocumentKind: "tax_invoice", items: [{ description: "G", quantity: 1, unitPrice: 600, vatRate: 15 }] }, userId)) as { id: number };
    await inCo(() => billsService.approve(bill.id, {}, userId));
    ids.bill = bill.id;
  }, 240_000);
  afterAll(async () => { await cleanup(); });

  it("a document dated after today alone keeps the cache path — and is not in the ageing", async () => {
    await invoice("PD-INV-FUTURE", addDays(T, 10), addDays(T, 40), 2000);
    const p = await position();
    expect([p.ar.basis, p.ap.basis]).toEqual(["subledger", "subledger"]);
    expect(p.arItems).toEqual({ "PD-INV-PAST": 1150, "PD-INV-C": 460, "PD-INV-TODAY": 115 });
    expect(p.ar.total).toBe(1725);
    expect(p.bs.assets.accountsReceivable).toBe(1725);
    expect(p.ap.total).toBe(690);
    expect(p.bs.liabilities.accountsPayable).toBe(690);
  });

  it("🔴 post-dated settlements leave their documents in TODAY's ageing; a payment dated today takes its invoice out; ageing = the GL control as of today", async () => {
    await inCo(() => invoicesService.pay(ids.invPast, { amount: 1150, paidAt: addDays(T, 15), bankAccountId: ids.bank }, userId));
    const note = await inCo(() => invoicesService.create({ date: addDays(T, 5), customerId: ids.customer, documentType: "credit_note", originalInvoiceId: ids.invC, noteReason: "post-dated", items: [{ description: "S", quantity: 1, unitPrice: 200, vatRate: 15 }] }, userId)) as { id: number };
    await inCo(() => invoicesService.approve(note.id, userId));
    await inCo(() => billsService.pay(ids.bill, { amount: 690, paidAt: addDays(T, 15), bankAccountId: ids.bank }, userId));
    await inCo(() => invoicesService.pay(ids.invToday, { amount: 115, paidAt: T, bankAccountId: ids.bank }, userId)); // movement

    const p = await position();
    expect([p.ar.basis, p.ap.basis]).toEqual(["events", "events"]);
    // presence: the post-dated payment and note have not happened today
    expect(p.arItems).toEqual({ "PD-INV-PAST": 1150, "PD-INV-C": 460 });
    // movement: the payment dated today did take its invoice out (1,725 − 115)
    expect(p.ar.total).toBe(1610);
    expect(p.ar.netCustomerPosition).toBe(1610);
    expect(p.bs.assets.accountsReceivable).toBe(p.ar.netCustomerPosition);
    expect(p.apItems).toEqual({ "PD-BILL": 690 });
    expect(p.ap.netSupplierPosition).toBe(690);
    expect(p.bs.liabilities.accountsPayable).toBe(p.ap.netSupplierPosition);
    // the replay carries supplier money on account as ONE figure, never itemised from a cache that ran ahead
    expect([p.ap.assets.supplierAdvances, p.ap.assets.onAccountTotal]).toEqual([null, 0]);

    // and the ageing did not fall overnight: yesterday's (the replay) differs only by today's payment
    const y = await inCo(() => reportsService.arAging(addDays(T, -1)));
    expect(y.total).toBe(1725);
  });
});
