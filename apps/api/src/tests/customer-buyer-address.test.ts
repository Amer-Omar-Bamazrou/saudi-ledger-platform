/**
 * 🔴 A STANDARD TAX INVOICE NAMES ITS BUYER'S ADDRESS BEFORE APPROVAL (owner, 2026-11-24; buyerAddress.ts for the rule
 * and its sources: ZATCA's live sandbox flags BR-KSA-63, BR-KSA-67 and BR-KSA-10 on a Saudi buyer with no structured
 * address, and the pinned XML standard v1.2 states them).
 *
 *  - A Saudi business buyer (a VAT number; country SA or unset) without street, building number, a 5-digit postal code,
 *    city and district: approval is REFUSED, 422 `buyer_address_incomplete`, each missing field named in both languages —
 *    and NOTHING is issued (no ICV, no hash, no journal entry).
 *  - Movement: complete the address through the customer's own PATCH, and the same invoice approves.
 *  - A buyer outside Saudi Arabia needs street, city and country only; a simplified invoice (no VAT number) needs none;
 *    a credit note is never refused by this rule (it corrects an invoice already issued).
 *  - 🔴 (owner, 2026-11-25, item 7) NO ICV IS USED BEFORE THE CHECK PASSES: a refused approval never reaches the
 *    company's sequence lock or the ICV allocator — pinned by spying on both, with the passing approval as the planted
 *    positive (a rollback alone would hide a misordering: the allocator reads max(icv) inside the transaction).
 * DB-backed; skips on the placeholder.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { emptyInvoiceLine, invoiceLinesBody } from "@workspace/shared";
import { primePermissionCache } from "../lib/rbac";
import { assertBuyerAddressForStandardInvoice, missingBuyerAddressFields } from "../services/einvoice/buyerAddress";
import { g04Harness } from "./helpers/g04Harness";
import { invoicesRepository } from "../repositories/invoices.repository";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "customer-buyer-address-password";
const h = g04Harness("buyaddr");
const FULL_SA = { buildingNumber: "4321", street: "Olaya Street", district: "Al Olaya", city: "Riyadh", postalCode: "12211", country: "SA" };

describe("the rule (unit)", () => {
  it("a Saudi standard buyer needs street, building number, a 5-digit postal code, city and district; unset country is Saudi", () => {
    expect(missingBuyerAddressFields({ taxNumber: "300000000000003" })).toEqual(["street", "buildingNumber", "postalCode", "city", "district"]);
    expect(missingBuyerAddressFields({ taxNumber: "300000000000003", ...FULL_SA, postalCode: "1221" })).toEqual(["postalCode"]);
    expect(missingBuyerAddressFields({ taxNumber: "300000000000003", ...FULL_SA })).toEqual([]);
    expect(missingBuyerAddressFields({ taxNumber: "300000000000003", ...FULL_SA, country: null })).toEqual([]);
    // an additional number, if there is one, is 4 digits (the pinned standard: "Buyer Address Additional number (KSA-19) must be 4 digits if it exists")
    expect(missingBuyerAddressFields({ taxNumber: "300000000000003", ...FULL_SA, additionalNumber: "12" })).toEqual(["additionalNumber"]);
    expect(missingBuyerAddressFields({ taxNumber: "300000000000003", ...FULL_SA, additionalNumber: "6789" })).toEqual([]);
  });
  it("a buyer elsewhere needs street and city; a simplified buyer nothing; a credit note is never refused", () => {
    expect(missingBuyerAddressFields({ taxNumber: "GB123456789", country: "GB", city: "London" })).toEqual(["street"]);
    expect(missingBuyerAddressFields({ taxNumber: null })).toEqual([]);
    expect(() => assertBuyerAddressForStandardInvoice("credit_note", { taxNumber: "300000000000003" })).not.toThrow();
  });
});

describeDb("a standard invoice's approval and its buyer's address (real rows)", () => {
  let orgId = "";
  const ids: Record<string, number> = {};

  async function customer(key: string, body: Record<string, unknown>) {
    const r = await h.api("admin", "POST", "/customers", { name: `Buyer ${key}`, ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids[key] = r.body.id;
  }
  async function submitted(customerKey: string): Promise<number> {
    const d = await h.api("admin", "POST", "/invoices", { date: "2026-08-01", dueDate: "2026-08-31", customerId: ids[customerKey], items: invoiceLinesBody([{ ...emptyInvoiceLine(), description: "Services", quantity: "1", unitPrice: "1000" }]) });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect((await h.api("admin", "POST", `/invoices/${d.body.id}/submit`)).status).toBe(200);
    return d.body.id;
  }
  const state = async (id: number) => (await pool.query(`SELECT status, icv, invoice_hash FROM invoices WHERE id = $1`, [id])).rows[0];
  const entries = async (id: number) => Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE source_type = 'invoice' AND source_id = $1`, [id])).rows[0].n);

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "Buyer Address Co", "319191919191953");
    await h.mkUser("admin", PW, orgId, "admin");
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    await customer("saNoAddress", { taxNumber: "300000000000003", address: "free text only", city: "Riyadh" });
    await customer("saFull", { taxNumber: "300000000000003", ...FULL_SA });
    await customer("abroad", { taxNumber: "GB123456789", country: "GB", street: "1 Baker Street", city: "London" });
    await customer("walkIn", { name: "Walk-in" });
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a Saudi business buyer without a structured address: approval refused by name, in both languages — nothing issued", async () => {
    const id = await submitted("saNoAddress");
    const r = await h.api("admin", "POST", `/invoices/${id}/approve`);
    expect([r.status, r.body.code, r.body.missing]).toEqual([422, "buyer_address_incomplete", ["street", "buildingNumber", "postalCode", "district"]]);
    expect(r.body.errorAr).toContain("الرمز البريدي");
    expect(await state(id)).toEqual({ status: "submitted", icv: null, invoice_hash: null });
    expect(await entries(id)).toBe(0);
    // movement: the customer's address completed through its own PATCH — the same invoice now approves
    expect((await h.api("admin", "PATCH", `/customers/${ids.saNoAddress}`, FULL_SA)).status).toBe(200);
    const again = await h.api("admin", "POST", `/invoices/${id}/approve`);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((await state(id)).icv).not.toBeNull();
  });

  it("🔴 no ICV is used before the check passes: the refused approval never reaches the sequence lock or the ICV; the passing one does", async () => {
    await customer("saNoAddress2", { taxNumber: "300000000000003", city: "Riyadh" });
    const refused = await submitted("saNoAddress2");
    const passing = await submitted("saFull");
    const companyMax = async () => (await pool.query(`SELECT max(icv)::int m FROM invoices WHERE company_id = (SELECT company_id FROM invoices WHERE id = $1)`, [refused])).rows[0].m;
    const before = await companyMax();
    const lock = vi.spyOn(invoicesRepository, "lockCompanySequence");
    const next = vi.spyOn(invoicesRepository, "nextIcv");
    try {
      const r = await h.api("admin", "POST", `/invoices/${refused}/approve`);
      expect([r.status, r.body.code]).toEqual([422, "buyer_address_incomplete"]);
      expect([lock.mock.calls.length, next.mock.calls.length]).toEqual([0, 0]);
      expect(await companyMax()).toBe(before);
      // the planted positive: the spies see an approval that passes the check
      const ok = await h.api("admin", "POST", `/invoices/${passing}/approve`);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(lock.mock.calls.length).toBeGreaterThan(0);
      expect(next.mock.calls.length).toBeGreaterThan(0);
      expect((await state(passing)).icv).toBe((before ?? 0) + 1); // the very next number: the refusal left no gap
    } finally {
      lock.mockRestore();
      next.mockRestore();
    }
  });

  it("a Saudi buyer with the full address, a buyer abroad with street and city, and a simplified invoice all approve", async () => {
    for (const key of ["saFull", "abroad", "walkIn"]) {
      const id = await submitted(key);
      const r = await h.api("admin", "POST", `/invoices/${id}/approve`);
      expect([key, r.status]).toEqual([key, 200]);
    }
  });
});
