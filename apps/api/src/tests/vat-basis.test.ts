/**
 * Flaw #6 — "standard-rated" and "VAT was charged" are two different facts.
 *
 * `tax_treatment` is the ZATCA supply taxonomy. It says a supply IS
 * standard-rated; it cannot say that no VAT reached this bank line. Two common
 * cases mean exactly that — a foreign supplier (buyer self-accounts under
 * reverse charge) and a supplier below the registration threshold — and both
 * were being taxed as if VAT had been paid.
 *
 * Live evidence from one SME month: 450.00 of "input VAT" invented on a Google
 * Ads charge and 65.22 on an AWS one. 66% of the entire reconciliation figure
 * was phantom, which INVERTED the purpose of the M16.1 gap view: built to
 * reveal undocumented cash activity, it manufactured fictitious activity
 * instead.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { summaryService } from "../services/summary.service";
import { categorizeTransaction, looksForeignDigitalSupplier } from "../services/categorization/categorizer";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[vat-basis] no real DATABASE_URL — skipping.");

describe("flaw #6 — the engine flags suppliers that charge no KSA VAT", () => {
  it("known foreign digital suppliers are reverse-charge", () => {
    for (const d of [
      "GOOGLE ADS 8129-3021-4455 IE",
      "AWS EMEA SARL WEB SERVICES",
      "META PLATFORMS IRELAND ADS",
      "MICROSOFT AZURE SUBSCRIPTION",
      "ADOBE CREATIVE CLOUD",
    ]) {
      expect(looksForeignDigitalSupplier(d), d).toBe(true);
      expect(categorizeTransaction(d, 3450, "debit")?.vatBasis, d).toBe("reverse_charge");
    }
  });

  it("a foreign supplier the engine cannot CATEGORISE is still flagged when a human categorises it", () => {
    // The detector must not depend on a rule matching — otherwise an
    // uncategorised foreign row, classified by hand later, silently reverts to
    // "VAT was charged" and the phantom returns (flaw #3's lesson).
    expect(looksForeignDigitalSupplier("META PLATFORMS IRELAND")).toBe(true);
    expect(categorizeTransaction("META PLATFORMS IRELAND", 2300, "debit")).toBeNull();
  });

  it("a domestic supplier is NOT flagged — the guess must be narrow", () => {
    for (const d of ["SAUDI ELECTRICITY COMPANY BILL", "SADAD PAYMENT - STC 0112345678", "AL BAIK RESTAURANT"]) {
      expect(looksForeignDigitalSupplier(d), d).toBe(false);
      expect(categorizeTransaction(d, 800, "debit")?.vatBasis, d).toBeUndefined();
    }
  });
});

describeMaybe("flaw #6 — extraction requires standard-rated AND charged", () => {
  const SLUG = "vat-basis";
  const EMAIL = "vat-basis@test.local";
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let accountId = 0;

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
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bank_accounts WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('VB Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'VB','1010101022','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','VB',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    accountId = (
      await pool.query(
        `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'VB SAR','Riyad') RETURNING id`,
        [orgId, companyId],
      )
    ).rows[0].id;
  });

  afterAll(cleanup);

  const upload = (rows: unknown[]) =>
    inTenant(() => transactionsService.upload({ rows, autoCategrize: true, bankAccountId: accountId } as never));
  const row = async (like: string) =>
    (
      await pool.query(
        `SELECT id, tax_treatment, vat_basis, vat_amount::text FROM transactions WHERE organization_id = $1 AND description LIKE $2 LIMIT 1`,
        [orgId, like],
      )
    ).rows[0];

  it("🔴 the Google Ads charge no longer invents 450.00 of input VAT", async () => {
    await upload([{ date: "2026-12-01", description: "GOOGLE ADS 8129-3021-4455 IE", amount: 3450, currency: "SAR", type: "debit" }]);
    const r = await row("GOOGLE ADS%");
    expect(r.tax_treatment).toBe("S"); // the SUPPLY is standard-rated…
    expect(r.vat_basis).toBe("reverse_charge"); // …and the PAYMENT carried nothing
    expect(r.vat_amount).toBeNull();
  });

  it("a domestic standard-rated charge still extracts normally", async () => {
    await upload([{ date: "2026-12-02", description: "SAUDI ELECTRICITY COMPANY BILL", amount: 1725, currency: "SAR", type: "debit" }]);
    const r = await row("SAUDI ELECTRICITY%");
    expect(r.tax_treatment).toBe("S");
    expect(r.vat_basis).toBe("charged");
    expect(r.vat_amount).toBe("225.00");
  });

  it("🔴 the DB refuses VAT on a row whose basis says none was charged", async () => {
    await expect(
      pool.query(
        `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, tax_treatment, vat_basis, vat_amount, review_status)
         VALUES ($1,$2,'2026-12-03','VB ILLEGAL RC WITH VAT', 1150, 'debit', 'S', 'reverse_charge', 150, 'accepted')`,
        [orgId, companyId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("the DB refuses an unknown basis value", async () => {
    await expect(
      pool.query(
        `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, vat_basis, review_status)
         VALUES ($1,$2,'2026-12-03','VB BAD BASIS', 10, 'debit', 'sometimes', 'accepted')`,
        [orgId, companyId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("🔴 a human can correct the guess in BOTH directions", async () => {
    const g = await row("GOOGLE ADS%");
    // Google registered in KSA for this product after all — VAT was charged.
    await inTenant(() => transactionsService.update(Number(g.id), { vatBasis: "charged" } as never));
    let after = await row("GOOGLE ADS%");
    expect(after.vat_basis).toBe("charged");
    expect(after.vat_amount).toBe("450.00"); // re-extracted from the gross

    // …and back again.
    await inTenant(() => transactionsService.update(Number(g.id), { vatBasis: "reverse_charge" } as never));
    after = await row("GOOGLE ADS%");
    expect(after.vat_basis).toBe("reverse_charge");
    expect(after.vat_amount).toBeNull();
  });

  it("an unregistered local supplier can be marked as such, clearing the VAT", async () => {
    await upload([{ date: "2026-12-04", description: "SADAD PAYMENT - STC 0119", amount: 862.5, currency: "SAR", type: "debit" }]);
    const r = await row("SADAD PAYMENT - STC 0119%");
    expect(r.vat_amount).toBe("112.50");
    await inTenant(() => transactionsService.update(Number(r.id), { vatBasis: "supplier_unregistered" } as never));
    const after = await row("SADAD PAYMENT - STC 0119%");
    expect(after.vat_amount).toBeNull();
    expect(after.tax_treatment).toBe("S"); // the supply is still standard-rated
  });

  it("moving the treatment off 'S' drops the basis with it", async () => {
    const r = await row("SAUDI ELECTRICITY%");
    await inTenant(() => transactionsService.update(Number(r.id), { taxTreatment: "E" } as never));
    const after = await row("SAUDI ELECTRICITY%");
    expect(after.tax_treatment).toBe("E");
    expect(after.vat_basis).toBeNull(); // "VAT was charged" is meaningless here
    expect(after.vat_amount).toBeNull();
  });

  it("🔴 THE POINT: the reconciliation figure no longer carries phantom VAT", async () => {
    // Two foreign subscriptions and one domestic bill, the shape of a real SME
    // month. Only the domestic one may contribute.
    await upload([
      { date: "2026-12-10", description: "AWS EMEA SARL WEB SERVICES SAR", amount: 1875, currency: "SAR", type: "debit" },
      { date: "2026-12-11", description: "META PLATFORMS IRELAND ADS", amount: 2300, currency: "SAR", type: "debit" },
      { date: "2026-12-12", description: "SADAD PAYMENT - STC 0555", amount: 1150, currency: "SAR", type: "debit" },
    ]);
    const { rows } = await pool.query(
      `SELECT description, vat_amount::text FROM transactions
        WHERE organization_id = $1 AND date >= '2026-12-10' AND vat_amount IS NOT NULL`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toContain("STC 0555");
    expect(rows[0].vat_amount).toBe("150.00");

    const ids = (
      await pool.query(`SELECT id FROM transactions WHERE organization_id = $1 AND date >= '2026-12-10'`, [orgId])
    ).rows.map((r: { id: number }) => Number(r.id));
    await inTenant(() => transactionsService.acceptPending(ids));
    const vat = (await inTenant(() =>
      summaryService.getVat({ dateFrom: "2026-12-10", dateTo: "2026-12-31" }),
    )) as { vatPaid: number };
    expect(vat.vatPaid).toBe(150); // not 150 + 244.57 + 300 of invented VAT
  });
});
