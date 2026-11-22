/**
 * 🔴 BR-KSA-49 — PRIVATE EDUCATION AND HEALTHCARE TO CITIZENS NAME THE BUYER'S SAUDI NATIONAL ID (2026-11-21).
 *
 * Found reading D9 (b) for Phase 19B: the assembler REFUSED an education or healthcare invoice without the customer's
 * national ID, then built the buyer's other ID (BT-46) from the CR number only — so the ID it insisted on never
 * reached the XML, and ZATCA would have rejected the very invoice it was checked for. The owner's rule (2026-11-21):
 * scheme NAT, the Saudi national ID only (10 digits starting with 1, SAMA Account Opening Rules Appendix C); an iqama
 * (starting with 2) is refused by name; the check digit is NOT verified (no official formula is published).
 *
 * For VATEX-SA-EDU and VATEX-SA-HEA, each:
 *   - a valid national ID: issued; the document built FROM THE LEDGER ROWS carries BT-46 with schemeID NAT;
 *   - an iqama, a malformed value, none at all: refused AT ISSUANCE by name, in both languages, with NOTHING issued —
 *     no ICV, no hash, no entry, no e-invoice document. The company here has no ZATCA credential, which is the case the
 *     old check never reached (the assembler runs only for onboarded companies).
 *   - movement: the same customer on a standard-rated line still issues (the rule is the exemption's, not the buyer's).
 *
 * The live sandbox acceptance is zatca-br-ksa-49-live.test.ts. DB-backed (sl_test / CI); skips on the placeholder.
 */
process.env.SESSION_SECRET ??= "br-ksa-49-test-session-secret-0123456789";
process.env.PORT ??= "3000";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { releaseIssuedInvoicesForTeardown } from "./helpers/issuedInvoiceFixtures";
import { releasePostedJournalsForTeardown } from "./helpers/journalFixtures";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { invoicesRepository } from "../repositories/invoices.repository";
import { loadEInvoiceInput } from "../services/einvoice/einvoiceInput.loader";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { replica } from "./helpers/replica";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const SLUG = "br-ksa-49";
const EMAIL = "br-ksa-49@test.local";
const NATIONAL_ID = "1012345678";

describeMaybe("BR-KSA-49 — education and healthcare invoices carry the buyer's Saudi national ID as BT-46 scheme NAT", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  const customers: Record<string, number> = {};

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated", actorUserId: userId });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.49" }, fn));
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
    await releasePostedJournalsForTeardown(`organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await releaseIssuedInvoicesForTeardown(`organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await replica(pool).query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };
  const line = (code: "VATEX-SA-EDU" | "VATEX-SA-HEA" | null) => code
    ? { description: code === "VATEX-SA-EDU" ? "School tuition, term 1" : "Outpatient consultation", quantity: 1, unitPrice: 1000, vatRate: 0, taxCategoryCode: "Z", taxExemptionReasonCode: code, taxExemptionReasonText: code === "VATEX-SA-EDU" ? "Private education to citizen" : "Private healthcare to citizen", unitCode: "PCE" }
    : { description: "Stationery", quantity: 1, unitPrice: 100, vatRate: 15, taxCategoryCode: "S", unitCode: "PCE" };
  let seq = 0;
  const draft = (customer: string, code: "VATEX-SA-EDU" | "VATEX-SA-HEA" | null) =>
    inTenant(() => invoicesService.create({ invoiceNumber: `BRK49-${++seq}`, date: "2026-08-01", dueDate: "2026-08-31", customerId: customers[customer], items: [line(code)] } as never, userId)) as Promise<{ id: number }>;
  const approve = (id: number) => inTenant(() => invoicesService.approve(id, userId));
  const refusal = async (p: Promise<unknown>) => {
    try { await p; return null; } catch (err) { return err as { statusCode?: number; payload?: Record<string, unknown> }; }
  };
  const issuedState = async (id: number) =>
    (await pool.query(`SELECT status, icv, invoice_hash, issued_at FROM invoices WHERE id = $1`, [id])).rows[0];
  const traces = async (id: number) => ({
    entries: (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE source_type = 'invoice' AND source_id = $1`, [id])).rows[0].n,
    documents: (await pool.query(`SELECT count(*)::int n FROM einvoice_documents WHERE invoice_id = $1`, [id])).rows[0].n,
  });

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('BR-KSA-49','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Al-Noor Private School','مدارس النور الأهلية','1010101049','310123456789013','1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','BR-KSA-49',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    for (const [key, nationalId] of [["citizen", NATIONAL_ID], ["resident", "2012345678"], ["malformed", "10123456"], ["letters", "1O12345678"], ["none", null]] as const) {
      customers[key] = (await pool.query(`INSERT INTO customers (organization_id, name, name_ar, national_id) VALUES ($1,$2,$2,$3) RETURNING id`, [orgId, `BRK49 ${key}`, nationalId])).rows[0].id;
    }
  }, 120_000);
  afterAll(cleanup);

  for (const code of ["VATEX-SA-EDU", "VATEX-SA-HEA"] as const) {
    it(`🔴 ${code}: a Saudi national ID is issued, and the document built from the ledger rows carries BT-46 scheme NAT`, async () => {
      const inv = await draft("citizen", code);
      await approve(inv.id);
      expect((await issuedState(inv.id)).icv, "issued").not.toBeNull();
      const xml = await inTenant(async () => {
        const pih = await invoicesRepository.zatcaPreviousInvoiceHash(companyId, inv.id);
        return buildInvoiceXml(await loadEInvoiceInput(inv.id, pih));
      });
      const buyer = /<cac:AccountingCustomerParty>[\s\S]*?<\/cac:AccountingCustomerParty>/.exec(xml)?.[0] ?? "";
      expect(buyer, "the buyer party is in the document").toContain("cac:Party");
      expect(buyer).toMatch(new RegExp(`<cac:PartyIdentification>\\s*<cbc:ID schemeID="NAT">${NATIONAL_ID}</cbc:ID>`));
      expect(buyer, "never the CR scheme in its place").not.toContain(`schemeID="CRN"`);
    });

    for (const [customer, expected] of [
      ["resident", "exemption_requires_saudi_national_id"],
      ["malformed", "buyer_national_id_invalid"],
      ["letters", "buyer_national_id_invalid"],
      ["none", "exemption_requires_buyer_national_id"],
    ] as const) {
      it(`🔴 ${code}: a buyer whose ID is ${customer === "resident" ? "an iqama" : customer === "none" ? "missing" : `invalid (${customer})`} is refused at issuance, named, and nothing is issued or sent`, async () => {
        const inv = await draft(customer, code);
        const err = await refusal(approve(inv.id));
        expect(err, "refused").not.toBeNull();
        expect(err!.statusCode).toBe(422);
        expect(err!.payload).toMatchObject({ code: expected, error: expect.any(String), errorAr: expect.any(String) });
        expect(await issuedState(inv.id), "no ICV, no hash, no issue time").toMatchObject({ icv: null, invoice_hash: null, issued_at: null });
        expect(await traces(inv.id), "no entry, no e-invoice document").toEqual({ entries: 0, documents: 0 });
      });
    }
  }

  it("movement: the same iqama-holding customer on a standard-rated line is issued (the rule is the exemption's)", async () => {
    const inv = await draft("resident", null);
    await approve(inv.id);
    expect((await issuedState(inv.id)).icv).not.toBeNull();
  });
});
