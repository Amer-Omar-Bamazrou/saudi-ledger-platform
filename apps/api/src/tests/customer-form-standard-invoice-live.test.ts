/**
 * 🔴 THE CUSTOMER FORM → A STANDARD TAX INVOICE → ZATCA, LIVE (owner, 2026-11-24: "first check, through the form's own
 * requests, whether an onboarded company can issue a standard invoice to a Saudi business customer created in the app,
 * and report the result from the live sandbox").
 *
 * Over REAL HTTP into the app: create a Saudi business customer with THE CUSTOMER FORM'S OWN REQUEST, issue a
 * standard-rated invoice to it with the invoice form's own lines (`invoiceLinesBody`), read the issued ROW BACK OUT OF
 * POSTGRES → assemble → sign with a live compliance CSID → submit to ZATCA's compliance endpoint. Standing rule 3's live
 * pass for the path (real HTTP → engine → Postgres → ZATCA, observed values).
 *
 * 🔴 OBSERVED BEFORE the form carried the national address (2026-11-24, the form's body as Customers.tsx sent it — a
 * free-text address and a city): the app ISSUED the standard invoice (HTTP 200), and ZATCA's sandbox answered WARNING
 * with BR-KSA-63, BR-KSA-67, BR-KSA-10, BR-KSA-F-06-C23 and BR-KSA-F-06-C28 — every buyer-address rule broken; nothing
 * rejected it. Evidence: research/customer-form/01-live-before.log.
 *
 * NOW: (A) the customer form's own request (`customerFormBody`, @workspace/shared — what the form sends) with the
 * national address → the app issues → the sandbox accepts with NONE of those warnings. (B) the old body, an address in
 * free text only → the app refuses the approval (`buyer_address_incomplete`); nothing is issued and nothing is sent.
 *
 * Skips loudly when ZATCA is unreachable or there is no database.
 */
process.env.SESSION_SECRET ??= "customer-form-live-session-secret-0123456789";
process.env.PORT ??= "3000";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";
process.env.MFA_ENFORCEMENT = "optional";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { loadEInvoiceInput } from "../services/einvoice/einvoiceInput.loader";
import { invoicesRepository } from "../repositories/invoices.repository";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { assembleSignedInvoice } from "../services/einvoice/crypto/assembleSignedInvoice";
import { generateZatcaKeyPair } from "../services/einvoice/crypto/keys";
import { buildZatcaCsr } from "../services/einvoice/crypto/csr";
import { tokenToPem } from "../services/einvoice/onboarding/zatcaOnboardingClient";
import { blankCustomerForm, customerFormBody, emptyInvoiceLine, invoiceLinesBody } from "@workspace/shared";

const BASE = process.env.ZATCA_SANDBOX_BASE ?? "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const LIVE_DISABLED = process.env.ZATCA_LIVE_TESTS === "0";
const SELLER_VAT = "310123456789013";
const PW = "CustomerFormLivePw1!";
const h = g04Harness("custformlive");

let certPem = "";
let auth = "";
let keyPair: ReturnType<typeof generateZatcaKeyPair>;
let ready = false;
let skipReason = "";
let orgId = "";
let companyId = "";
let userId = 0;
let invoiceId = 0;
let oldBodyApproval: { status: number; body: any } = { status: 0, body: null };
let oldBodyInvoice = 0;

interface Validation { status?: string; errorMessages?: { code: string; message: string }[]; warningMessages?: { code: string; message: string }[] }

async function obtainCsid(): Promise<void> {
  keyPair = generateZatcaKeyPair();
  const csrPem = buildZatcaCsr(
    { commonName: "SLP-EGS-CUSTFORM-LIVE", organizationName: "Al-Noor Trading", organizationalUnitName: "Head Office", countryName: "SA", invoiceType: "1100", locationAddress: "Riyadh", industryBusinessCategory: "Trading", organizationIdentifier: SELLER_VAT, egsSerialNumber: "1-SLP|2-Platform|3-CUSTFORM-LIVE", production: false },
    keyPair.privateKey, keyPair.publicKey,
  );
  const res = await fetch(`${BASE}/compliance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Version": "V2", OTP: "123456" },
    body: JSON.stringify({ csr: Buffer.from(csrPem, "utf8").toString("base64") }),
  });
  const body = (await res.json()) as Record<string, string>;
  if (res.status !== 200 || !body.binarySecurityToken) throw new Error(`no compliance CSID: ${res.status}`);
  certPem = tokenToPem(body.binarySecurityToken);
  auth = "Basic " + Buffer.from(`${body.binarySecurityToken}:${body.secret}`).toString("base64");
}

async function submitFromLedger(id: number): Promise<{ xml: string; v: Validation }> {
  const input = await h.inTenant(orgId, companyId, userId, async () => {
    const [inv] = await invoicesRepository.findById(id);
    return loadEInvoiceInput(id, await invoicesRepository.zatcaPreviousInvoiceHash(inv.companyId, id));
  });
  const xml = buildInvoiceXml(input);
  const assembled = assembleSignedInvoice({
    xml, certificatePem: certPem, privateKey: keyPair.privateKey, publicKey: keyPair.publicKey,
    qr: { sellerName: input.seller.legalName, vatNumber: input.seller.vatNumber ?? SELLER_VAT, issuedAt: input.issuedAt, totalWithVat: input.taxInclusiveTotal, vatTotal: input.taxTotal },
  });
  const res = await fetch(`${BASE}/compliance/invoices`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Version": "V2", "Accept-Language": "en", Authorization: auth },
    body: JSON.stringify({ invoiceHash: assembled.invoiceHash, uuid: input.uuid, invoice: Buffer.from(assembled.signedXml, "utf8").toString("base64") }),
  });
  return { xml, v: ((await res.json()) as { validationResults?: Validation }).validationResults ?? {} };
}

beforeAll(async () => {
  if (!REAL_DB) { skipReason = "no real DATABASE_URL"; return; }
  await h.cleanup();
  orgId = await h.mkOrg("trading");
  companyId = await h.mkCompany(orgId, "Al-Noor Trading", SELLER_VAT);
  await pool.query(`UPDATE companies SET name_ar = 'النور للتجارة', cr_number = '1010101049', building_number = '1234', street = 'King Fahd Road', district = 'Al Olaya', city = 'Riyadh', postal_code = '12345', additional_number = '6789' WHERE id = $1`, [companyId]);
  userId = await h.mkUser("admin", PW, orgId, "admin");
  await h.start();
  expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
  // (A) 🔴 THE CUSTOMER FORM'S OWN REQUEST — customerFormBody, as the form builds it — with the national address
  const form = { ...blankCustomerForm(), name: "Al-Waha Trading Co", nameAr: "شركة الواحة التجارية", taxNumber: "300000000000003", crNumber: "1010202020", phone: "+966500000123", email: "accounts@alwaha.example.sa",
    buildingNumber: "4321", street: "Olaya Street", district: "Al Olaya", city: "Riyadh", postalCode: "12211", additionalNumber: "6789" };
  const customer = await h.api("admin", "POST", "/customers", customerFormBody("create", form, blankCustomerForm()));
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  const line = invoiceLinesBody([{ ...emptyInvoiceLine(), description: "Consulting services, August", quantity: "1", unitPrice: "1000" }]);
  const draft = await h.api("admin", "POST", "/invoices", { date: "2026-08-01", dueDate: "2026-08-31", customerId: customer.body.id, items: line });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  expect((await h.api("admin", "POST", `/invoices/${draft.body.id}/submit`)).status).toBe(200);
  const approved = await h.api("admin", "POST", `/invoices/${draft.body.id}/approve`);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  invoiceId = draft.body.id;
  // (B) the old body — an address in free text only, as the form sent before the national address existed
  const old = await h.api("admin", "POST", "/customers", { name: "Al-Nakheel Trading", taxNumber: "300000000000003", crNumber: "1010303030", address: "Building 4321, Olaya Street, Al Olaya, Riyadh 12211", city: "Riyadh", paymentTermsDays: "30", creditLimit: null });
  expect(old.status).toBe(201);
  const oldDraft = await h.api("admin", "POST", "/invoices", { date: "2026-08-02", dueDate: "2026-09-01", customerId: old.body.id, items: line });
  expect((await h.api("admin", "POST", `/invoices/${oldDraft.body.id}/submit`)).status).toBe(200);
  oldBodyApproval = await h.api("admin", "POST", `/invoices/${oldDraft.body.id}/approve`);
  oldBodyInvoice = oldDraft.body.id;
  if (LIVE_DISABLED) { skipReason = "ZATCA_LIVE_TESTS=0"; return; }
  try { await obtainCsid(); ready = true; } catch (err) { skipReason = String(err); }
}, 180_000);
afterAll(async () => { await h.stop(); await h.cleanup(); });

describe("the customer form → a standard tax invoice → ZATCA (live)", () => {
  it("🔴 (A) the form's own request with the national address: the app issues, and the sandbox accepts with none of the buyer-address warnings", async (ctx) => {
    if (!ready) { console.log(`[CUSTOMER-FORM-LIVE] SKIPPED: ${skipReason}`); ctx.skip(); return; }
    const { xml, v } = await submitFromLedger(invoiceId);
    console.log(`[CUSTOMER-FORM-LIVE] ZATCA status: ${v.status}`);
    for (const m of [...(v.errorMessages ?? []), ...(v.warningMessages ?? [])]) console.log(`[CUSTOMER-FORM-LIVE] ${m.code}: ${m.message}`);
    expect(xml).toContain("Olaya Street");
    const codes = [...(v.errorMessages ?? []), ...(v.warningMessages ?? [])].map((m) => m.code);
    expect({ accepted: v.status === "PASS" || v.status === "WARNING", errors: (v.errorMessages ?? []).map((m) => m.code), buyerAddress: codes.filter((c) => ["BR-KSA-63", "BR-KSA-67", "BR-KSA-10", "BR-KSA-F-06-C23", "BR-KSA-F-06-C28"].includes(c)) })
      .toEqual({ accepted: true, errors: [], buyerAddress: [] });
  });

  it("🔴 (B) the old body — an address in free text only — is refused at approval, by name; nothing is issued, nothing reaches ZATCA", async () => {
    expect([oldBodyApproval.status, oldBodyApproval.body?.code]).toEqual([422, "buyer_address_incomplete"]);
    const row = (await pool.query(`SELECT status, icv FROM invoices WHERE id = $1`, [oldBodyInvoice])).rows[0];
    expect(row).toEqual({ status: "submitted", icv: null });
  });
});
