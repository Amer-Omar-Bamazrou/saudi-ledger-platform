/**
 * B4 — payment history: one row per payment, with ITS OWN date.
 *
 * The fact this table exists to keep: a second partial payment used to
 * overwrite the first one's date permanently (`paid_at` held only the LAST
 * payment). So the core assertion is two payments → two rows → two dates —
 * and the structural cross-check that the dated rows SUM to the running
 * total, which is what makes the new record and the old column incapable of
 * silent drift.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { transactionsService } from "../services/transactions.service";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[payment-history] no real DATABASE_URL — skipping.");

const SLUG = "b4-payments";
const EMAIL = "b4-payments@test.local";

describeMaybe("B4 — every payment keeps its date", () => {
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
    for (const t of [
      "invoice_payments",
      "bill_payments",
      "transactions",
      "journal_entry_lines",
      "journal_entries",
      "invoice_items",
      "invoices",
      "bill_items",
      "bills",
      "customers",
      "vendors",
      "bank_accounts",
      "categories",
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
    }
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('B4 Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'B4','1010101021','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','B4',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'B4 Client') RETURNING id`, [orgId])
    ).rows[0].id;
    vendorId = (
      await pool.query(`INSERT INTO vendors (organization_id, name, name_ar) VALUES ($1,'B4 Vendor','مورد') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("🔴 THE FACT B4 KEEPS: two partial payments are two dated rows — the first date survives the second", async () => {
    const inv = await inTenant(() =>
      createApproved(invoicesService, { invoiceNumber: "B4-INV-1", date: "2026-07-01", customerId, items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] },
        userId),
    );
    await inTenant(() => invoicesService.pay(inv.id, { amount: 400, paidAt: "2026-07-10" }, userId));
    await inTenant(() => invoicesService.pay(inv.id, { amount: 750, paidAt: "2026-08-02" }, userId));

    const history = await inTenant(() => invoicesService.payments(inv.id));
    expect(history).toHaveLength(2);
    // Newest first; the FIRST payment's date is still here — the thing
    // paid_at alone destroyed.
    expect(history.map((p) => p.paidAt)).toEqual(["2026-08-02", "2026-07-10"]);
    expect(history.map((p) => p.amount)).toEqual([750, 400]);
    expect(history.every((p) => !p.backfilled)).toBe(true);

    // The structural cross-check: the dated rows SUM to the running total.
    const { rows: [invRow] } = await pool.query(`SELECT paid_amount, paid_at, status FROM invoices WHERE id = $1`, [inv.id]);
    expect(Number(invRow.paid_amount)).toBe(1150);
    expect(history.reduce((s, p) => s + p.amount, 0)).toBe(Number(invRow.paid_amount));
    expect(invRow.status).toBe("paid");
  });

  it("the bills twin records the same way", async () => {
    const bill = await inTenant(() =>
      billsService.create(
        { billNumber: "B4-BILL-1", date: "2026-07-05", vendorId, subtotal: 200, vatAmount: 30, total: 230, items: [] },
        userId,
      ),
    );
    await inTenant(() => billsService.approve(bill.id, {}, userId));
    await inTenant(() => billsService.pay(bill.id, { amount: 100, paidAt: "2026-07-15" }, userId));
    await inTenant(() => billsService.pay(bill.id, { amount: 130, paidAt: "2026-07-25" }, userId));

    const history = await inTenant(() => billsService.payments(bill.id));
    expect(history).toHaveLength(2);
    expect(history.map((p) => p.paidAt)).toEqual(["2026-07-25", "2026-07-15"]);
    const { rows: [b] } = await pool.query(`SELECT paid_amount FROM bills WHERE id = $1`, [bill.id]);
    expect(history.reduce((s, p) => s + p.amount, 0)).toBe(Number(b.paid_amount));
  });

  it("settling a bank row routes through pay, so the settlement leaves a dated row too", async () => {
    const inv = await inTenant(() =>
      createApproved(invoicesService, { invoiceNumber: "B4-INV-2", date: "2026-07-03", customerId, items: [{ description: "Work", quantity: 1, unitPrice: 100, vatRate: 15 }] },
        userId),
    );
    await inTenant(() =>
      transactionsService.upload({
        rows: [{ date: "2026-07-20", description: "INCOMING B4-INV-2", amount: 115, currency: "SAR", type: "credit" }],
        autoCategrize: false,
      } as never),
    );
    const { rows: [txRow] } = await pool.query(
      `SELECT id FROM transactions WHERE organization_id = $1 AND description = 'INCOMING B4-INV-2'`,
      [orgId],
    );
    await inTenant(() => transactionsService.settle(Number(txRow.id), { invoiceId: inv.id }, userId));

    const history = await inTenant(() => invoicesService.payments(inv.id));
    expect(history).toHaveLength(1);
    expect(history[0].amount).toBe(115);
    expect(history[0].paidAt).toBe("2026-07-20"); // the BANK date, not "today"
  });

  it("🔴 append-only at the GRANTS: the app role holds SELECT + INSERT and nothing else", async () => {
    // The record of when money arrived is exactly the row someone would want
    // to quietly fix. Asserted against `role_table_grants` — measured, never
    // estimated from the schema (the M14 posture) — so a future route cannot
    // re-grant what the role does not have without this test going red.
    for (const table of ["invoice_payments", "bill_payments"]) {
      const { rows: grants } = await pool.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_name = $1 AND grantee = 'authenticated'`,
        [table],
      );
      const privs = grants.map((g: { privilege_type: string }) => g.privilege_type).sort();
      expect(privs, table).toEqual(["INSERT", "SELECT"]);
    }
  });
});
