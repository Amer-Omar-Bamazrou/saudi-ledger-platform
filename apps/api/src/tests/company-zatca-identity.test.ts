/**
 * M11.6 acceptance — the ZATCA seller identity comes from the COMPANY.
 *
 * THE PRODUCTION BLOCKER THIS CLOSES: invoice issuance hardcoded
 *   DEFAULT_SELLER_VAT  = "300000000000003"  (the ZATCA SANDBOX placeholder)
 *   DEFAULT_SELLER_NAME = "KSA Ledger Company"
 * duplicated across invoices.service.ts and invoices.approvable.ts, and never
 * consulted `companies.vatNumber` — so every invoice ever issued carried a fake
 * VAT number in its QR (TLV tag 2) and in its hash-chain input.
 *
 * These tests decode the real QR and recompute the real hash to prove the
 * tenant's own registration is what gets stamped, and that issuance now FAILS
 * CLOSED when no VAT number is configured (no placeholder to fall back to).
 *
 * DB-backed; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { computeInvoiceHash } from "../services/accounting/zatca";
import { invoicesService } from "../services/invoices.service";
import { companiesService } from "../services/companies.service";
import { auditContext } from "../lib/auditContext";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[company-zatca] no real DATABASE_URL — skipping.");
}

/** The tenant's REAL registration — deliberately not the sandbox placeholder. */
const COMPANY_VAT = "310123456789013";
const COMPANY_NAME = "Al-Rashid Trading Est.";
const SANDBOX_VAT = "300000000000003";

/** Decode a ZATCA Phase-1 base64 TLV payload back into { tag: value }. */
function decodeTlv(base64: string): Record<number, string> {
  const buf = Buffer.from(base64, "base64");
  const out: Record<number, string> = {};
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    const len = buf[i + 1];
    out[tag] = buf.subarray(i + 2, i + 2 + len).toString("utf-8");
    i += 2 + len;
  }
  return out;
}

describeMaybe("M11.6 — issued invoices carry the COMPANY's ZATCA identity", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = 'zatca-identity')`;
    const U = `(SELECT id FROM users WHERE email LIKE 'zatca-id-%')`;
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM security_audit_logs WHERE organization_id IN ${O} OR actor_user_id IN ${U}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'zatca-id-%'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'zatca-identity'`);
  };

  /** Run `fn` inside a tenant-scoped transaction (RLS + audit context bound). */
  async function asTenant<T>(fn: () => Promise<T>): Promise<T> {
    // Same non-owner RLS role the API drops to per request (matches the other
    // approval tests, which hardcode it rather than loading full app config).
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const result = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: null }, () => fn()),
      );
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(
      `INSERT INTO organizations (name, slug, verification_status) VALUES ('ZATCA Identity','zatca-identity','approved') RETURNING id`,
    )).rows[0].id;
    // Company created WITHOUT a VAT number — the fail-closed case is asserted first.
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name) VALUES ($1,$2) RETURNING id`,
      [orgId, COMPANY_NAME],
    )).rows[0].id;
    userId = (await pool.query(
      `INSERT INTO users (email,name,password_hash,role,is_active) VALUES ('zatca-id-user@test.local','ZATCA Tester',' ','viewer',true) RETURNING id`,
    )).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (await pool.query(
      `INSERT INTO customers (organization_id, name) VALUES ($1,'ZATCA Customer') RETURNING id`,
      [orgId],
    )).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  const newInvoice = (invoiceNumber: string) => ({
    invoiceNumber,
    customerId,
    date: "2026-04-01",
    dueDate: "2026-05-01",
    status: "draft",
    items: [{ description: "Consulting", quantity: 1, unitPrice: 1000, vatRate: 15 }],
  });

  it("FAILS CLOSED when the company has no VAT number (no placeholder fallback)", async () => {
    await expect(
      asTenant(() => invoicesService.create(newInvoice("ZID-000") as any, userId, { autoApprove: true })),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Nothing was issued.
    const rows = await pool.query(
      `SELECT invoice_hash FROM invoices WHERE organization_id = $1 AND invoice_number = 'ZID-000'`,
      [orgId],
    );
    expect(rows.rows.every((r) => r.invoice_hash === null)).toBe(true);
  });

  it("company settings accept a valid VAT/CR and reject malformed ones", async () => {
    await expect(asTenant(() => companiesService.updateCurrent({ vatNumber: "12345" } as any)))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(asTenant(() => companiesService.updateCurrent({ crNumber: "123" } as any)))
      .rejects.toMatchObject({ statusCode: 400 });

    const updated = await asTenant(() =>
      companiesService.updateCurrent({ vatNumber: COMPANY_VAT, crNumber: "1010101010" } as any),
    );
    expect(updated).toMatchObject({ vatNumber: COMPANY_VAT, crNumber: "1010101010", name: COMPANY_NAME });
  });

  it("THE ACCEPTANCE TEST: the issued QR and hash carry the COMPANY's VAT + name", async () => {
    const issued: any = await asTenant(() =>
      invoicesService.create(newInvoice("ZID-001") as any, userId, { autoApprove: true }),
    );
    expect(issued.status).toBe("sent");
    expect(issued.invoiceHash).toBeTruthy();
    expect(issued.qrCode).toBeTruthy();

    const row = (await pool.query(
      `SELECT invoice_number, date::text AS date, total, vat_amount, previous_hash, invoice_hash,
              seller_name, seller_vat_number
         FROM invoices WHERE organization_id = $1 AND invoice_number = 'ZID-001'`,
      [orgId],
    )).rows[0];

    // 1. The PERSISTED seller identity is the company's, NOT the sandbox placeholder.
    expect(row.seller_vat_number).toBe(COMPANY_VAT);
    expect(row.seller_vat_number).not.toBe(SANDBOX_VAT);
    expect(row.seller_name).toBe(COMPANY_NAME);

    // 2. Decode the REAL QR: TLV tag 1 = seller name, tag 2 = VAT number.
    const tlv = decodeTlv(issued.qrCode);
    expect(tlv[1]).toBe(COMPANY_NAME);
    expect(tlv[2]).toBe(COMPANY_VAT);
    expect(tlv[2]).not.toBe(SANDBOX_VAT);

    // 3. Recompute the hash: it only matches if the COMPANY's VAT was the input.
    const recomputed = computeInvoiceHash({
      invoiceNumber: row.invoice_number,
      date: row.date,
      sellerVatNumber: COMPANY_VAT,
      total: Number(row.total).toFixed(2),
      vatAmount: Number(row.vat_amount).toFixed(2),
      previousHash: row.previous_hash,
    });
    expect(recomputed).toBe(row.invoice_hash);

    // ...and would NOT match if the sandbox placeholder had been used.
    const withPlaceholder = computeInvoiceHash({
      invoiceNumber: row.invoice_number,
      date: row.date,
      sellerVatNumber: SANDBOX_VAT,
      total: Number(row.total).toFixed(2),
      vatAmount: Number(row.vat_amount).toFixed(2),
      previousHash: row.previous_hash,
    });
    expect(withPlaceholder).not.toBe(row.invoice_hash);
  });

  it("a changed company VAT is reflected in the NEXT issued invoice", async () => {
    const NEW_VAT = "311111111111113";
    await asTenant(() => companiesService.updateCurrent({ vatNumber: NEW_VAT } as any));

    const issued: any = await asTenant(() =>
      invoicesService.create(newInvoice("ZID-002") as any, userId, { autoApprove: true }),
    );
    const stored = (await pool.query(
      `SELECT seller_vat_number FROM invoices WHERE organization_id = $1 AND invoice_number = 'ZID-002'`,
      [orgId],
    )).rows[0];
    expect(stored.seller_vat_number).toBe(NEW_VAT);
    expect(decodeTlv(issued.qrCode)[2]).toBe(NEW_VAT);
  });

  it("stores the address block + Arabic name and exposes them on read", async () => {
    const out: any = await asTenant(() =>
      companiesService.updateCurrent({
        nameAr: "مؤسسة الراشد التجارية",
        buildingNumber: "1234", street: "King Fahd Road", district: "Al Olaya",
        city: "Riyadh", postalCode: "12212", fiscalYearStart: 1,
      } as any),
    );
    expect(out).toMatchObject({
      nameAr: "مؤسسة الراشد التجارية", buildingNumber: "1234",
      street: "King Fahd Road", district: "Al Olaya", city: "Riyadh", postalCode: "12212",
    });

    const read = await asTenant(() => companiesService.getCurrent());
    expect(read).toMatchObject({ city: "Riyadh", postalCode: "12212" });

    // Malformed national-address fields are rejected.
    await expect(asTenant(() => companiesService.updateCurrent({ postalCode: "12" } as any)))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
