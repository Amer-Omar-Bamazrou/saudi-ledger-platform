/**
 * Cross-entity correctness sweep (M10.6) — the closing proof for the whole
 * draft/approval feature.
 *
 * Two properties, proven with all five financial records present in ONE tenant
 * at once (not just per-entity in isolation):
 *
 *   1. ZERO MOVEMENT UNTIL APPROVED (spec §7, the core invariant): with an
 *      unapproved draft of a journal entry, a bill, an invoice, and a payroll run
 *      all coexisting, EVERY money report reads zero — trial balance, income
 *      statement, balance sheet (AR + AP), AR aging, AP aging, VAT return. Then
 *      approving them all makes the expected movement appear in every report.
 *
 *   2. FULL LIFECYCLE per editable-draft entity: create → submit → send-back →
 *      resubmit → approve works end to end (bill, invoice, payroll). Journal
 *      entries (no submit stage) go draft → approve.
 *
 * DB-backed; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";
import { billsService } from "../services/bills.service";
import { invoicesService } from "../services/invoices.service";
import { payrollService } from "../services/payroll.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[cross-entity] no real DATABASE_URL — skipping sweep test.");
}

describeMaybe("cross-entity sweep — zero movement until approved, across all five records", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let vendorId = 0;
  let customerId = 0;
  let expenseCatId = 0;
  let cashCatId = 0;

  const DATE = "2026-08-15";
  const VAT_PERIOD = "2026-08";

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.14" }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    if (orgId) {
      for (const t of [
        "journal_entry_lines", "journal_entries", "bill_items", "bills", "invoice_items", "invoices",
        "payroll_items", "payroll_runs", "employees", "audit_logs", "customers", "vendors", "categories",
      ]) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id = $1`, [orgId]);
      }
    }
    if (userId) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE email = 'sweep@test.local'`);
    await pool.query(`DELETE FROM companies WHERE name = 'SWEEP Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'sweep'`);
  };

  beforeAll(async () => {
    await pool.query(`DELETE FROM organizations WHERE slug = 'sweep'`);
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('SWEEP Org','sweep') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'SWEEP Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email,name,password_hash,role,is_active) VALUES ('sweep@test.local','Sweep',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id,name,name_ar,tax_number) VALUES ($1,'Sweep Vendor','مورد','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    customerId = (await pool.query(`INSERT INTO customers (organization_id,name,name_ar,tax_number) VALUES ($1,'Sweep Customer','عميل','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    expenseCatId = (await pool.query(`INSERT INTO categories (organization_id,name,name_ar,type) VALUES ($1,'Office Expense','مصروف','expense') RETURNING id`, [orgId])).rows[0].id;
    cashCatId = (await pool.query(`INSERT INTO categories (organization_id,name,name_ar,type) VALUES ($1,'Cash','نقد','asset') RETURNING id`, [orgId])).rows[0].id;
    await pool.query(`INSERT INTO employees (organization_id,company_id,employee_number,name,nationality,basic_salary,status) VALUES ($1,$2,'E1','Emp One','SA','8000.00','active')`, [orgId, companyId]);
  });

  afterAll(async () => {
    await cleanup();
  });

  const ids: { je?: number; bill?: number; inv?: number; pay?: number } = {};

  it("creates an unapproved draft of every entity (all as bookkeeper-style drafts)", async () => {
    await inTenant(async () => {
      const je = await journalEntriesService.create(
        { entryNumber: "SWP-JE", date: DATE, description: "sweep JE",
          lines: [{ accountId: expenseCatId, accountName: "Office Expense", debitAmount: 100, creditAmount: 0 },
                  { accountId: cashCatId, accountName: "Cash", debitAmount: 0, creditAmount: 100 }] },
        userId,
      );
      ids.je = je.id;

      const bill = await billsService.create({ billNumber: "SWP-BILL", date: DATE, vendorId, subtotal: 200, vatAmount: 30, total: 230, items: [] }, userId);
      ids.bill = bill.id;

      // Invoice via the workflow (bookkeeper path → draft, not auto-approved).
      const inv = await invoicesService.create(
        { invoiceNumber: "SWP-INV", date: DATE, customerId, items: [{ description: "Svc", quantity: 1, unitPrice: 400, vatRate: 15 }] },
        userId, { autoApprove: false },
      );
      ids.inv = inv.id;
      expect(inv.status).toBe("draft");
      expect(inv.invoiceHash).toBeNull();

      const pay = await payrollService.create({ period: VAT_PERIOD }, userId);
      ids.pay = pay.id;
    });
  });

  it("ZERO MOVEMENT: every money report reads zero while all four drafts are unapproved", async () => {
    await inTenant(async () => {
      const tb = await reportsService.trialBalance();
      expect(tb.totalDebit).toBe(0);
      expect(tb.totalCredit).toBe(0);

      const is = await reportsService.incomeStatement();
      expect(is.totalRevenue).toBe(0);
      expect(is.totalExpenses).toBe(0);

      const bs = await reportsService.balanceSheet();
      expect(bs.assets.accountsReceivable).toBe(0);
      expect(bs.liabilities.accountsPayable).toBe(0);

      expect((await reportsService.arAging()).total).toBe(0);
      expect((await reportsService.apAging()).total).toBe(0);

      const vat = await reportsService.vatReturn(VAT_PERIOD, VAT_PERIOD);
      expect(vat.salesSection.box8_totalOutputVat).toBe(0);
      expect(vat.purchasesSection.box15_totalInputVat).toBe(0);
    });
  });

  it("approves each record (JE post; bill/invoice/payroll approve)", async () => {
    await inTenant(async () => {
      await journalEntriesService.approve(ids.je!, userId);
      await billsService.approve(ids.bill!, {}, userId);
      await invoicesService.approve(ids.inv!, userId);
      await payrollService.approve(ids.pay!, userId);
    });
  });

  it("APPROVED: the expected movement now appears across the reports", async () => {
    await inTenant(async () => {
      // AR (invoice 400 + 60 VAT = 460) and AP (bill 230) now recognized.
      const bs = await reportsService.balanceSheet();
      expect(bs.assets.accountsReceivable).toBe(460);
      expect(bs.liabilities.accountsPayable).toBe(230);

      expect((await reportsService.arAging()).total).toBe(460);
      expect((await reportsService.apAging()).total).toBe(230);

      // VAT: output 60 (invoice), input 30 (bill).
      const vat = await reportsService.vatReturn(VAT_PERIOD, VAT_PERIOD);
      expect(vat.salesSection.box8_totalOutputVat).toBe(60);
      expect(vat.purchasesSection.box15_totalInputVat).toBe(30);

      // Trial balance now has posted JE + bill + invoice + payroll entries and balances.
      const tb = await reportsService.trialBalance();
      expect(tb.balanced).toBe(true);
      expect(tb.totalDebit).toBeGreaterThan(0);
    });
  });

  it("FULL LIFECYCLE: create → submit → send-back → resubmit → approve works for a bill", async () => {
    await inTenant(async () => {
      const bill = await billsService.create({ billNumber: "SWP-LC", date: DATE, vendorId, subtotal: 10, vatAmount: 0, total: 10, items: [] }, userId);
      expect(bill.status).toBe("draft");
      expect((await billsService.submit(bill.id, userId)).status).toBe("submitted");
      const back = await billsService.sendBack(bill.id, "fix it", userId);
      expect(back.status).toBe("draft");
      expect(back.reviewNote).toBe("fix it");
      expect((await billsService.submit(bill.id, userId)).status).toBe("submitted");
      expect((await billsService.approve(bill.id, {}, userId)).status).toBe("received");
    });
  });

  it("FULL LIFECYCLE works for an invoice and a payroll run", async () => {
    await inTenant(async () => {
      const inv = await invoicesService.create(
        { invoiceNumber: "SWP-LC-INV", date: DATE, customerId, items: [{ description: "Svc", quantity: 1, unitPrice: 50, vatRate: 15 }] },
        userId, { autoApprove: false },
      );
      expect(inv.status).toBe("draft");
      await invoicesService.submit(inv.id, userId);
      const invBack = await invoicesService.sendBack(inv.id, "add PO", userId);
      expect(invBack.status).toBe("draft");
      await invoicesService.submit(inv.id, userId);
      const issued = await invoicesService.approve(inv.id, userId);
      expect(issued.status).toBe("sent");
      expect(issued.invoiceHash).toBeTruthy();

      const run = await payrollService.create({ period: "2026-09" }, userId);
      await payrollService.submit(run.id, userId);
      const runBack = await payrollService.sendBack(run.id, "recheck", userId);
      expect(runBack.status).toBe("draft");
      await payrollService.submit(run.id, userId);
      expect((await payrollService.approve(run.id, userId)).status).toBe("approved");
    });
  });
});
