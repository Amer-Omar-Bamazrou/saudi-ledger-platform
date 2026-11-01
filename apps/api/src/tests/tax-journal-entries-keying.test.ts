/**
 * THE TAX-JOURNAL-ENTRIES REPORT IS KEYED ON system_code, NOT ON A NAME.
 *
 * 🔴 WHY THIS EXISTS (2026-09-15, item 3 of the second core-path walk): the
 * report selected "tax lines" with `account_name ILIKE '%vat%' OR '%tax%' OR
 * '%ضريبة%' OR '%زكاة%'`, while every posting path resolves accounts by
 * `system_code`. Two definitions of "this is a tax account" with no forcing
 * function — D's English-coupling class, instance (7): a tenant's "Taxi
 * expenses" account was a tax line; a tenant who renamed VAT Payable was not.
 *
 *   - a posted entry on the VAT_OUTPUT account IS a tax entry, and only its
 *     VAT line is flagged (presence);
 *   - a posted entry on an expense account NAMED "Taxi expenses" is NOT a tax
 *     entry (absence — red against the old regex, which matched "Taxi");
 *   - the flagged-line totals are the VAT line's amounts, not the name-matched
 *     ones (movement).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { releasePostedJournalsForTeardown } from "./helpers/journalFixtures";
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";
import { invoicesService } from "../services/invoices.service";
import { reportsService } from "../services/reports.service";
import { deleterFor } from "./helpers/replica";

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
const SLUG = "tax-je-keying";

describeMaybe("tax-journal-entries — keyed on system_code, never on the account's name", () => {
  let orgId = "";
  let companyId = "";
  let bankId = 0;
  let cashId = 0;
  let vatOutputId = 0;
  let salesId = 0;
  let taxiId = 0;
  let customerId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: null, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await releasePostedJournalsForTeardown(`organization_id IN ${O}`); // G16: posted entries back to draft for the deletes below
    await deleterFor(pool, "invoice_items").query(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${O})`).catch(() => undefined);
    for (const t of ["journal_entry_lines", "journal_entries", "einvoice_documents", "invoices", "customers", "audit_logs", "bank_accounts", "categories", "companies"]) {
      await deleterFor(pool, t).query(`DELETE FROM ${t} WHERE organization_id IN ${O}`).catch((e: Error) => {
        if (!/does not exist/.test(e.message)) throw e;
      });
    }
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
    await pool.query(`DELETE FROM users WHERE email = '${SLUG}-approver@test.local'`);
  };

  // T1d (0129): a manual entry is posted by an approval that records its approver, so the approval names a user.
  let approverId = 0;
  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Tax JE Org','${SLUG}') RETURNING id`)).rows[0].id;
    approverId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${SLUG}-approver@test.local', 'Tax JE approver', 'x', 'viewer', true) RETURNING id`)).rows[0].id;
    // R-3 (AC-5; register §11.90): the VAT entries are an approved invoice's own, so the company has the seller identity
    // issuing needs (M11.6) and a customer exists.
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'TJ Co','1010101012','399999999999975') RETURNING id`, [orgId])).rows[0].id;
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'TJ Customer','300000000000093') RETURNING id`, [orgId])).rows[0].id as number;
    // D-3: cash posts to a bank's own GL account, so the fixture needs a bank.
    bankId = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'D3 Fixture Bank','ANB') RETURNING id`, [orgId, companyId])).rows[0].id;
    const byCode = async (code: string) =>
      (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
    cashId = (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [bankId])).rows[0].id as number;
    vatOutputId = await byCode("VAT_OUTPUT");
    salesId = await byCode("SALES");
    // The tenant's own account whose NAME contains "tax" — the regex's false positive.
    taxiId = (
      await pool.query(
        `INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable) VALUES ($1,'Taxi expenses','مصاريف التاكسي','expense',false) RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  });
  afterAll(cleanup);

  const post = async (entryNumber: string, lines: Array<{ accountId: number; accountName: string; debitAmount: number; creditAmount: number }>) => {
    // R-3 (AC-5; register §11.90): an ordinary entry is a MANUAL journal (as before §11.78); a VAT entry is an approved
    // INVOICE's own entry (`invoiceEntry` below) — the product's path to VAT_OUTPUT — found by its source. No stand-in.
    const je = await inTenant(() => journalEntriesService.create({ entryNumber, date: "2026-09-10", description: entryNumber, lines }, null));
    await inTenant(() => journalEntriesService.post(je.id, approverId));
    return je.id;
  };
  const invoiceEntry = async (invoiceNumber: string, unitPrice: number) => {
    const inv = (await inTenant(() => invoicesService.create({ invoiceNumber, date: "2026-09-10", dueDate: "2026-09-25", customerId, items: [{ description: "Service", quantity: 1, unitPrice, vatRate: 15 }] } as never, approverId))) as { id: number };
    await inTenant(() => invoicesService.approve(inv.id, approverId));
    return Number((await pool.query(`SELECT id FROM journal_entries WHERE source_type = 'invoice' AND source_id = $1`, [inv.id])).rows[0].id);
  };

  it("🔴 a VAT_OUTPUT line IS a tax line; a 'Taxi expenses' line is NOT — presence, absence, and the totals move with the right one", async () => {
    const vatJe = await invoiceEntry("TJ-VAT", 100); // Dr AR 115 / Cr Sales 100 / Cr VAT Payable 15
    void cashId; void salesId; void vatOutputId;
    const taxiJe = await post("TJ-TAXI", [
      { accountId: taxiId, accountName: "Taxi expenses", debitAmount: 40, creditAmount: 0 },
      { accountId: cashId, accountName: "Cash and Bank", debitAmount: 0, creditAmount: 40 },
    ]);

    const out = await inTenant(() => reportsService.taxJournalEntries("2026-09-01", "2026-09-30"));
    const ids = out.entries.map((e) => e.id);
    expect(ids, "the VAT entry is present").toContain(vatJe);
    expect(ids, "the 'Taxi expenses' entry is ABSENT — its name is not a tax account").not.toContain(taxiJe);

    const vat = out.entries.find((e) => e.id === vatJe)!;
    expect(vat.lines.filter((l) => l.isTaxLine).map((l) => l.accountName)).toEqual(["VAT Payable"]);
    expect(vat.totalVatCredit).toBe(15);
    expect(vat.totalVatDebit).toBe(0);
  });

  it("a renamed VAT account is STILL a tax account — the code, not the name, is the fact", async () => {
    await pool.query(`UPDATE categories SET name = 'Output levy' WHERE id = $1`, [vatOutputId]);
    const je = await invoiceEntry("TJ-RENAMED", 20); // VAT 3
    const out = await inTenant(() => reportsService.taxJournalEntries("2026-09-01", "2026-09-30"));
    const row = out.entries.find((e) => e.id === je);
    expect(row, "present under a name with no 'vat' or 'tax' in it").toBeDefined();
    // R-3 (register §11.91): the LINE name is the document's ("VAT Payable", what the invoice posting writes); the
    // CATEGORY is "Output levy" — and the report found the entry by system_code under that name all the same.
    expect((await pool.query(`SELECT name FROM categories WHERE id = $1`, [vatOutputId])).rows[0].name).toBe("Output levy");
    expect(row!.lines.filter((l) => l.isTaxLine).map((l) => l.accountName)).toEqual(["VAT Payable"]);
  });
});
