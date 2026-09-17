/**
 * A CREDIT NOTE IS NOT PAYABLE — and a normal invoice still is.
 *
 * 🔴 WHY THIS EXISTS (2026-09-15, workflow audit W3): `invoicesService.pay`
 * guarded on STATUS only. A credit note is a row in the same table with the
 * same statuses, so a note in `sent` passed the guard and the function posted
 * Dr CASH / Cr AR against it — the opposite of the refund a credit note
 * represents — and marked the note "paid". The Mark Paid button keyed on
 * status too, so this was one click away.
 *
 * Both sides, on one fixture, so the guard is proven narrow:
 *   - paying a credit note is REFUSED and moves NOTHING (no payment row, no
 *     journal entry, status unchanged);
 *   - the same for a debit note;
 *   - the ORIGINAL invoice is still payable, and its payment posts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { ConflictError } from "../lib/errors";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const SLUG = "cn-not-payable";
const EMAIL = "cn-not-payable@test.local";
const DATE = "2026-07-14";

describeMaybe("a credit note cannot be paid; its original still can", () => {
  let orgId = "";
  let companyId = "";
  let bankId = 0;
  let userId = 0;
  let customerId = 0;

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
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bank_accounts WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('CN Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'CN Co','1010505051','399999999933303') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    // D-3: cash posts to a bank's own GL account, so the fixture needs a bank.
    bankId = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'D3 Fixture Bank','ANB') RETURNING id`, [orgId, companyId])).rows[0].id;
    userId = (
      await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','CN',' ','admin',true) RETURNING id`)
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'CN Customer') RETURNING id`, [orgId])).rows[0].id;
  });
  afterAll(cleanup);

  async function issue(num: string, unitPrice: number, extra: Record<string, unknown> = {}) {
    const inv = await inTenant(() =>
      invoicesService.create(
        { invoiceNumber: num, date: DATE, customerId, items: [{ description: "S", quantity: 1, unitPrice, vatRate: 15 }], ...extra },
        userId,
      ),
    );
    await inTenant(() => invoicesService.approve(inv.id, userId));
    return inv.id;
  }
  const ledger = async (invoiceId: number) => {
    const inv = (await pool.query(`SELECT invoice_number, status, paid_amount::text FROM invoices WHERE id = $1`, [invoiceId])).rows[0];
    // D-4: a payment is a `payments` row reached through its allocation (invoice_payments is pre-D-4 history only).
    const pays = (await pool.query(`SELECT count(*)::int AS n FROM payment_allocations WHERE invoice_id = $1 AND payment_id IS NOT NULL`, [invoiceId])).rows[0].n;
    const jes = (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE $2`, [orgId, `GL-${inv.invoice_number}-RCPT-%`])).rows[0].n;
    return { status: inv.status, paidAmount: inv.paid_amount, payments: pays, paymentEntries: jes };
  };

  it("🔴 paying a CREDIT NOTE is refused, and nothing moves", async () => {
    const original = await issue("CNP-1", 1000); // 1150
    const note = await issue("CNP-CN1", 200, { documentType: "credit_note", originalInvoiceId: original, noteReason: "partial return" }); // 230

    await expect(inTenant(() => invoicesService.pay(note, { amount: 230, bankAccountId: bankId }, userId))).rejects.toBeInstanceOf(ConflictError);

    expect(await ledger(note)).toEqual({ status: "sent", paidAmount: "0.00", payments: 0, paymentEntries: 0 });
  });

  it("paying a DEBIT NOTE is refused the same way", async () => {
    const original = await issue("CNP-2", 100);
    const note = await issue("CNP-DN1", 50, { documentType: "debit_note", originalInvoiceId: original, noteReason: "underbilled" });
    await expect(inTenant(() => invoicesService.pay(note, { amount: 57.5, bankAccountId: bankId }, userId))).rejects.toBeInstanceOf(ConflictError);
    expect((await ledger(note)).paymentEntries).toBe(0);
  });

  it("the ORIGINAL invoice is still payable — the guard is narrow", async () => {
    const original = await issue("CNP-3", 1000); // 1150
    await issue("CNP-CN3", 200, { documentType: "credit_note", originalInvoiceId: original, noteReason: "return" }); // credits 230
    // outstanding is credit-aware: 1150 − 230 = 920
    await inTenant(() => invoicesService.pay(original, { amount: 920, bankAccountId: bankId }, userId));
    expect(await ledger(original)).toEqual({ status: "paid", paidAmount: "920.00", payments: 1, paymentEntries: 1 });
  });
});
