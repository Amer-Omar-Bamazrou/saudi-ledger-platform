/**
 * Audit Tier 1 — the VAT return classifies per LINE, and headers equal Σ lines.
 *
 * Every prior invoice fixture in this repo was SINGLE-RATE, which is exactly
 * why these defects never fired (the finding-#9 fixture lesson):
 *
 *  1. The return reconstructed a rate from rounded header cents
 *     (`vat/subtotal*100`, branches `>= 14.9` / `=== 0`) — so a mixed-rate
 *     document (header rate between the branches) vanished from EVERY box
 *     including its posted output VAT; a small 15% document whose rounded
 *     rate fell below 14.9% vanished too; exempt filed as zero-rated; and a
 *     credit note against a mixed document never reduced output VAT.
 *  2. Header VAT accumulated UNROUNDED while lines stored ROUNDED — header ≠
 *     Σ lines by a halala, which is BR-CO-14-inconsistent UBL (rejected at the
 *     ZATCA submission endpoint) and, with three independently-rounded header
 *     figures posted as three GL lines against a 0.005 tolerance, could throw
 *     "GL entry does not balance" on a legitimate invoice.
 *
 * Each case below uses its own month so the per-period return isolates it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[vat-return-line-level] no real DATABASE_URL — skipping.");

const SLUG = "vat-line-level";
const EMAIL = "vat-line-level@test.local";

describeMaybe("VAT return — line-level classification + header=Σlines", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let vendorId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
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
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bill_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bill_payments WHERE bill_id IN (SELECT id FROM bills WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM bills WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM vendors WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('VAT Lines Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'VL','1010101016','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','VL',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Mixed Rate Co') RETURNING id`, [orgId])
    ).rows[0].id;
    vendorId = (
      await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Line Vendor') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(cleanup);

  async function issue(num: string, date: string, items: unknown[], extra: Record<string, unknown> = {}) {
    const inv = await inTenant(() =>
      invoicesService.create({ invoiceNumber: num, date, customerId, items, ...extra }, userId),
    );
    await inTenant(() => invoicesService.approve(inv.id, userId));
    return inv.id;
  }

  it("🔴 a MIXED-RATE invoice appears in the right boxes instead of vanishing from all of them", async () => {
    // 100 @15% ('S' stamped automatically) + 100 @0% explicitly zero-rated.
    // Old header math: rate = 15/200 = 7.5% ⇒ matched NEITHER branch ⇒ the
    // document — and its 15.00 of GL-posted output VAT — was on no box.
    await issue("VL-MIX", "2026-01-15", [
      { description: "Standard service", quantity: 1, unitPrice: 100, vatRate: 15 },
      { description: "Zero-rated export leg", quantity: 1, unitPrice: 100, vatRate: 0, taxCategoryCode: "Z" },
    ]);
    const r = await inTenant(() => reportsService.vatReturn("2026-01", "2026-01"));
    expect(r.salesSection.box1_standardRatedDomesticSales).toBe(100);
    expect(r.salesSection.box6_vatOnStandardRatedSales).toBe(15);
    expect(r.salesSection.box2_zeroRatedDomesticSales).toBe(100);
    expect(r.salesSection.box5_totalSales).toBe(200);
    expect(r.netVatDue).toBe(15);
  });

  it("🔴 a small 15% invoice no longer falls under the 14.9% threshold", async () => {
    // base 3.63 @15% ⇒ VAT 0.54 ⇒ old reconstructed rate 14.876% ⇒ dropped.
    await issue("VL-SMALL", "2026-02-10", [{ description: "Tiny", quantity: 1, unitPrice: 3.63, vatRate: 15 }]);
    const r = await inTenant(() => reportsService.vatReturn("2026-02", "2026-02"));
    expect(r.salesSection.box1_standardRatedDomesticSales).toBe(3.63);
    expect(r.salesSection.box6_vatOnStandardRatedSales).toBe(0.54);
  });

  it("an EXEMPT line files in box 3, not the zero-rated box", async () => {
    await issue("VL-EXEMPT", "2026-03-10", [
      { description: "Exempt financial service", quantity: 1, unitPrice: 250, vatRate: 0, taxCategoryCode: "E" },
    ]);
    const r = await inTenant(() => reportsService.vatReturn("2026-03", "2026-03"));
    expect(r.salesSection.box3_exemptSales).toBe(250);
    expect(r.salesSection.box2_zeroRatedDomesticSales).toBe(0);
    expect(r.salesSection.box5_totalSales).toBe(250);
  });

  it("🔴 a credit note against a MIXED document reduces the right boxes (incl. output VAT)", async () => {
    const originalId = await issue("VL-MIX2", "2026-04-05", [
      { description: "Standard", quantity: 1, unitPrice: 200, vatRate: 15 },
      { description: "Zero-rated", quantity: 1, unitPrice: 100, vatRate: 0, taxCategoryCode: "Z" },
    ]);
    // Note dated in its own month so the period isolates the reduction.
    await issue(
      "VL-CN1",
      "2026-05-02",
      [
        { description: "Partial credit standard", quantity: 1, unitPrice: 50, vatRate: 15 },
        { description: "Partial credit zero-rated", quantity: 1, unitPrice: 25, vatRate: 0, taxCategoryCode: "Z" },
      ],
      { documentType: "credit_note", originalInvoiceId: originalId, noteReason: "price correction" },
    );
    const noteMonth = await inTenant(() => reportsService.vatReturn("2026-05", "2026-05"));
    expect(noteMonth.salesSection.box1_standardRatedDomesticSales).toBe(-50);
    expect(noteMonth.salesSection.box6_vatOnStandardRatedSales).toBe(-7.5);
    expect(noteMonth.salesSection.box2_zeroRatedDomesticSales).toBe(-25);
    expect(noteMonth.netVatDue).toBe(-7.5);
  });

  it("🔴 header VAT equals Σ line VAT exactly (the BR-CO-14 precondition), and totals add up", async () => {
    // 3 lines of base 10.03 @15%: per-line VAT rounds to 1.50; the old header
    // accumulated unrounded 4.5135 → 4.51 ≠ 4.50.
    const id = await issue("VL-SUM", "2026-06-08", [
      { description: "A", quantity: 1, unitPrice: 10.03, vatRate: 15 },
      { description: "B", quantity: 1, unitPrice: 10.03, vatRate: 15 },
      { description: "C", quantity: 1, unitPrice: 10.03, vatRate: 15 },
    ]);
    const { rows: [inv] } = await pool.query(`SELECT subtotal::text, vat_amount::text, total::text FROM invoices WHERE id = $1`, [id]);
    const { rows: items } = await pool.query(`SELECT vat_amount::text, total::text FROM invoice_items WHERE invoice_id = $1`, [id]);
    const lineVatSum = items.reduce((s: number, r: { vat_amount: string }) => s + Number(r.vat_amount), 0);
    expect(Number(inv.vat_amount)).toBe(Math.round(lineVatSum * 100) / 100); // 4.50, not 4.51
    expect(Number(inv.vat_amount)).toBe(4.5);
    expect(Number(inv.total)).toBe(Number(inv.subtotal) + Number(inv.vat_amount)); // exact — the GL balances
  });

  it("🔴 the independent-rounding GL imbalance case now APPROVES instead of throwing 500", async () => {
    // Pre-fix: subtotal 8.684→8.68, vat 1.00305→1.00, total 9.68705→9.69 ⇒
    // Dr 9.69 vs Cr 9.68 ⇒ imbalance 0.01 > 0.005 ⇒ "GL entry does not balance".
    await issue("VL-BAL", "2026-07-03", [
      { description: "Fractional qty standard", quantity: 6.687, unitPrice: 1.0, vatRate: 15 },
      { description: "Fractional qty zero-rated", quantity: 1.997, unitPrice: 1.0, vatRate: 0, taxCategoryCode: "Z" },
    ]);
    const tb = await inTenant(() => reportsService.trialBalance("2026-07-01", "2026-07-31"));
    expect((tb as { totalDebit: number }).totalDebit).toBe((tb as { totalCredit: number }).totalCredit);
  });

  it("bills classify per line too: a mixed bill splits into boxes 9/10/13", async () => {
    const bill = await inTenant(() =>
      billsService.create(
        {
          billNumber: "VL-BILL",
          date: "2026-08-06",
          vendorId,
          items: [
            { description: "Standard purchase", quantity: 1, unitPrice: 100, vatRate: 15 },
            { description: "Zero-rated purchase", quantity: 1, unitPrice: 40, vatRate: 0 },
          ],
        },
        userId,
      ),
    );
    await inTenant(() => billsService.submit(bill.id, userId));
    await inTenant(() => billsService.approve(bill.id, {}, userId));
    const r = await inTenant(() => reportsService.vatReturn("2026-08", "2026-08"));
    expect(r.purchasesSection.box9_standardRatedPurchases).toBe(100);
    expect(r.purchasesSection.box13_recoverableInputVat).toBe(15);
    expect(r.purchasesSection.box10_zeroRatedPurchases).toBe(40);
    expect(r.purchasesSection.box12_totalPurchases).toBe(140);
  });
});
