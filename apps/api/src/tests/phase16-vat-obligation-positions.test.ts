/**
 * PHASE 16 — a VAT period's row on the obligations calendar, WHATEVER ITS SIGN
 * (manual QA 2026-10-04, QA-06 / pack D-15).
 *
 * The calendar listed the last completed VAT period only while something was
 * owed (`if (amount > 0)`). A period that netted to ZERO or to a CREDIT had no
 * row at all — and the note that earlier periods are not projected here (D-01's
 * mitigation) disappeared with it, on exactly the screen where a reader would
 * conclude "VAT: nothing to watch". Now every period has its row and says its
 * position: payable · settled · nil · credit. The amount stays what is OWED —
 * never negative — so a credit is never projected as cash (Treasury reads only
 * amounts above zero) and the VAT calculation itself is untouched: `returnNet`
 * is the return's own figure, asserted equal to it here.
 *
 * The business date is PINNED to 2026-11-15 (inside Q4), so Q3 (due 2026-10-31)
 * is the last completed quarter and already past its due date.
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
import { journalEntriesService } from "../services/journalEntries.service";
import { reportsService } from "../services/reports.service";
import { taxObligationsService } from "../services/tax/taxObligations.service";
import { treasuryService } from "../services/treasury/treasury.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-vat-obligation-positions] no real DATABASE_URL — skipping.");

const Q3 = "2026-07-01 – 2026-09-30";
const Q4_TO_DATE = "2026-10-01 – 2026-12-31 (to date)";

describeMaybe("Phase 16 — every VAT period has its row and its position; a credit is never cash (pinned 2026-11-15)", () => {
  const SLUG = "p16-vat-positions", EMAIL = "p16-vat-positions@test.local";
  let orgId = "", userId = 0, customerId = 0, vendorId = 0;
  const co: Record<"nil" | "credit" | "payable" | "settled" | "part", string> = { nil: "", credit: "", payable: "", settled: "", part: "" };

  const inCo = async <T,>(company: string, fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId: company, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const ORGS = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await c.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email = '${EMAIL}')`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const company = async (name: string, cr: string) => {
    const id = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, vat_tax_period) VALUES ($1,$2,1,'gregorian','399999999999993',$3,'quarterly') RETURNING id`, [orgId, name, cr])).rows[0].id as string;
    await new Promise((r) => setTimeout(r, 15)); // distinct created_at — the first company is the org's primary
    return id;
  };
  const sale = async (c: string, n: string, date: string, net: number) => {
    const inv = await inCo(c, () => invoicesService.create({ invoiceNumber: n, date, dueDate: date, customerId, items: [{ description: "Service", quantity: 1, unitPrice: net, vatRate: 15 }] }, userId)) as { id: number };
    await inCo(c, () => invoicesService.approve(inv.id, userId));
  };
  /** A VAT payment booked to the VAT settlement account from the company's bank, on `date`. */
  const vatPayment = async (c: string, n: string, date: string, amount: number) => {
    const bank = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,$3,'SNB') RETURNING id`, [orgId, c, `Bank ${n}`])).rows[0].id;
    const bankLeaf = Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND bank_account_id = $2`, [orgId, bank])).rows[0].id);
    const vatPay = Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'VAT_PAYMENT'`, [orgId])).rows[0].id);
    await inCo(c, async () => {
      const e = (await journalEntriesService.create({ entryNumber: n, date, description: "VAT paid to ZATCA", lines: [
        { accountId: vatPay, debitAmount: amount, creditAmount: 0 },
        { accountId: bankLeaf, debitAmount: 0, creditAmount: amount },
      ] }, userId)) as { id: number };
      await journalEntriesService.approve(e.id, userId);
    });
  };
  const vatRows = async (c: string) => (await inCo(c, () => taxObligationsService.list())).obligations.filter((o) => o.kind === "vat");

  beforeAll(async () => {
    expect(businessToday(), "the pin holds").toBe("2026-11-15");
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P16 VAT positions','${SLUG}','approved') RETURNING id`)).rows[0].id;
    co.nil = await company("Nil Co", "1010505051");
    co.credit = await company("Credit Co", "1010505052");
    co.payable = await company("Payable Co", "1010505053");
    co.settled = await company("Settled Co", "1010505054");
    co.part = await company("Part-paid Co", "1010505055");
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P16P',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'VAT Customer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'VAT Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    // Credit Co: a Q3 purchase with claimable input VAT 1,500 and no sales → the return nets to −1,500
    const bill = await inCo(co.credit, () => billsService.create({
      supplierDocumentKind: "tax_invoice", vendorReference: "SUP-Q3-1", billNumber: "PV-B-1", date: "2026-08-10", dueDate: "2026-09-10", vendorId,
      items: [{ description: "Supply", quantity: 1, unitPrice: 10_000, vatRate: 15 }],
    }, userId));
    await inCo(co.credit, () => billsService.approve(bill.id, {}, userId));
    // Payable / Settled / Part-paid Co: Q3 sales 10,000 → VAT 1,500
    await sale(co.payable, "PV-S-1", "2026-08-10", 10_000);
    await sale(co.settled, "PV-S-2", "2026-08-10", 10_000);
    await sale(co.part, "PV-S-3", "2026-08-10", 10_000);
    await vatPayment(co.settled, "PV-PAY-1", "2026-10-20", 1_500);
    await vatPayment(co.part, "PV-PAY-2", "2026-10-20", 1_000);
  }, 180_000);
  afterAll(cleanup);

  it("🔴 a period that nets to ZERO has its row — owes 0, says nil, and carries the note that earlier periods are not projected (it used to vanish)", async () => {
    const rows = await vatRows(co.nil);
    const q3 = rows.find((o) => o.reference === Q3);
    expect(q3, "the zero quarter is on the calendar").toBeTruthy();
    expect([q3!.amount, q3!.vatPosition, q3!.returnNet, q3!.paidSince, q3!.dueDate, q3!.overdue]).toEqual([0, "nil", 0, 0, "2026-10-31", false]);
    expect(q3!.note).toMatch(/nets to zero/);
    expect(q3!.note).toMatch(/Periods before it are not projected here/);
    const cur = rows.find((o) => o.reference === Q4_TO_DATE);
    expect([cur?.amount, cur?.vatPosition]).toEqual([0, "nil"]);
  });

  it("🔴 a period that nets to a CREDIT owes 0 and says credit; returnNet is the return's own (negative) figure; Treasury projects no cash for it", async () => {
    const q3 = (await vatRows(co.credit)).find((o) => o.reference === Q3)!;
    const ret = await inCo(co.credit, () => reportsService.vatReturn("2026-07", "2026-09"));
    expect(Number(ret.netVatDue), "the fixture is a credit").toBe(-1_500);
    expect([q3.amount, q3.vatPosition, q3.returnNet, q3.overdue]).toEqual([0, "credit", Number(ret.netVatDue), false]);
    expect(q3.note).toMatch(/credit .* not projected as cash/);
    const list = await inCo(co.credit, () => taxObligationsService.list());
    expect(list.total, "a credit adds nothing to what is owed").toBe(0);
    const f = await inCo(co.credit, () => treasuryService.forecast(13));
    expect(f.rows.filter((x) => x.category === "tax" && x.source.type === "tax_vat"), "never an inflow, never an outflow").toEqual([]);
  });

  it("an UNPAID period is payable — the figure MOVES from the zero company's 0 to 1,500, overdue past 31 October, and Treasury carries it", async () => {
    const q3 = (await vatRows(co.payable)).find((o) => o.reference === Q3)!;
    expect([q3.amount, q3.vatPosition, q3.returnNet, q3.paidSince, q3.overdue]).toEqual([1_500, "payable", 1_500, 0, true]);
    const f = await inCo(co.payable, () => treasuryService.forecast(13));
    expect(f.rows.find((x) => x.category === "tax" && x.source.type === "tax_vat" && x.source.id === Q3)?.amount).toBe(1_500);
  });

  it("a period its VAT payments cover is SETTLED — listed, owes 0, not overdue though its due date passed; a part-payment leaves the rest payable", async () => {
    const settled = (await vatRows(co.settled)).find((o) => o.reference === Q3)!;
    expect([settled.amount, settled.vatPosition, settled.returnNet, settled.paidSince, settled.overdue]).toEqual([0, "settled", 1_500, 1_500, false]);
    expect(settled.note).toMatch(/cover the return's net VAT/);
    const part = (await vatRows(co.part)).find((o) => o.reference === Q3)!;
    expect([part.amount, part.vatPosition, part.paidSince, part.overdue]).toEqual([500, "payable", 1_000, true]);
  });
});
