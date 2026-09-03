/**
 * N3 — PARTY ON THE JOURNAL LINE + DOCUMENT-NUMBER UNIQUENESS.
 *
 * Two halves, both cheap-now/expensive-later (ERPNext paid for the party one
 * in 2014 with a patch that rewrote live tenants' balances):
 *
 *  1. Control-account lines carry WHO the receivable/payable is with. Every
 *     document path populates it; a systemCode AR/AP line that does not even
 *     DECLARE its party (a real one, or `{type:"none"}` with a reason — the
 *     B2C simplified invoice legitimately has no identified customer) is
 *     refused by `postJournalEntry`.
 *  2. unique(company_id, entry_number) and unique(company_id, bill_number) —
 *     the constraint 0063 named as missing. The constructed numbers that
 *     collided are fixed in the same change and pinned here:
 *     `GL-x-PAY-<paymentId>` (second partial payment), `PAY-<period>-R<runId>`
 *     (a period's second run), and a duplicate user-supplied JE number is a
 *     409 naming the number, not a raw 23505 surfacing as a 500.
 *
 * Needs a real database; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { payrollService } from "../services/payroll.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { postJournalEntry, MissingPartyError } from "../services/accounting/glPosting";
import { ConflictError } from "../lib/errors";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[party-and-number-uniqueness] no real DATABASE_URL — skipping.");

const SLUG = "n3-party-numbers";
const EMAIL = "n3-party@test.local";
const DATE = "2026-07-14";

describeMaybe("N3 — party on the line, and a number means one document", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let vendorId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.88" }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM payroll_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM payroll_runs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM employees WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bill_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bill_payments WHERE bill_id IN (SELECT id FROM bills WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM bills WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM vendors WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('N3 Party Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'N3 Party Co','1010505050','399999999933303') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','N3 Approver',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(
        `INSERT INTO customers (organization_id, name, name_ar, tax_number) VALUES ($1,'Party Client','عميل','300000000000003') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    vendorId = (
      await pool.query(
        `INSERT INTO vendors (organization_id, name, name_ar) VALUES ($1,'Party Vendor','مورد') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, status)
       VALUES ($1,$2,'N3E001','Employee One','SA','8000.00','active')`,
      [orgId, companyId],
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  it("🔴 two partial payments post TWO journal entries with DISTINCT numbers — the collision 0063 warned about", async () => {
    const inv = await inTenant(() =>
      createApproved<{ id: number }>(invoicesService, {
        invoiceNumber: "N3-INV-1",
        date: DATE,
        dueDate: DATE,
        customerId,
        items: [{ description: "Widgets", quantity: 10, unitPrice: 100, vatRate: 15 }],
      }, userId),
    );
    // Pre-N3, instalment #2 minted a second `GL-N3-INV-1-PAY` — two financial
    // records claiming to be the same document. Under the unique index it
    // would have been a raw 23505. Now each carries its payment row's id.
    await inTenant(() => invoicesService.pay(inv.id, { amount: 400, paidAt: DATE }, userId));
    await inTenant(() => invoicesService.pay(inv.id, { amount: 300, paidAt: DATE }, userId));

    const { rows } = await pool.query(
      `SELECT entry_number FROM journal_entries
        WHERE organization_id = $1 AND entry_number LIKE 'GL-N3-INV-1-PAY-%' ORDER BY id`,
      [orgId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].entry_number).not.toBe(rows[1].entry_number);
  });

  it("🔴 the AR lines carry the customer — issue and both payments", async () => {
    const { rows } = await pool.query(
      `SELECT l.party_type, l.customer_id, l.vendor_id
         FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.organization_id = $1 AND l.account_name = 'Accounts Receivable'`,
      [orgId],
    );
    // One issue line + two payment lines, every one stamped with the customer.
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.party_type).toBe("customer");
      expect(r.customer_id).toBe(customerId);
      expect(r.vendor_id).toBeNull();
    }
  });

  it("the AP lines carry the vendor", async () => {
    const bill = await inTenant(() =>
      createApproved<{ id: number }>(billsService, {
        billNumber: "N3-BILL-1",
        date: DATE,
        dueDate: DATE,
        vendorId,
        items: [{ description: "Supplies", quantity: 2, unitPrice: 500, vatRate: 15 }],
      }, userId),
    );
    await inTenant(() => billsService.pay(bill.id, { amount: 200, paidAt: DATE }, userId));
    const { rows } = await pool.query(
      `SELECT l.party_type, l.vendor_id FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.organization_id = $1 AND l.account_name = 'Accounts Payable'`,
      [orgId],
    );
    expect(rows.length).toBe(2); // issue + payment
    for (const r of rows) {
      expect(r.party_type).toBe("vendor");
      expect(r.vendor_id).toBe(vendorId);
    }
  });

  it("🔴 a systemCode AR line that does not even DECLARE a party is refused, and nothing posts", async () => {
    await expect(
      inTenant(() =>
        postJournalEntry({
          entryNumber: "N3-NOPARTY-1",
          date: DATE,
          description: "AR line with an undeclared party",
          lines: [
            { systemCode: "CASH", accountName: "Cash and Bank", debitAmount: 100, creditAmount: 0 },
            { systemCode: "AR", accountName: "Accounts Receivable", debitAmount: 0, creditAmount: 100 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(MissingPartyError);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number = 'N3-NOPARTY-1'`,
      [orgId],
    );
    expect(rows[0].n).toBe(0);

    // And a DECLARED absence posts — the B2C case must keep working.
    await inTenant(() =>
      postJournalEntry({
        entryNumber: "N3-B2C-1",
        date: DATE,
        description: "declared no-party AR line",
        lines: [
          { systemCode: "CASH", accountName: "Cash and Bank", debitAmount: 100, creditAmount: 0 },
          { systemCode: "AR", accountName: "Accounts Receivable", debitAmount: 0, creditAmount: 100, party: { type: "none", reason: "test: B2C" } },
        ],
      }),
    );
    const { rows: b2c } = await pool.query(
      `SELECT l.party_type, l.customer_id FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.organization_id = $1 AND e.entry_number = 'N3-B2C-1' AND l.account_name = 'Accounts Receivable'`,
      [orgId],
    );
    expect(b2c[0].party_type).toBeNull();
    expect(b2c[0].customer_id).toBeNull();
  });

  it("a period's SECOND payroll run approves under its own number — PAY-<period>-R<runId>", async () => {
    const run1 = await inTenant(() => payrollService.create({ period: "2026-08" }, userId));
    await inTenant(() => payrollService.submit(run1.id, userId));
    await inTenant(() => payrollService.approve(run1.id, userId));
    // A correction run for the same period — pre-N3 both would have minted
    // `PAY-2026-08` and the second approval would have died on the index.
    const run2 = await inTenant(() => payrollService.create({ period: "2026-08" }, userId));
    await inTenant(() => payrollService.submit(run2.id, userId));
    await inTenant(() => payrollService.approve(run2.id, userId));

    const { rows } = await pool.query(
      `SELECT entry_number FROM journal_entries
        WHERE organization_id = $1 AND entry_number LIKE 'PAY-2026-08-R%' ORDER BY id`,
      [orgId],
    );
    expect(rows.map((r) => r.entry_number)).toEqual([`PAY-2026-08-R${run1.id}`, `PAY-2026-08-R${run2.id}`]);
  });

  it("a duplicate user-supplied journal entry number is a 409 naming the number, not a 500", async () => {
    const body = {
      entryNumber: "N3-MANUAL-1",
      date: DATE,
      description: "first",
      lines: [
        { accountId: null, accountName: "x", debitAmount: 0, creditAmount: 0 },
      ],
    };
    // Build two minimal balanced manual entries via the service. Lines need a
    // real account: use the seeded chart's ids.
    const { rows: cats } = await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 AND system_code IN ('CASH','SALES') ORDER BY system_code`,
      [orgId],
    );
    expect(cats.length).toBe(2);
    const [cashCat, salesCat] = [cats[0].id, cats[1].id];
    const lines = [
      { accountId: cashCat, accountName: "Cash and Bank", debitAmount: 50, creditAmount: 0 },
      { accountId: salesCat, accountName: "Sales Revenue", debitAmount: 0, creditAmount: 50 },
    ];
    await inTenant(() => journalEntriesService.create({ ...body, lines }, userId));
    await expect(
      inTenant(() => journalEntriesService.create({ ...body, lines }, userId)),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
