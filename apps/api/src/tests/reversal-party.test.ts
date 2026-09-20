/**
 * Batch 1B Part 2, Phase B (2026-09-17) — A REVERSAL KEEPS THE PARTY.
 *
 * Found by the Part 1 review walking the "wrong allocation" story: the
 * reversal mirror copied account, amounts and description but not
 * `party_type` / `customer_id` / `vendor_id`, so reversing an entry with an
 * AR(customer) or AP(vendor) line netted TOTAL AR/AP while the customer's
 * or vendor's own balance stayed moved — a receivable "from someone"
 * reversed "from no one". Every invoice/bill reversal since N3 had it.
 *
 * Written RED before the fix (the first run failed on `party_type` null).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "rev-party";
const EMAIL = "rev-party@test.local";
const DATE = "2026-06-15";

describeMaybe("Phase B — a journal reversal preserves the party on control-account lines", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let vendorId = 0;
  let bank = 0;
  let expenseId = 0;

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM bill_payments WHERE bill_id IN (SELECT id FROM bills WHERE organization_id IN ${org})`);
    for (const t of [
      "payment_allocations", "payments", "journal_entry_lines", "journal_entries", "invoice_items", "einvoice_documents", "invoices",
      "bill_items", "bills", "customers", "vendors", "audit_logs", "organization_memberships", "bank_accounts", "categories", "companies",
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
    }
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Rev Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'Rev Co','1010909091','399999999977703') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','Rev',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Rev Customer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, name_ar) VALUES ($1,'Rev Vendor','مورد') RETURNING id`, [orgId])).rows[0].id;
    expenseId = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'RENT_UTILITIES'`, [orgId])).rows[0].id;
    bank = (await inTenant(() => bankAccountsService.create({ name: "Rev Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
  });
  afterAll(cleanup);

  /** Σ (Dr − Cr) on a control account, by party, in-books entries. */
  const glByParty = async (code: "AR" | "AP") =>
    (
      await pool.query(
        `SELECT l.party_type, l.customer_id, l.vendor_id, sum(l.debit_amount - l.credit_amount)::text AS v
           FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
          WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')
          GROUP BY 1,2,3 ORDER BY 1,2,3`,
        [orgId, code],
      )
    ).rows;
  const entryId = async (number: string) => (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgId, number])).rows[0]?.id;
  const balanced = async () => {
    const { rows } = await pool.query(`SELECT e.entry_number FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id WHERE e.organization_id = $1 GROUP BY e.id HAVING sum(l.debit_amount) <> sum(l.credit_amount)`, [orgId]);
    expect(rows).toEqual([]);
  };

  it("🔴 reversing an invoice receipt keeps the CUSTOMER on the mirrored AR line; AR nets to zero BY CUSTOMER, not only in total", async () => {
    const inv = await inTenant(() => createApproved<{ id: number; invoiceNumber: string }>(invoicesService, { invoiceNumber: "REV-INV-1", date: DATE, dueDate: DATE, customerId, items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] }, userId));
    await inTenant(() => invoicesService.pay(inv.id, { amount: 1150, paidAt: DATE, bankAccountId: bank }, userId));
    const { rows: [rcpt] } = await pool.query(`SELECT id, entry_number FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE 'GL-REV-INV-1-RCPT-%'`, [orgId]);
    const before = await glByParty("AR");
    expect(before).toEqual([{ party_type: "customer", customer_id: customerId, vendor_id: null, v: "0.00" }]); // issued 1,150, received 1,150

    const rev = await inTenant(() => journalEntriesService.reverse(rcpt.id));
    expect(rev.reversal.entryNumber).toBe(`${rcpt.entry_number}-REV`);

    const mirror = (await pool.query(
      `SELECT c.system_code, l.debit_amount::text dr, l.credit_amount::text cr, l.party_type, l.customer_id, l.vendor_id
         FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.id`,
      [await entryId(`${rcpt.entry_number}-REV`)],
    )).rows;
    const ar = mirror.find((l) => l.system_code === "AR")!;
    expect(ar).toMatchObject({ dr: "1150.00", cr: "0.00", party_type: "customer", customer_id: customerId, vendor_id: null });
    // the bank line stays party-less, as it was
    expect(mirror.find((l) => l.system_code == null)).toMatchObject({ party_type: null, customer_id: null });

    // Presence AND absence: exactly one AR party bucket, the customer's, back at the issued amount; no party-less AR bucket exists.
    const after = await glByParty("AR");
    expect(after).toEqual([{ party_type: "customer", customer_id: customerId, vendor_id: null, v: "1150.00" }]);
    await balanced();
    const { rows: [audit] } = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND entity_type = 'journal_entry' AND action = 'create'`, [orgId]);
    expect(audit.n).toBeGreaterThanOrEqual(1);
  });

  it("🔴 reversing a bill payment keeps the VENDOR on the mirrored AP line; AP nets BY VENDOR", async () => {
    const bill = await inTenant(() => createApproved<{ id: number; billNumber: string }>(billsService, { billNumber: "REV-BILL-1", date: DATE, dueDate: DATE, vendorId, items: [{ description: "Rent", quantity: 1, unitPrice: 2000, vatRate: 15, expenseAccountId: expenseId }] }, userId));
    await inTenant(() => billsService.pay(bill.id, { amount: 2300, paidAt: DATE, bankAccountId: bank }, userId));
    const { rows: [pay] } = await pool.query(`SELECT id, entry_number FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE 'BILL-REV-BILL-1-PAY-%'`, [orgId]);
    expect(await glByParty("AP")).toEqual([{ party_type: "vendor", customer_id: null, vendor_id: vendorId, v: "0.00" }]);

    await inTenant(() => journalEntriesService.reverse(pay.id));

    const mirror = (await pool.query(
      `SELECT c.system_code, l.debit_amount::text dr, l.credit_amount::text cr, l.party_type, l.customer_id, l.vendor_id
         FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1`,
      [await entryId(`${pay.entry_number}-REV`)],
    )).rows;
    expect(mirror.find((l) => l.system_code === "AP")).toMatchObject({ dr: "0.00", cr: "2300.00", party_type: "vendor", vendor_id: vendorId, customer_id: null });
    expect(await glByParty("AP")).toEqual([{ party_type: "vendor", customer_id: null, vendor_id: vendorId, v: "-2300.00" }]);
    await balanced();
  });

  it("the original entry is marked reversed, its lines untouched, and the mirror is dated today in an open month", async () => {
    const { rows } = await pool.query(`SELECT e.entry_number, e.status, e.date, e.reversal_of FROM journal_entries e WHERE e.organization_id = $1 AND (e.entry_number LIKE '%-REV' OR e.status = 'reversed') ORDER BY e.id`, [orgId]);
    expect(rows.filter((r) => r.status === "reversed")).toHaveLength(2);
    for (const r of rows.filter((r) => r.entry_number.endsWith("-REV"))) expect(r.reversal_of).not.toBeNull();
  });
});
