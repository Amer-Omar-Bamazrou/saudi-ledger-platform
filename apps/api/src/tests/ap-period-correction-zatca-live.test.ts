/**
 * THE TWO DOCUMENT SHAPES THE 2026-09-22 CORRECTION CHANGED, AT ZATCA'S LIVE
 * SANDBOX (the top of the trust order — LIVE API > SDK > PDF):
 *
 *   1. a 386 whose supply date (KSA-5, `ActualDeliveryDate`) is the RECEIPT
 *      date, EARLIER than its IssueDate (accountant 1(a): tax point ≠ issuance);
 *   2. the Art. 40(9) RECOVERY INVOICE: a 388 carrying a BillingReference to
 *      the original tax invoice (BG-3 is not restricted to notes by the
 *      standard — BR-KSA-56 only MANDATES it for 381/383) and a KSA-5 earlier
 *      than its IssueDate.
 *
 * Planted negatives prove the instrument reads the fields it is asked about:
 * a KSA-5 LATER than the IssueDate (BR-KSA-... the sandbox names it or does
 * not — recorded either way as what the endpoint attests), and a 388 whose
 * BillingReference names an empty ID (BR-KSA-F-06 / EN BR-55 shape).
 *
 * Both fixtures AND the product's own rows are submitted. Skips LOUDLY.
 */
process.env.SESSION_SECRET ??= "ap-corr-live-test-session-secret-0123456789abcdef";
process.env.PORT ??= "3000";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { generateZatcaKeyPair } from "../services/einvoice/crypto/keys";
import { buildZatcaCsr } from "../services/einvoice/crypto/csr";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { assembleSignedInvoice } from "../services/einvoice/crypto/assembleSignedInvoice";
import { loadEInvoiceInput } from "../services/einvoice/einvoiceInput.loader";
import { invoicesRepository } from "../repositories/invoices.repository";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { advanceInvoicesService } from "../services/advanceInvoices.service";
import { badDebtService } from "../services/badDebt.service";
import { SELLER, advanceInvoice, standardInvoice } from "../services/einvoice/__fixtures__/sampleInput";
import { createApproved } from "./helpers/createApproved";
import type { EInvoiceInput } from "../services/einvoice/types";

const BASE = process.env.ZATCA_SANDBOX_BASE ?? "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
const LIVE_DISABLED = process.env.ZATCA_LIVE_TESTS === "0";
const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const SELLER_VAT = "310123456789013";

interface Message { type: string; code: string; message: string }
interface Answer { httpStatus: number; status?: string; errors: string[]; warnings: string[]; detail: string; clearanceStatus: string | null }

let certPem = "";
let auth = "";
let keyPair: ReturnType<typeof generateZatcaKeyPair>;
let reachable = false;
let skipReason = "";

async function obtainCsid(): Promise<void> {
  keyPair = generateZatcaKeyPair();
  const csrPem = buildZatcaCsr(
    { commonName: "SLP-EGS-APCORR", organizationName: "Al-Rashid Trading Est.", organizationalUnitName: "Head Office", countryName: "SA", invoiceType: "1100", locationAddress: "Riyadh", industryBusinessCategory: "Trading", organizationIdentifier: SELLER_VAT, egsSerialNumber: "1-SLP|2-Platform|3-APCORR", production: false },
    keyPair.privateKey,
    keyPair.publicKey,
  );
  const res = await fetch(`${BASE}/compliance`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Version": "V2", OTP: "123456" }, body: JSON.stringify({ csr: Buffer.from(csrPem, "utf8").toString("base64") }) });
  const body = (await res.json()) as Record<string, string>;
  if (res.status !== 200 || body.dispositionMessage !== "ISSUED") throw new Error(`compliance CSID not issued: ${res.status}`);
  const inner = Buffer.from(body.binarySecurityToken, "base64").toString();
  certPem = `-----BEGIN CERTIFICATE-----\n${inner.replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  auth = "Basic " + Buffer.from(`${body.binarySecurityToken}:${body.secret}`).toString("base64");
}

async function submit(input: EInvoiceInput, xml = buildInvoiceXml(input)): Promise<Answer> {
  const assembled = assembleSignedInvoice({ xml, certificatePem: certPem, privateKey: keyPair.privateKey, publicKey: keyPair.publicKey, qr: { sellerName: input.seller.legalName, vatNumber: input.seller.vatNumber ?? SELLER_VAT, issuedAt: input.issuedAt, totalWithVat: input.taxInclusiveTotal, vatTotal: input.taxTotal } });
  const res = await fetch(`${BASE}/compliance/invoices`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Version": "V2", "Accept-Language": "en", Authorization: auth }, body: JSON.stringify({ invoiceHash: assembled.invoiceHash, uuid: input.uuid, invoice: Buffer.from(assembled.signedXml, "utf8").toString("base64") }) });
  const body = (await res.json()) as { validationResults?: { status?: string; errorMessages?: Message[]; warningMessages?: Message[] }; clearanceStatus?: string | null };
  const v = body.validationResults ?? {};
  const all = [...(v.errorMessages ?? []), ...(v.warningMessages ?? [])];
  return { httpStatus: res.status, status: v.status, errors: (v.errorMessages ?? []).map((m) => m.code), warnings: (v.warningMessages ?? []).map((m) => m.code), detail: all.map((m) => `${m.type} ${m.code}: ${m.message}`).join("\n      "), clearanceStatus: body.clearanceStatus ?? null };
}

function expectAccepted(label: string, a: Answer): void {
  expect({ label, status: a.status, errors: a.errors, warnings: a.warnings, clearanceStatus: a.clearanceStatus }, `ZATCA did not cleanly accept the ${label}.\n      ${a.detail}`).toEqual({ label, status: "PASS", errors: [], warnings: [], clearanceStatus: "CLEARED" });
}

beforeAll(async () => {
  if (LIVE_DISABLED) { skipReason = "ZATCA_LIVE_TESTS=0"; return; }
  try { await obtainCsid(); reachable = true; } catch (err) { skipReason = String(err); }
  if (!reachable) console.warn(`\n${"=".repeat(78)}\n[AP correction] SKIPPING the LIVE ZATCA check of the changed document shapes (a 386 with KSA-5 = the receipt date; the Art. 40(9) 388 with a BillingReference). A green run WITHOUT it attests nothing about them at ZATCA.\n  Reason: ${skipReason}\n${"=".repeat(78)}\n`);
}, 120_000);

describe("AP correction — the changed document shapes at the LIVE sandbox (fixtures)", () => {
  it("🔴 a 386 whose supply date (KSA-5) is the receipt date, EARLIER than its IssueDate: PASS, no warnings, CLEARED", async (ctx) => {
    if (!reachable) ctx.skip();
    expectAccepted("386 with KSA-5 = receipt date (2026-01-30) and IssueDate 2026-04-01", await submit(advanceInvoice({ supplyDate: "2026-01-30" })));
  }, 120_000);

  it("🔴 the Art. 40(9) recovery invoice: a 388 with a BillingReference to the original, KSA-5 = the payment date, IssueDate later: PASS, no warnings, CLEARED", async (ctx) => {
    if (!reachable) ctx.skip();
    const input = standardInvoice({ invoiceNumber: "INV-REC-0001", uuid: "7c3d2e1f-0a9b-4c8d-8e7f-6a5b4c3d2e1f", icv: 9, documentType: "recovery_invoice", supplyDate: "2026-03-10", billingReference: { invoiceNumber: "INV-0001" }, notes: "Tax invoice under VAT Implementing Regulations Art. 40(9): consideration received on 2026-03-10 against tax invoice INV-0001, on which bad-debt relief (Art. 40(7)) was claimed on 2026-01-20. The amount has been received." });
    expectAccepted("Art. 40(9) recovery 388 with BillingReference + KSA-5 < IssueDate", await submit(input));
  }, 120_000);

  it("planted negative — a 388 whose BillingReference names an EMPTY id: the sandbox names the rule (so the accepted BillingReference above was READ)", async (ctx) => {
    if (!reachable) ctx.skip();
    const input = standardInvoice({ invoiceNumber: "INV-REC-0002", uuid: "7c3d2e1f-0a9b-4c8d-8e7f-6a5b4c3d2e2f", icv: 10, documentType: "recovery_invoice", supplyDate: "2026-03-10", billingReference: { invoiceNumber: "PLACEHOLDER" } });
    const xml = buildInvoiceXml(input).replace("<cbc:ID>PLACEHOLDER</cbc:ID>", "<cbc:ID></cbc:ID>");
    expect(xml).not.toContain("PLACEHOLDER");
    const a = await submit(input, xml);
    expect([...a.errors, ...a.warnings].length, `the sandbox accepted an empty billing reference silently:\n      ${a.detail}`).toBeGreaterThan(0);
    expect(a.status).not.toBe("PASS");
  }, 120_000);

  it("recorded, not asserted — a 386 whose KSA-5 is LATER than its IssueDate: what the sandbox says about the supply-date field", async (ctx) => {
    if (!reachable) ctx.skip();
    const a = await submit(advanceInvoice({ uuid: "8a1d2c3e-4f50-4a6b-9c7d-0e1f2a3b4c9d", icv: 11, supplyDate: "2026-06-30" }));
    // eslint-disable-next-line no-console
    console.log(`[AP correction] 386 with KSA-5 (2026-06-30) AFTER IssueDate (2026-04-01): status ${a.status}, clearance ${a.clearanceStatus}, messages: ${a.detail || "none"}`);
    expect(a.httpStatus).toBeGreaterThanOrEqual(200);
  }, 120_000);
});

const describeDb = REAL_DB ? describe : describe.skip;
const SLUG = "ap-corr-live";
const EMAIL = "ap-corr-live@test.local";

describeDb("AP correction — the product's OWN rows at the LIVE sandbox", () => {
  let orgId = "", companyId = "", userId = 0, customerId = 0, bank = 0;
  let advId = 0, recId = 0;

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try { const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn)); await conn.commit(); return out; } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of ["invoice_prepayments", "payment_classifications", "customer_refunds", "payment_allocation_reversals", "payment_allocations", "payments", "journal_entry_lines", "journal_entries", "invoice_items", "einvoice_documents", "invoices", "customers", "period_locks", "audit_logs", "organization_memberships", "bank_accounts", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const loadFromLedger = (invoiceId: number) => inTenant(async () => {
    const [inv] = await invoicesRepository.findById(invoiceId);
    return loadEInvoiceInput(invoiceId, await invoicesRepository.zatcaPreviousInvoiceHash(inv!.companyId, invoiceId));
  });

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AP Corr Live','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, additional_number) VALUES ($1,'Al-Rashid Trading Est.','1010101010',$2,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId, SELLER_VAT])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','AP Corr Live',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, tax_number, cr_number, building_number, street, district, city, postal_code, additional_number, province, country) VALUES ($1,'Beta Logistics Co.','311987654321003','2020202020','4321','Prince Sultan Street','Al Rawdah','Jeddah','23456','9876','Makkah Region','SA') RETURNING id`, [orgId])).rows[0].id;
    bank = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
    // a January advance, its 386 issued today (KSA-5 = 30 Jan; IssueDate = today)
    const r = await inTenant(() => paymentsService.receive({ customerId, amount: 11_500, paidAt: "2026-01-30", bankAccountId: bank, classification: "advance", vatCategory: "S" }, userId));
    const advDraft = await inTenant(() => advanceInvoicesService.createFromReceipt(r.id, { amount: 11_500 }, userId));
    advId = (await inTenant(() => invoicesService.approve(advDraft.id, userId))).id;
    // a 2025 invoice, half paid, written off with relief in Jan 2026, 2,300 recovered on 10 Mar 2026
    const inv = await inTenant(() => createApproved<{ id: number }>(invoicesService, { invoiceNumber: "APCL-INV-1", date: "2025-01-10", dueDate: "2025-02-10", customerId, items: [{ description: "Consulting", quantity: 1, unitPrice: 10_000, vatRate: 15, taxCategoryCode: "S", unitCode: "PCE" }] }, userId));
    await inTenant(() => paymentsService.receive({ customerId, amount: 5_750, paidAt: "2025-02-01", bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 5_750 }] }, userId));
    await inTenant(() => badDebtService.writeOffWithRelief(inv.id, { claimedOn: "2026-01-20", certificateRef: "CA-2026-12" }, userId));
    const rcpt = await inTenant(() => paymentsService.receive({ customerId, amount: 2_300, paidAt: "2026-03-10", bankAccountId: bank, classification: "unknown" }, userId));
    const recDraft = await inTenant(() => badDebtService.createRecovery(inv.id, { paymentId: rcpt.id, amount: 2_300 }, userId));
    recId = (await inTenant(() => invoicesService.approve(recDraft.id, userId))).id;
  }, 240_000);
  afterAll(cleanup);

  it("🔴 the 386 from REAL ROWS — KSA-5 = 2026-01-30, IssueDate = today: PASS, no warnings, CLEARED", async (ctx) => {
    if (!reachable) ctx.skip();
    const input = await loadFromLedger(advId);
    expect(input.supplyDate).toBe("2026-01-30");
    expectAccepted("386 (real rows) with KSA-5 = the receipt date", await submit(input));
  }, 120_000);

  it("🔴 the Art. 40(9) recovery invoice from REAL ROWS — a 388, BillingReference = the written-off invoice, KSA-5 = 2026-03-10, IssueDate = today: PASS, no warnings, CLEARED", async (ctx) => {
    if (!reachable) ctx.skip();
    const input = await loadFromLedger(recId);
    expect(input.documentType).toBe("recovery_invoice");
    expect(input.billingReference).toEqual({ invoiceNumber: "APCL-INV-1" });
    expect(input.supplyDate).toBe("2026-03-10");
    expectAccepted("Art. 40(9) recovery invoice (real rows)", await submit(input));
  }, 120_000);
});
