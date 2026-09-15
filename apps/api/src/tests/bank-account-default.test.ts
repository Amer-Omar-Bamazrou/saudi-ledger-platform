/**
 * ONE DEFAULT BANK ACCOUNT, SET BY THE TENANT, PRINTED ON THE INVOICE.
 *
 * 🔴 WHY THIS EXISTS (2026-09-15, workflow audit, coming-soon
 * "bank-account-detail"): the invoice PDF prints bank details for the account
 * flagged `is_default`, and nothing in the product could set that flag — the
 * page hard-coded false on create and offered no control; the only writer was
 * the demo seed. Every real tenant's invoice shipped with no bank details.
 * There was also no exclusivity: two accounts could both be default and the
 * PDF took whichever the list returned first.
 *
 * Exclusivity is a property of the WRITE (bankAccounts.service), so it holds
 * when the UI is bypassed:
 *   - setting a default clears the previous one (movement, both directions);
 *   - across three accounts exactly one is default after any sequence;
 *   - another tenant's default is untouched (presence, absence, movement);
 *   - the invoice document model picks the NEW default.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { bankAccountsService } from "../services/bankAccounts.service";
import { invoicesService } from "../services/invoices.service";
import { buildInvoiceDocModel } from "../services/invoiceDocument/invoiceDocument.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const SLUG = "bank-default";
const SLUG_OTHER = "bank-default-other";
const EMAIL = "bank-default@test.local";

describeMaybe("one default bank account, set by the tenant, printed on the invoice", () => {
  let orgId = "";
  let companyId = "";
  let otherOrgId = "";
  let otherCompanyId = "";
  let userId = 0;
  let customerId = 0;

  const tenant = (org: string, company: string) => async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: company, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };
  const inTenant = <T,>(fn: () => Promise<T>) => tenant(orgId, companyId)(fn);
  const inOther = <T,>(fn: () => Promise<T>) => tenant(otherOrgId, otherCompanyId)(fn);

  const cleanup = async () => {
    for (const slug of [SLUG, SLUG_OTHER]) {
      const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
      for (const t of ["journal_entry_lines", "journal_entries", "invoice_items", "einvoice_documents", "invoices", "customers", "bank_accounts", "audit_logs", "organization_memberships", "categories", "companies"]) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await pool.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
    }
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Bank Default Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'BD Co','1010505053','399999999933303') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Bank Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'BD Other') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','BD',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) {
      await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    }
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'BD Customer') RETURNING id`, [orgId])).rows[0].id;
  });
  afterAll(cleanup);

  const defaults = async (org: string) =>
    (await pool.query(`SELECT name FROM bank_accounts WHERE organization_id = $1 AND is_default ORDER BY name`, [org])).rows.map((r) => r.name as string);

  it("🔴 setting a default CLEARS the previous one — exactly one default after any sequence", async () => {
    const a = await inTenant(() => bankAccountsService.create({ name: "Main", bankName: "Al Rajhi", currency: "SAR", iban: "SA0380000000608010167519" }));
    const b = await inTenant(() => bankAccountsService.create({ name: "Payroll", bankName: "SNB", currency: "SAR" }));
    const c = await inTenant(() => bankAccountsService.create({ name: "Savings", bankName: "Riyad", currency: "SAR" }));
    expect(await defaults(orgId), "nothing is default until chosen").toEqual([]);

    await inTenant(() => bankAccountsService.update(a.id, { isDefault: true }));
    expect(await defaults(orgId)).toEqual(["Main"]);
    await inTenant(() => bankAccountsService.update(b.id, { isDefault: true }));
    expect(await defaults(orgId), "the previous default was cleared").toEqual(["Payroll"]);
    // a create that arrives flagged default also clears the rest
    await inTenant(() => bankAccountsService.create({ name: "New Default", bankName: "ANB", currency: "SAR", isDefault: true }));
    expect(await defaults(orgId)).toEqual(["New Default"]);
    // an update that does NOT touch the flag leaves it alone
    await inTenant(() => bankAccountsService.update(c.id, { notes: "untouched" }));
    expect(await defaults(orgId)).toEqual(["New Default"]);
  });

  it("TENANT ISOLATION: the other org's default is untouched by this org's changes, and it shows its own", async () => {
    const theirs = await inOther(() => bankAccountsService.create({ name: "Their Main", bankName: "Alinma", currency: "SAR", isDefault: true }));
    expect(await defaults(otherOrgId)).toEqual(["Their Main"]);
    const mine = (await pool.query(`SELECT id FROM bank_accounts WHERE organization_id = $1 AND name = 'Main'`, [orgId])).rows[0].id;
    await inTenant(() => bankAccountsService.update(mine, { isDefault: true }));
    expect(await defaults(orgId)).toEqual(["Main"]);
    expect(await defaults(otherOrgId), "absence of cross-tenant effect, with the other side still showing its own").toEqual(["Their Main"]);
    expect(theirs.isDefault).toBe(true);
  });

  it("🔴 the invoice document model prints the CURRENT default's details, and follows a change", async () => {
    const inv = await inTenant(() =>
      invoicesService.create({ invoiceNumber: "BD-INV-1", date: "2026-08-01", customerId, items: [{ description: "S", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId),
    );
    await inTenant(() => invoicesService.approve(inv.id, userId));
    const first = await inTenant(() => buildInvoiceDocModel(inv.id, "en"));
    expect(first.bankDetails?.accountName).toBe("Main");
    expect(first.bankDetails?.iban).toBe("SA0380000000608010167519");

    const payroll = (await pool.query(`SELECT id FROM bank_accounts WHERE organization_id = $1 AND name = 'Payroll'`, [orgId])).rows[0].id;
    await inTenant(() => bankAccountsService.update(payroll, { isDefault: true }));
    const second = await inTenant(() => buildInvoiceDocModel(inv.id, "en"));
    expect(second.bankDetails?.accountName, "the document follows the tenant's choice").toBe("Payroll");
  });
});
