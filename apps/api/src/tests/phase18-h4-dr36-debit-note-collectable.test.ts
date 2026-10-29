/**
 * 🔴 Phase 18 H-4 — DR-36 (OD-14; F-15), debit-note settlement; G62: "Collectable
 * directly, like an invoice. It is its own tax document, with its own number and
 * amount." DECIDED 2026-10-27 — owner accepted the stated recommendation (register
 * §11.50, the scoped D-4 statement, appended before this file). The unreferenced-
 * receipt allocation rule is not built (named as policy; no rule given).
 *
 *  - a debit note is paid directly; a receipt may be allocated to it;
 *  - control: a credit note is still never paid.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { releaseIssuedInvoicesForTeardown } from "./helpers/issuedInvoiceFixtures";
import { releasePostedJournalsForTeardown } from "./helpers/journalFixtures";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { ConflictError } from "../lib/errors";
import { replica } from "./helpers/replica";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const SLUG = "p18-h4-dr36";
const EMAIL = "p18-h4-dr36@test.local";
const DATE = "2026-07-14";

describeMaybe("Phase 18 H-4 — DR-36: a debit note is collectable directly, like an invoice", () => {
  let orgId = "";
  let companyId = "";
  let bankId = 0;
  let userId = 0;
  let customerId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated", actorUserId: userId });
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
    await releasePostedJournalsForTeardown(`organization_id IN ${org}`); // G16: posted entries back to draft for the deletes below
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await releaseIssuedInvoicesForTeardown(`organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await replica(pool).query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
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
    const pays = (await pool.query(`SELECT count(*)::int AS n FROM payment_allocations WHERE invoice_id = $1 AND payment_id IS NOT NULL`, [invoiceId])).rows[0].n;
    return { status: inv.status, paidAmount: inv.paid_amount, payments: pays };
  };
  const arOf = async () => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
       JOIN categories c ON c.id = l.account_id WHERE e.organization_id = $1 AND c.system_code = 'AR' AND e.status IN ('posted','reversed')`, [orgId])).rows[0].v);
  const debitNote = async (num: string, original: number, unitPrice: number) =>
    issue(num, unitPrice, { documentType: "debit_note", originalInvoiceId: original, noteReason: "underbilled freight", chargeSubstance: "price_change", chargeEventDate: DATE });

  it("🔴 a DEBIT NOTE is paid directly, like an invoice — its own receivable falls, and it reads paid", async () => {
    const original = await issue("H4-INV-1", 100);
    const note = await debitNote("H4-DN-1", original, 50); // 57.50
    const ar = await arOf();
    await inTenant(() => invoicesService.pay(note, { amount: 57.5, bankAccountId: bankId }, userId));
    expect(await ledger(note)).toEqual({ status: "paid", paidAmount: "57.50", payments: 1 });
    expect(await arOf() - ar, "the debit note's receivable is collected").toBe(-57.5);
  });

  it("🔴 a customer RECEIPT may be allocated to a debit note", async () => {
    const original = await issue("H4-INV-2", 100);
    const note = await debitNote("H4-DN-2", original, 20); // 23.00
    await inTenant(() => paymentsService.receive({ customerId, amount: 23, paidAt: DATE, bankAccountId: bankId, allocations: [{ invoiceId: note, amount: 23 }] }, userId));
    expect(await ledger(note)).toEqual({ status: "paid", paidAmount: "23.00", payments: 1 });
  });

  it("control: a CREDIT note is still never paid — it reduces what its original owes", async () => {
    const original = await issue("H4-INV-3", 1000);
    const note = await issue("H4-CN-3", 200, { documentType: "credit_note", originalInvoiceId: original, noteReason: "partial return" });
    await expect(inTenant(() => invoicesService.pay(note, { amount: 230, bankAccountId: bankId }, userId))).rejects.toBeInstanceOf(ConflictError);
    expect(await ledger(note)).toEqual({ status: "sent", paidAmount: "0.00", payments: 0 });
  });
});
