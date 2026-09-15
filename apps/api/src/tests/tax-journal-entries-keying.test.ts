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
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";
import { reportsService } from "../services/reports.service";

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
const SLUG = "tax-je-keying";

describeMaybe("tax-journal-entries — keyed on system_code, never on the account's name", () => {
  let orgId = "";
  let companyId = "";
  let cashId = 0;
  let vatOutputId = 0;
  let salesId = 0;
  let taxiId = 0;

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
    for (const t of ["journal_entry_lines", "journal_entries", "audit_logs", "categories", "companies"]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${O}`).catch((e: Error) => {
        if (!/does not exist/.test(e.message)) throw e;
      });
    }
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Tax JE Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'TJ Co') RETURNING id`, [orgId])).rows[0].id;
    const byCode = async (code: string) =>
      (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
    cashId = await byCode("CASH");
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
    const je = await inTenant(() => journalEntriesService.create({ entryNumber, date: "2026-09-10", description: entryNumber, lines }, null));
    await inTenant(() => journalEntriesService.post(je.id, null));
    return je.id;
  };

  it("🔴 a VAT_OUTPUT line IS a tax line; a 'Taxi expenses' line is NOT — presence, absence, and the totals move with the right one", async () => {
    const vatJe = await post("TJ-VAT", [
      { accountId: cashId, accountName: "Cash and Bank", debitAmount: 115, creditAmount: 0 },
      { accountId: salesId, accountName: "Sales Revenue", debitAmount: 0, creditAmount: 100 },
      { accountId: vatOutputId, accountName: "VAT Payable", debitAmount: 0, creditAmount: 15 },
    ]);
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
    const je = await post("TJ-RENAMED", [
      { accountId: cashId, accountName: "Cash and Bank", debitAmount: 23, creditAmount: 0 },
      { accountId: salesId, accountName: "Sales Revenue", debitAmount: 0, creditAmount: 20 },
      { accountId: vatOutputId, accountName: "Output levy", debitAmount: 0, creditAmount: 3 },
    ]);
    const out = await inTenant(() => reportsService.taxJournalEntries("2026-09-01", "2026-09-30"));
    const row = out.entries.find((e) => e.id === je);
    expect(row, "present under a name with no 'vat' or 'tax' in it").toBeDefined();
    expect(row!.lines.filter((l) => l.isTaxLine).map((l) => l.accountName)).toEqual(["Output levy"]);
  });
});
