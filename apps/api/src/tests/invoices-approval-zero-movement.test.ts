/**
 * Invoice draft/approval — ZERO-MOVEMENT proof (M10.4), the entity template
 * applied to AR + ZATCA. Mirrors the JE/bill templates (spec §7) for the sales
 * side and additionally proves the hash chain is deferred to approval.
 *
 * Proves through the REAL report services that an invoice has ZERO effect on the
 * books at every pre-approval state (`draft` AND `submitted`) across the
 * approved-only invoice reports (AR aging, balance-sheet Accounts Receivable,
 * and the VAT-return output-VAT/sales side), that APPROVAL is what issues it
 * (AR posted + ZATCA hash/QR minted), and that self-approve-on-create keeps the
 * approver's one-call behavior identical to pre-M10.
 *
 * Needs a real database; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[invoices-approval] no real DATABASE_URL — skipping zero-movement test.");
}

describeMaybe("Invoice draft/approval — pre-approval states move zero AR; approval issues it", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;

  const DATE = "2026-06-15";
  const SUBTOTAL = 200;
  const VAT = 30; // 15%
  const TOTAL = 230;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.11" }, fn),
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
      await pool.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM customers WHERE organization_id = $1`, [orgId]);
    }
    if (userId) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE email = 'inv-approval@test.local'`);
    await pool.query(`DELETE FROM companies WHERE name = 'INV-APPR Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'inv-appr'`);
  };

  beforeAll(async () => {
    await pool.query(`DELETE FROM organizations WHERE slug = 'inv-appr'`);
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('INV-APPR Org','inv-appr') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'INV-APPR Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('inv-approval@test.local','Inv Approver',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name, name_ar, tax_number) VALUES ($1,'Beta Client','بيتا','300000000000003') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function expectZeroAR(label: string) {
    const ar = await reportsService.arAging();
    expect(ar.total, `${label}: AR aging total`).toBe(0);
    const bs = await reportsService.balanceSheet();
    expect(bs.assets.accountsReceivable, `${label}: balance-sheet AR`).toBe(0);
    const vat = await reportsService.vatReturn("2026-06", "2026-06");
    expect(vat.salesSection.box8_totalOutputVat, `${label}: output VAT`).toBe(0);
  }

  let invId = 0;

  it("a bookkeeper's create yields a DRAFT with NO ZATCA hash (no sequence consumed)", async () => {
    const inv = await inTenant(() =>
      invoicesService.create(
        { invoiceNumber: "INV-Z1", date: DATE, customerId, items: [{ description: "Consulting", quantity: 1, unitPrice: SUBTOTAL, vatRate: 15 }] },
        userId,
        { autoApprove: false },
      ),
    );
    invId = inv.id;
    expect(inv.status).toBe("draft");
    expect(inv.invoiceHash).toBeNull();
    expect(inv.qrCode).toBeNull();
    expect(inv.total).toBe(TOTAL);
  });

  it("DRAFT: moves zero AR in every approved-only invoice report", async () => {
    await inTenant(() => expectZeroAR("draft"));
  });

  it("SUBMIT (draft → submitted): still zero, still unhashed, and edit-locked", async () => {
    const inv = await inTenant(() => invoicesService.submit(invId, userId));
    expect(inv.status).toBe("submitted");
    expect(inv.invoiceHash).toBeNull();
    await inTenant(() => expectZeroAR("submitted"));
    await expect(inTenant(() => invoicesService.update(invId, { notes: "no" }))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("SEND-BACK (submitted → draft) with a note: still zero, note surfaced", async () => {
    const inv = await inTenant(() => invoicesService.sendBack(invId, "Add the PO number", userId));
    expect(inv.status).toBe("draft");
    expect(inv.reviewNote).toBe("Add the PO number");
    await inTenant(() => expectZeroAR("sent-back draft"));
  });

  it("a draft invoice is NOT payable (must be approved first)", async () => {
    await expect(inTenant(() => invoicesService.pay(invId, { amount: TOTAL }, userId))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("RESUBMIT then APPROVE issues the invoice: AR posted + ZATCA hash/QR minted", async () => {
    await inTenant(() => invoicesService.submit(invId, userId));
    const issued = await inTenant(() => invoicesService.approve(invId, userId));
    expect(issued.status).toBe("sent");
    expect(issued.invoiceHash).toBeTruthy();
    expect(issued.qrCode).toBeTruthy();
    expect(issued.previousHash).toBeTruthy(); // GENESIS for the first approved invoice
    expect(issued.reviewNote).toBeNull();
  });

  it("APPROVED: the AR movement now appears in every approved-only invoice report", async () => {
    await inTenant(async () => {
      const ar = await reportsService.arAging();
      expect(ar.total).toBe(TOTAL);

      const bs = await reportsService.balanceSheet();
      expect(bs.assets.accountsReceivable).toBe(TOTAL);

      const vat = await reportsService.vatReturn("2026-06", "2026-06");
      expect(vat.salesSection.box8_totalOutputVat).toBe(VAT);
      expect(vat.salesSection.box1_standardRatedDomesticSales).toBe(SUBTOTAL);
    });
  });

  it("pay guard: a missing/invalid amount is a 400, not a 500", async () => {
    await expect(inTenant(() => invoicesService.pay(invId, {} as never, userId))).rejects.toMatchObject({ statusCode: 400 });
  });

  it("pay with a valid amount settles the invoice", async () => {
    const paid = await inTenant(() => invoicesService.pay(invId, { amount: TOTAL }, userId));
    expect(paid.status).toBe("paid");
  });

  it("records every transition in the audit trail", async () => {
    const rows = (
      await pool.query(
        `SELECT action FROM audit_logs WHERE entity_type = 'invoice' AND entity_id = $1 ORDER BY created_at ASC`,
        [String(invId)],
      )
    ).rows.map((r) => r.action);
    for (const action of ["create", "submit", "send_back", "approve", "pay"]) {
      expect(rows, `audit should contain ${action}`).toContain(action);
    }
  });

  it("self-approve-on-create: an approver's create issues immediately (hash + AR), identical to pre-M10", async () => {
    const inv = await inTenant(() =>
      invoicesService.create(
        { invoiceNumber: "INV-Z2", date: DATE, customerId, items: [{ description: "Consulting", quantity: 1, unitPrice: 50, vatRate: 15 }] },
        userId,
        { autoApprove: true },
      ),
    );
    expect(inv.status).toBe("sent");
    expect(inv.invoiceHash).toBeTruthy();
    expect(inv.qrCode).toBeTruthy();
  });
});
