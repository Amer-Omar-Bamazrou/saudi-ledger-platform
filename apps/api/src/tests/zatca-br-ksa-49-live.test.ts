/**
 * 🔴 BR-KSA-49, LIVE — education and healthcare invoices built from REAL LEDGER ROWS pass ZATCA's sandbox with the
 * buyer's Saudi national ID as BT-46 scheme NAT (2026-11-21).
 *
 *   over REAL HTTP into the app, with THE FORM'S OWN REQUEST (@workspace/shared invoiceFormLines.ts `invoiceLinesBody`, the
 *   function the invoice form sends its lines with): create the customer, create, submit and approve the invoice → read the issued ROW BACK
 *   OUT OF POSTGRES → assemble → sign → submit to ZATCA's compliance endpoint — once for VATEX-SA-EDU and once for
 *   VATEX-SA-HEA, each to a citizen with a national ID. This is standing rule 3's live verification pass for the path
 *   (real HTTP → engine → Postgres → ZATCA, observed values).
 *
 * The REJECTING direction — the same exemption on an anonymous invoice — stays pinned in zatca-compliance-live.test.ts
 * ("an anonymous B2C invoice is REJECTED", BR-KSA-49). The refusals at issuance (an iqama, a malformed value, none) are
 * DB-only and live in zatca-br-ksa-49-buyer-nat.test.ts: nothing reaches ZATCA for them.
 *
 * What acceptance here attests: ZATCA's compliance endpoint validated the document (XSD, EN 16931, BR-KSA, signature,
 * QR) with no error. It does NOT attest the national ID is a real person's: the sandbox warns BR-KSA-F-13 for every
 * national ID tried, valid-looking or not, and the check digit's formula is not published (SAMA Appendix C).
 *
 * Skips loudly when ZATCA is unreachable or there is no database.
 */
process.env.SESSION_SECRET ??= "br-ksa-49-live-session-secret-0123456789";
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
import { emptyInvoiceLine, invoiceLinesBody, withCategory } from "@workspace/shared";

const BASE = process.env.ZATCA_SANDBOX_BASE ?? "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const LIVE_DISABLED = process.env.ZATCA_LIVE_TESTS === "0";
const SELLER_VAT = "310123456789013";
const PW = "BrKsa49LivePw1!";
const h = g04Harness("brk49live");
const NATIONAL_ID = "1012345678";

let certPem = "";
let auth = "";
let keyPair: ReturnType<typeof generateZatcaKeyPair>;
let ready = false;
let skipReason = "";
let orgId = "";
let companyId = "";
let userId = 0;
const issued: Record<string, number> = {};

const inTenant = <T>(fn: () => Promise<T>) => h.inTenant(orgId, companyId, userId, fn);

async function obtainCsid(): Promise<void> {
  keyPair = generateZatcaKeyPair();
  const csrPem = buildZatcaCsr(
    {
      commonName: "SLP-EGS-BRKSA49-LIVE",
      organizationName: "Al-Noor Private School",
      organizationalUnitName: "Head Office",
      countryName: "SA",
      invoiceType: "1100",
      locationAddress: "Riyadh",
      industryBusinessCategory: "Education",
      organizationIdentifier: SELLER_VAT,
      egsSerialNumber: "1-SLP|2-Platform|3-BRKSA49-LIVE",
      production: false,
    },
    keyPair.privateKey,
    keyPair.publicKey,
  );
  const res = await fetch(`${BASE}/compliance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Version": "V2", OTP: "123456" },
    body: JSON.stringify({ csr: Buffer.from(csrPem, "utf8").toString("base64") }),
  });
  const body = (await res.json()) as Record<string, string>;
  if (res.status !== 200 || !body.binarySecurityToken) throw new Error(`no compliance CSID: ${res.status}`);
  certPem = tokenToPem(body.binarySecurityToken); // the production conversion (one definition, #362)
  auth = "Basic " + Buffer.from(`${body.binarySecurityToken}:${body.secret}`).toString("base64");
}

interface Validation {
  status?: string;
  errorMessages?: { code: string; message: string }[];
  warningMessages?: { code: string; message: string }[];
}

async function loadFromLedger(invoiceId: number) {
  return inTenant(async () => {
    const [inv] = await invoicesRepository.findById(invoiceId);
    const pih = await invoicesRepository.zatcaPreviousInvoiceHash(inv.companyId, invoiceId);
    return loadEInvoiceInput(invoiceId, pih);
  });
}

async function submitFromLedger(invoiceId: number): Promise<{ xml: string; v: Validation }> {
  const input = await loadFromLedger(invoiceId);
  const xml = buildInvoiceXml(input);
  const assembled = assembleSignedInvoice({
    xml,
    certificatePem: certPem,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    qr: {
      sellerName: input.seller.legalName,
      vatNumber: input.seller.vatNumber ?? SELLER_VAT,
      issuedAt: input.issuedAt,
      totalWithVat: input.taxInclusiveTotal,
      vatTotal: input.taxTotal,
    },
  });
  const res = await fetch(`${BASE}/compliance/invoices`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Version": "V2", "Accept-Language": "en", Authorization: auth },
    body: JSON.stringify({ invoiceHash: assembled.invoiceHash, uuid: input.uuid, invoice: Buffer.from(assembled.signedXml, "utf8").toString("base64") }),
  });
  return { xml, v: ((await res.json()) as { validationResults?: Validation }).validationResults ?? {} };
}

/**
 * ACCEPTED, with one named warning allowed: BR-KSA-F-13 ("recheck Other Seller/Buyer ID (BT-29 or BT-46)"). Measured
 * 2026-11-21: the sandbox gives that WARNING for every national ID sent under scheme NAT — 1012345672, 1012345678,
 * 1000000008, 1111111111 alike — so it does not tell a valid ID from an invalid one, and a warning does not reject the
 * document. Without the ID it is an ERROR (BR-KSA-49); under scheme OTH it is an ERROR too. Any other warning fails.
 */
function expectAccepted(label: string, v: Validation): void {
  const errors = v.errorMessages ?? [];
  const warnings = (v.warningMessages ?? []).filter((w) => w.code !== "BR-KSA-F-13");
  const detail = [...(v.errorMessages ?? []), ...(v.warningMessages ?? [])].map((m) => `${m.code}: ${m.message}`).join("\n      ");
  expect(
    { label, accepted: v.status === "PASS" || v.status === "WARNING", errors: errors.map((e) => e.code), warnings: warnings.map((w) => w.code) },
    `ZATCA did not accept the ${label} built from REAL LEDGER ROWS.\n      ${detail}\n      DIAGNOSE the DB→document path — do not adjust inputs until it passes.`,
  ).toEqual({ label, accepted: true, errors: [], warnings: [] });
}

beforeAll(async () => {
  if (!REAL_DB) { skipReason = "no real DATABASE_URL"; return; }
  await h.cleanup();
  // the identity layer is a fixture (as everywhere); the company's legal identity and address are what issuance prints
  orgId = await h.mkOrg("school");
  companyId = await h.mkCompany(orgId, "Al-Noor Private School", SELLER_VAT);
  await pool.query(`UPDATE companies SET name_ar = 'مدارس النور الأهلية', cr_number = '1010101049', building_number = '1234', street = 'King Fahd Road', district = 'Al Olaya', city = 'Riyadh', postal_code = '12345', additional_number = '6789' WHERE id = $1`, [companyId]);
  userId = await h.mkUser("admin", PW, orgId, "admin");
  await h.start();
  expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
  // everything the document carries is written by the product, over HTTP
  const citizen = await h.api("admin", "POST", "/customers", { name: "Abdulrahman Al-Harbi", nameAr: "عبدالرحمن الحربي", nationalId: NATIONAL_ID });
  expect(citizen.status, JSON.stringify(citizen.body)).toBe(201);
  for (const [code, description, reason] of [
    ["VATEX-SA-EDU", "School tuition, term 1", "Private education to citizen"],
    ["VATEX-SA-HEA", "Outpatient consultation", "Private healthcare to citizen"],
  ] as const) {
    // the form's line: a description, 1 × 1,000, set to zero-rated (ZATCA lists private education and healthcare to
    // citizens as ZERO-RATED, XML Standard v1.2 §11.2.4) and its reason chosen from the list
    const formLine = { ...withCategory({ ...emptyInvoiceLine(), description, quantity: "1", unitPrice: "1000" }, "Z"), taxExemptionReasonCode: code };
    void reason;
    const draft = await h.api("admin", "POST", "/invoices", { date: "2026-08-01", dueDate: "2026-08-31", customerId: citizen.body.id, items: invoiceLinesBody([formLine]) });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await h.api("admin", "POST", `/invoices/${draft.body.id}/submit`)).status).toBe(200);
    const approved = await h.api("admin", "POST", `/invoices/${draft.body.id}/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    issued[code] = draft.body.id;
  }
  if (LIVE_DISABLED) { skipReason = "ZATCA_LIVE_TESTS=0"; return; }
  try {
    await obtainCsid();
    ready = true;
  } catch (err) {
    skipReason = String(err);
  }
  if (!ready) {
    console.warn("\n" + "=".repeat(78) + "\n[BR-KSA-49] SKIPPING the LIVE ZATCA check of education and healthcare invoices built from REAL LEDGER ROWS." +
      `\n            Reason: ${skipReason}\n` + "=".repeat(78) + "\n");
  }
}, 180_000);

afterAll(async () => { if (REAL_DB) { await h.stop(); await h.cleanup(); } });

describe("BR-KSA-49 — education and healthcare invoices from REAL LEDGER ROWS pass ZATCA with the buyer's national ID", () => {
  for (const code of ["VATEX-SA-EDU", "VATEX-SA-HEA"] as const) {
    it(`🔴 ${code}: ZATCA's sandbox accepts it, and it carries BT-46 scheme NAT`, async (ctx) => {
      if (!ready) ctx.skip();
      const { xml, v } = await submitFromLedger(issued[code]!);
      expect(xml, "anti-vacuity: the document names the buyer's national ID").toContain(`<cbc:ID schemeID="NAT">${NATIONAL_ID}</cbc:ID>`);
      expectAccepted(`${code} invoice`, v);
    }, 120_000);
  }
});
