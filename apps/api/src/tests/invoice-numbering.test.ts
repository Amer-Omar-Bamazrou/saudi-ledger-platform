/**
 * C12 — invoice numbering: unique, sequential, per company, never reset.
 *
 * The rule comes from the PRIMARY TEXT, not from how the ICV works:
 *
 *   VAT Implementing Regulations Art. 53(5)(b) — "a sequential number which
 *   uniquely identifies the Tax Invoice" — which the E-Invoicing Resolution's
 *   Annex (2) field 2.1 delegates to rather than restating.
 *
 * Citations and the gaps analysis: docs/tax/invoice-numbering-verification.md.
 *
 * 🔴 What these tests deliberately do NOT assert: that the series is gapless.
 * Neither document requires that of the invoice number — ZATCA wrote the
 * explicitly gapless rule for the tamper-resistant COUNTER instead. Asserting
 * gaplessness here would pin behaviour the law does not ask for and would make
 * the suite an obstacle to a legitimate future change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { invoicesRepository } from "../repositories/invoices.repository";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[invoice-numbering] no real DATABASE_URL — skipping.");
}

describeMaybe("C12 — invoice numbering", () => {
  let orgId = "";
  let companyA = "";
  let companyB = "";
  let userId = 0;
  let customerId = 0;

  async function inTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.77" }, fn),
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
      await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM journal_entries WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM invoice_items WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM invoices WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM invoice_number_counters WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM customers WHERE organization_id = $1`, [orgId]);
    }
    if (userId) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE email = 'numbering@test.local'`);
    await pool.query(`DELETE FROM companies WHERE name IN ('NUM Co A','NUM Co B')`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'num-test'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('NUM Org','num-test') RETURNING id`)).rows[0].id;
    companyA = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'NUM Co A','1010101014','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    companyB = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'NUM Co B','1010101015','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('numbering@test.local','Numberer',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'Numbered Customer','عميل') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  const mkInvoice = (companyId: string, body: Record<string, unknown> = {}) =>
    inTenant(companyId, () =>
      invoicesService.create(
        {
          date: "2026-11-05",
          customerId,
          items: [{ description: "Line", quantity: 1, unitPrice: 100, vatRate: 15 }],
          ...body,
        },
        userId,
      ),
    );

  it("allocates server-side when the caller supplies no number", async () => {
    const inv = await mkInvoice(companyA);
    // 🔴 The browser no longer mints this. The shape is INV-{YYYY}-{6 digits}.
    expect(inv.invoiceNumber).toMatch(/^INV-2026-\d{6}$/);
  });

  it("is SEQUENTIAL — each allocation is the previous plus one", async () => {
    const a = await mkInvoice(companyA);
    const b = await mkInvoice(companyA);
    const seq = (n: string) => Number(n.split("-")[2]);
    expect(seq(b.invoiceNumber)).toBe(seq(a.invoiceNumber) + 1);
  });

  it("🔴 is scoped PER COMPANY — the taxpayer is the company, not the org", async () => {
    // Art. 53(5)(b) requires the number to uniquely identify the invoice among
    // the SUPPLIER's invoices. Company A and B are separate taxpayers in one
    // organization, so their series are independent.
    const before = await mkInvoice(companyA);
    const other = await mkInvoice(companyB);
    const seq = (n: string) => Number(n.split("-")[2]);
    // B starts its own series rather than continuing A's.
    expect(seq(other.invoiceNumber)).toBeLessThan(seq(before.invoiceNumber));
  });

  it("🔴 does NOT reset at year end — the year is a display prefix only", async () => {
    // M21.2's allocator restarted each January. Nothing in either document
    // authorises that, and a restart is the one arrangement that sits
    // awkwardly against both "sequential" and Resolution §2's ban on more than
    // one sequence per unit.
    const thisYear = await mkInvoice(companyA, { date: "2026-12-31" });
    const nextYear = await mkInvoice(companyA, { date: "2027-01-01" });
    const seq = (n: string) => Number(n.split("-")[2]);
    expect(nextYear.invoiceNumber.startsWith("INV-2027-"), "the year prefix follows the date").toBe(true);
    expect(seq(nextYear.invoiceNumber), "but the counter carries on").toBe(seq(thisYear.invoiceNumber) + 1);
  });

  it("honours a caller-supplied number — legacy imports must stay possible", async () => {
    const inv = await mkInvoice(companyA, { invoiceNumber: "LEGACY-2019-0007" });
    expect(inv.invoiceNumber).toBe("LEGACY-2019-0007");
  });

  it("🔴 a DUPLICATE is refused — this is the whole point of C12", async () => {
    await mkInvoice(companyA, { invoiceNumber: "DUP-CHECK-1" });
    await expect(mkInvoice(companyA, { invoiceNumber: "DUP-CHECK-1" })).rejects.toThrow();
  });

  it("…but the SAME number on a DIFFERENT company is fine — they are different taxpayers", async () => {
    const other = await mkInvoice(companyB, { invoiceNumber: "DUP-CHECK-1" });
    expect(other.invoiceNumber).toBe("DUP-CHECK-1");
  });

  /**
   * 🔴 THE CONCURRENCY PROPERTY.
   *
   * The allocator is one atomic UPSERT rather than the advisory-lock
   * reservation the ICV chain uses — because the law asks for unique and
   * sequential, not gapless. This proves the weaker discipline is still
   * sufficient for the property that IS required: concurrent allocations for
   * one company never collide.
   *
   * A read-then-write allocator (`SELECT max()+1`) passes every test above and
   * fails this one.
   */
  it("🔴 concurrent allocations for ONE company never collide", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => inTenant(companyA, () => invoicesRepository.allocateInvoiceNumber("2026-11-05"))),
    );
    expect(new Set(results).size, `8 concurrent allocations produced duplicates: ${results.join(", ")}`).toBe(8);
  });

  it("the counter never goes backwards, even if invoices are deleted", async () => {
    const before = await mkInvoice(companyA);
    const seq = (n: string) => Number(n.split("-")[2]);
    await pool.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [before.id]);
    await pool.query(`DELETE FROM invoices WHERE id = $1`, [before.id]);
    const after = await mkInvoice(companyA);
    // 🔴 A max()+1 allocator would REUSE the deleted number here. Reuse is
    // worse than a gap: the law forbids two invoices sharing an identifier,
    // and says nothing about holes.
    expect(seq(after.invoiceNumber)).toBeGreaterThan(seq(before.invoiceNumber));
  });
});
