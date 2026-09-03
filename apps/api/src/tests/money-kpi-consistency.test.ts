/**
 * N2 — THE MONEY SEAM: two defects, one header-vs-rounded-lines shape.
 *
 * (a) PAYROLL: headers accumulated UNROUNDED per-employee figures while each
 *     payslip stored `.toFixed(2)`, so the GL — built from the headers —
 *     failed the balance check for **10.3% of salary values** (185/1,801
 *     swept over basic 3,000–12,000, three Saudi employees), surfacing as an
 *     opaque 500 on approve. Basic 3,010 is the worked example: Dr 10,091.02
 *     vs Cr 10,091.03. This suite runs that exact case THROUGH THE SERVICE.
 *
 * (b) THE INVOICES-PAGE KPIs: `outstanding` summed `total − paid` for every
 *     status ≠ 'paid' with no document_type filter — a credit note (stored
 *     POSITIVE, direction in the type) ADDED to money owed, and drafts
 *     counted as receivables. `collected` was "Σ total of fully-paid
 *     invoices", which ignored every partial payment.
 *
 * 🔴 The KPI assertions are EQUALITY WITH THE AGING REPORT, not re-derived
 * expectations alone: the invoice list's Outstanding and AR aging describe
 * the same fact, and two computations of one fact that cannot disagree
 * loudly is the two-id-spaces shape. The number is also asserted directly
 * (520.00, from the fixture) so the equality cannot be vacuously satisfied
 * by both being wrong the same way.
 *
 * Also pinned: the glPosting balance check now runs on the ROUNDED lines —
 * the values that persist — so an entry whose raw floats sneak under the
 * tolerance while its stored 2dp values are imbalanced THROWS instead of
 * persisting an imbalance the check never saw.
 *
 * Needs a real database; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { payrollService } from "../services/payroll.service";
import { reportsService } from "../services/reports.service";
import { invoicesRepository } from "../repositories/invoices.repository";
import { postJournalEntry, UnbalancedEntryError } from "../services/accounting/glPosting";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[money-kpi-consistency] no real DATABASE_URL — skipping.");

const SLUG = "n2-money-seam";
const EMAIL = "n2-money@test.local";
const DATE = "2026-07-12";

describeMaybe("N2 — payroll approves at the measured failing salary; KPIs agree with aging", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.99" }, fn),
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
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org} AND document_type <> 'invoice'`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('N2 Money Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'N2 Money Co','1010404040','399999999922203') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','N2 Approver',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(
        `INSERT INTO customers (organization_id, name, name_ar, tax_number) VALUES ($1,'KPI Client','عميل','300000000000003') RETURNING id`,
      [orgId],
      )
    ).rows[0].id;
    // Three identical Saudi employees at basic 3,010 — the measured worked
    // example of the 10.3% class. Seeded and asserted, never hoped for.
    for (const n of [1, 2, 3]) {
      await pool.query(
        `INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, status)
         VALUES ($1,$2,'N2E00${n}','Employee ${n}','SA','3010.00','active')`,
        [orgId, companyId],
      );
    }
  });

  afterAll(async () => {
    await cleanup();
  });

  it("🔴 payroll at basic 3,010 × 3 APPROVES — the case that was a 500 for 10.3% of salaries", async () => {
    const run = await inTenant(() => payrollService.create({ period: "2026-07" }, userId));
    await inTenant(() => payrollService.submit(run.id, userId));
    // Pre-N2 this threw UnbalancedEntryError (statusCode 500): headers were
    // accumulated unrounded, payslips stored rounded, GL built from headers.
    await inTenant(() => payrollService.approve(run.id, userId));

    // Header = Σ stored payslips, exactly — the invoice path's rule, now here.
    const { rows: [hdr] } = await pool.query(
      `SELECT total_net_pay::numeric AS net, total_gosi_employee::numeric AS ge FROM payroll_runs WHERE id = $1`,
      [run.id],
    );
    const { rows: [sums] } = await pool.query(
      `SELECT SUM(net_pay::numeric) AS net, SUM(gosi_employee::numeric) AS ge FROM payroll_items WHERE payroll_run_id = $1`,
      [run.id],
    );
    expect(Number(hdr.net)).toBe(Number(sums.net));
    expect(Number(hdr.ge)).toBe(Number(sums.ge));

    // And the posted entry balances at 2dp — asserted from the STORED rows.
    const { rows: [gl] } = await pool.query(
      `SELECT SUM(l.debit_amount::numeric) AS dr, SUM(l.credit_amount::numeric) AS cr
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.organization_id = $1 AND e.entry_number = 'PAY-2026-07'`,
      [orgId],
    );
    expect(Number(gl.dr)).toBe(Number(gl.cr));
  });

  it("🔴 Outstanding: credit note SUBTRACTS, drafts excluded — and the KPI EQUALS Σ aging", async () => {
    // Through the product's own write path: issue 1,000+150, receive 400,
    // credit 200+30, and leave one 500-line draft that must count for nothing.
    const inv = await inTenant(() =>
      createApproved<{ id: number }>(invoicesService, {
        invoiceNumber: "N2-INV-1",
        date: DATE,
        dueDate: DATE,
        customerId,
        items: [{ description: "Widgets", quantity: 10, unitPrice: 100, vatRate: 15 }],
      }, userId),
    );
    await inTenant(() => invoicesService.pay(inv.id, { amount: 400, paidAt: DATE }, userId));
    await inTenant(() =>
      createApproved(invoicesService, {
        invoiceNumber: "N2-CN-1",
        date: DATE,
        customerId,
        documentType: "credit_note",
        originalInvoiceId: inv.id,
        noteReason: "Partial return",
        items: [{ description: "Returned", quantity: 2, unitPrice: 100, vatRate: 15 }],
      }, userId),
    );
    await inTenant(() =>
      invoicesService.create({
        invoiceNumber: "N2-DRAFT-1",
        date: DATE,
        customerId,
        items: [{ description: "Not issued", quantity: 5, unitPrice: 100, vatRate: 15 }],
      }, userId),
    );

    const meta = await inTenant(() => invoicesRepository.listMeta({}));
    // 1,150 − 400 paid − 230 credited = 520. The OLD formula answered 1,555:
    // (1,150−400) + 230 [the note ADDED] + 575 [the draft counted].
    expect(meta.outstanding).toBe(520);
    // Collected is money RECEIVED — the 400 partial — not "totals of invoices
    // whose status is paid", which would be 0 here.
    expect(meta.collected).toBe(400);

    // 🔴 The equality that keeps the two computations of one fact honest.
    const aging = await inTenant(() => reportsService.arAging());
    const agingTotal = aging.items.reduce((s: number, i: { outstanding: number }) => s + i.outstanding, 0);
    expect(meta.outstanding).toBe(Number(agingTotal.toFixed(2)));
  });

  it("🔴 glPosting refuses an entry whose ROUNDED lines are imbalanced, even when the raw floats sneak under the tolerance", async () => {
    // Raw: 10.006 vs 10.004 — diff 0.002, UNDER the 0.005 tolerance, so the
    // old check passed and then stored 10.01 vs 10.00: a persisted imbalance
    // the check never saw. Rounded first, 10.01 vs 10.00 throws.
    await expect(
      inTenant(() =>
        postJournalEntry({
          entryNumber: "N2-ROUND-1",
          date: DATE,
          description: "raw-under-tolerance, rounded-imbalanced",
          lines: [
            { systemCode: "CASH", accountName: "Cash and Bank", debitAmount: 10.006, creditAmount: 0 },
            { systemCode: "SALES", accountName: "Sales Revenue", debitAmount: 0, creditAmount: 10.004 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);

    // And nothing persisted — the refusal happened before any write.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number = 'N2-ROUND-1'`,
      [orgId],
    );
    expect(rows[0].n).toBe(0);
  });
});
