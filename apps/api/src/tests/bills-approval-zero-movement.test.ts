/**
 * Bill draft/approval — ZERO-MOVEMENT proof (M10.3), the entity template applied
 * to bills. Mirrors the journal-entry template (spec §7) for the AP side.
 *
 * Proves through the REAL report services that a bill has ZERO effect on the
 * books at every pre-approval state — `draft` AND `submitted` — across the
 * approved-only bill reports (AP aging, balance-sheet Accounts Payable, and the
 * VAT-return input-VAT/bill side), and that APPROVAL is what posts it. Also
 * exercises the full state machine (submit → send-back → resubmit → approve),
 * the pay-authority + amount guards (the pre-existing bill-pay 500 is now a 400),
 * and the audit trail for every transition.
 *
 * Runs inside a real tenant transaction (RLS-scoped). Needs a real database;
 * skips when DATABASE_URL is unset or the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[bills-approval] no real DATABASE_URL — skipping zero-movement test.");
}

describeMaybe("Bill draft/approval — pre-approval states move zero AP; approval posts it", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let vendorId = 0;

  const DATE = "2026-05-15";
  const SUBTOTAL = 100;
  const VAT = 15;
  const TOTAL = 115;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.10" }, fn),
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
      await pool.query(`DELETE FROM bill_items WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM bills WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM vendors WHERE organization_id = $1`, [orgId]);
    }
    if (userId) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE email = 'bill-approval@test.local'`);
    await pool.query(`DELETE FROM companies WHERE name = 'BILL-APPR Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'bill-appr'`);
  };

  beforeAll(async () => {
    await pool.query(`DELETE FROM organizations WHERE slug = 'bill-appr'`);
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('BILL-APPR Org','bill-appr') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'BILL-APPR Co','1010101010','399999999999993') RETURNING id`, [orgId])).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('bill-approval@test.local','Bill Approver',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    // Vendor with a valid ZATCA VAT number so approval needs no force override.
    vendorId = (
      await pool.query(
        `INSERT INTO vendors (organization_id, name, name_ar, tax_number) VALUES ($1,'Acme Supplies','آكمي','300000000000003') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  /** Assert every approved-only bill report shows zero AP movement. */
  async function expectZeroAP(label: string) {
    const ap = await reportsService.apAging();
    expect(ap.total, `${label}: AP aging total`).toBe(0);
    const bs = await reportsService.balanceSheet();
    expect(bs.liabilities.accountsPayable, `${label}: balance-sheet AP`).toBe(0);
    const vat = await reportsService.vatReturn("2026-05", "2026-05");
    expect(vat.purchasesSection.box15_totalInputVat, `${label}: VAT input`).toBe(0);
  }

  let billId = 0;

  it("creates a bill as a draft (no caller status honored)", async () => {
    const bill = await inTenant(() =>
      billsService.create(
        { billNumber: "BILL-Z1", date: DATE, vendorId, status: "received", subtotal: SUBTOTAL, vatAmount: VAT, total: TOTAL, items: [] },
        userId,
      ),
    );
    billId = bill.id;
    expect(bill.status).toBe("draft"); // caller-supplied "received" is ignored
    expect(bill.reviewNote).toBeNull();
  });

  it("DRAFT: moves zero AP in every approved-only bill report", async () => {
    await inTenant(() => expectZeroAP("draft"));
  });

  it("SUBMIT (draft → submitted) — still zero, and the draft is now locked to edits", async () => {
    const bill = await inTenant(() => billsService.submit(billId, userId));
    expect(bill.status).toBe("submitted");
    await inTenant(() => expectZeroAP("submitted"));
    // submitted is locked: editing is rejected.
    await expect(inTenant(() => billsService.update(billId, { notes: "nope" }))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("SEND-BACK (submitted → draft) with a note — still zero, note surfaced", async () => {
    const bill = await inTenant(() => billsService.sendBack(billId, "Fix the VAT amount", userId));
    expect(bill.status).toBe("draft");
    expect(bill.reviewNote).toBe("Fix the VAT amount");
    await inTenant(() => expectZeroAP("sent-back draft"));
  });

  it("a draft bill is NOT payable (must be approved first)", async () => {
    await expect(inTenant(() => billsService.pay(billId, { amount: TOTAL }, userId))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("RESUBMIT then APPROVE posts the bill to the GL (AP/expense/input VAT)", async () => {
    await inTenant(() => billsService.submit(billId, userId));
    const approved = await inTenant(() => billsService.approve(billId, {}, userId));
    expect(approved.status).toBe("received");
    expect(approved.reviewNote).toBeNull(); // cleared on approve
  });

  it("APPROVED: the AP movement now appears in every approved-only bill report", async () => {
    await inTenant(async () => {
      const ap = await reportsService.apAging();
      expect(ap.total).toBe(TOTAL);

      const bs = await reportsService.balanceSheet();
      expect(bs.liabilities.accountsPayable).toBe(TOTAL);

      const vat = await reportsService.vatReturn("2026-05", "2026-05");
      expect(vat.purchasesSection.box15_totalInputVat).toBe(VAT);
      expect(vat.purchasesSection.box9_standardRatedPurchases).toBe(SUBTOTAL);
    });
  });

  it("pay guard: a missing/invalid amount is a 400, not a 500 (the pre-existing bug)", async () => {
    await expect(inTenant(() => billsService.pay(billId, {} as never, userId))).rejects.toMatchObject({ statusCode: 400 });
  });

  it("pay with a valid amount settles the bill", async () => {
    const paid = await inTenant(() => billsService.pay(billId, { amount: TOTAL }, userId));
    expect(paid.status).toBe("paid");
    expect(paid.paidAmount).toBe(TOTAL);
  });

  it("records every transition in the audit trail", async () => {
    const rows = (
      await pool.query(
        `SELECT action FROM audit_logs WHERE entity_type = 'bill' AND entity_id = $1 ORDER BY created_at ASC, id ASC`,
        [String(billId)],
      )
    ).rows.map((r) => r.action);
    for (const action of ["create", "submit", "send_back", "approve", "pay"]) {
      expect(rows, `audit should contain ${action}`).toContain(action);
    }
  });

  it("reject hard-deletes a non-approved draft (no archive)", async () => {
    const draft = await inTenant(() =>
      billsService.create({ billNumber: "BILL-Z2", date: DATE, vendorId, subtotal: 10, vatAmount: 0, total: 10, items: [] }, userId),
    );
    await inTenant(() => billsService.reject(draft.id, userId));
    const rows = await pool.query(`SELECT id FROM bills WHERE id = $1`, [draft.id]);
    expect(rows.rowCount).toBe(0);
  });
});
