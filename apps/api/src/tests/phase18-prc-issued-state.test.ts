/**
 * PHASE 18 · PR C (issued-invoice freeze) · PROOF-FIRST — EVIDENCE OF THE ISSUED STATE.
 * PROOF ONLY, NOT A FIX. Untracked; never merged. No product code is changed by this file.
 *
 * Owner §2.6 (binding): "The D-4 statement and tests must define exactly which recorded
 * state means 'issued' for each included invoice type … Do not guess the definition."
 *
 * This file does not define "issued". It RECORDS, from rows the product's own HTTP path
 * wrote (create → [submit] → approve), which columns each document type carries:
 *   - as a DRAFT and as a SUBMITTED document (before approval), and
 *   - after approval, for: 388 simplified, 388 standard, 381 credit note, 383 debit note,
 *     386 advance tax invoice, 388 that adjusts a 386, 381 credit note against a 386;
 *   - and, for a ZATCA-onboarded company, the einvoice_documents row queued at approval.
 * Plus two CONTROLS that any freeze must keep working (they pass today):
 *   - issuance itself writes invoices.qr_code AFTER the issuing update (the Phase-2 QR);
 *   - the product's payment path moves an issued invoice sent → paid.
 *
 * Onboarding is the established fixture (phase18-g08r-b-onboarded.test.ts): a sandbox
 * credential activated with a SELF-SIGNED certificate under the local-dev KMS. Stand-ins,
 * named: no real PCSID, no ZATCA call, the outbox worker is not running.
 *
 * DB-backed (sl_test); skips on the DB-free placeholder. Run through the pre-flight gate.
 */

process.env.PORT ??= "3181";
process.env.SESSION_SECRET ??= "phase18-prc-issued-state-proof-secret-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { signingService } from "../services/einvoice/signing/signing.service";
import type { ZatcaCsrInput } from "../services/einvoice/crypto/csr";
import { selfSignedCertificate } from "./helpers/selfSignedCert";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "PrcIssuedStatePw123!";
const VAT = "399999999991013";
const DATE = "2026-10-05";

/** Decode a base64 TLV QR into { tag: utf8 value } (tags 1–5 are text; 6–9 are reported by length only). */
function qrTags(b64: string | null): Record<number, string> {
  if (!b64) return {};
  const buf = Buffer.from(b64, "base64");
  const out: Record<number, string> = {};
  for (let i = 0; i + 2 <= buf.length; ) {
    const tag = buf[i];
    const len = buf[i + 1];
    const v = buf.subarray(i + 2, i + 2 + len);
    out[tag] = tag <= 5 ? v.toString("utf-8") : `<${len} bytes>`;
    i += 2 + len;
  }
  return out;
}

describeMaybe("PR C proof · the issued state per document type (evidence; expected to PASS)", () => {
  const h = g04Harness("prcst");
  let orgId = "";
  let companyId = "";
  let b2c = 0;
  let b2b = 0;
  let bank = 0;
  const table: Record<string, unknown>[] = [];

  async function purgeCredentials() {
    const comps = `(SELECT id FROM companies WHERE organization_id IN ${h.ORGS})`;
    await pool.query(`DELETE FROM zatca_credential_reminders WHERE company_id IN ${comps}`);
    await pool.query(`DELETE FROM zatca_credentials WHERE company_id IN ${comps}`);
  }

  /** The columns that bear on "issued", read straight from the row. */
  async function state(id: number) {
    const inv = (await pool.query(
      `SELECT id, document_type, status, is_opening,
              invoice_hash, previous_hash, icv, zatca_uuid, issued_at, qr_code,
              seller_name, seller_vat_number, issued_bank_account_id,
              total::text, vat_amount::text, paid_amount::text, credited_amount::text, date, invoice_number
         FROM invoices WHERE id = $1`, [id],
    )).rows[0];
    const doc = (await pool.query(
      `SELECT flow, status, invoice_hash, previous_invoice_hash, qr_code, zatca_uuid::text,
              (signed_xml IS NOT NULL) AS has_signed_xml, cleared_xml IS NOT NULL AS has_cleared_xml,
              substring(signed_xml from '<cbc:InvoiceTypeCode name="([0-9]+)"') AS type_name,
              substring(signed_xml from '<cbc:InvoiceTypeCode[^>]*>([0-9]+)<') AS type_code
         FROM einvoice_documents WHERE invoice_id = $1`, [id],
    )).rows[0] ?? null;
    const gl = (await pool.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgId, `GL-${inv?.invoice_number}`],
    )).rows[0].n;
    return { inv, doc, gl };
  }

  function summary(label: string, s: Awaited<ReturnType<typeof state>>) {
    const { inv, doc, gl } = s;
    return {
      type: label,
      document_type: inv.document_type,
      status: inv.status,
      invoice_hash: inv.invoice_hash ? `hex64:${/^[0-9a-f]{64}$/.test(inv.invoice_hash)}` : null,
      previous_hash: inv.previous_hash ? (inv.previous_hash === "GENESIS" ? "GENESIS" : "hex64") : null,
      icv: inv.icv,
      zatca_uuid: inv.zatca_uuid ? "set" : null,
      issued_at: inv.issued_at ? "set" : null,
      qr_tags: Object.keys(qrTags(inv.qr_code)).map(Number),
      seller: inv.seller_name ? `${inv.seller_name} / ${inv.seller_vat_number}` : null,
      bank_capture: inv.issued_bank_account_id,
      einvoice_document: doc ? { flow: doc.flow, status: doc.status, type: `${doc.type_code}/${doc.type_name}`, pih: doc.previous_invoice_hash ? "set" : null, qr_equals_invoice_qr: doc.qr_code === inv.qr_code, signed_xml: doc.has_signed_xml, cleared_xml: doc.has_cleared_xml } : null,
      gl_entries: gl,
      paid_amount: inv.paid_amount,
      credited_amount: inv.credited_amount,
    };
  }

  const create = async (body: Record<string, unknown>) => {
    const r = await h.api("bookkeeper", "POST", "/invoices", { date: DATE, ...body });
    expect(r.status, `create: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  };
  const approve = async (id: number) => {
    const r = await h.api("accountant", "POST", `/invoices/${id}/approve`, {});
    expect(r.status, `approve ${id}: ${JSON.stringify(r.body)}`).toBe(200);
  };
  const line = (unitPrice: number) => [{ description: "Professional services", quantity: 1, unitPrice, vatRate: 15 }];

  beforeAll(async () => {
    await purgeCredentials();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start,
                              building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'PRC State Onboarded Co','شركة','1010101010',$2,1,'1234','King Fahd Rd','Olaya','Riyadh','12345','1234') RETURNING id`, [orgId, VAT],
    )).rows[0].id;
    const csr: ZatcaCsrInput = {
      commonName: "SLP-EGS-PRCST", organizationName: "PRC State Onboarded Co", organizationalUnitName: "Riyadh Branch",
      countryName: "SA", invoiceType: "1100", locationAddress: "Riyadh", industryBusinessCategory: "Software",
      organizationIdentifier: VAT, egsSerialNumber: "1-SLP|2-PRCST|3-EGS001", production: false,
    };
    const { credentialId } = await signingService.createCredential({ companyId, environment: "sandbox", csr });
    const certificatePem = await signingService.withCredentialKey(credentialId, ({ privateKey, publicKey }) => selfSignedCertificate(privateKey, publicKey));
    await signingService.activateCredential({ credentialId, certificatePem, csidSecret: "csid-secret", notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2031-01-01T00:00:00Z") });
    b2c = (await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'PRC Walk-in Client','عميل') RETURNING id`, [orgId])).rows[0].id;
    b2b = (await pool.query(
      `INSERT INTO customers (organization_id, name, name_ar, tax_number, cr_number, building_number, street, district, city, postal_code, additional_number, country)
       VALUES ($1,'PRC Business Client','عميل تجاري','311111111111113','1010202020','4321','Olaya St','Al Olaya','Riyadh','12211','4321','SA') RETURNING id`, [orgId],
    )).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("accountant", PW, orgId, "accountant");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const b = await h.api("admin", "POST", "/bank-accounts", { name: "PRC Main", bankName: "Riyad Bank", iban: "SA0380000000608010167519", currency: "SAR", isDefault: true });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    bank = b.body.id;
  }, 120_000);

  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.warn("[PRC STATE] TABLE", JSON.stringify(table));
    await h.stop();
    await purgeCredentials();
    await h.cleanup();
  });

  it("DRAFT and SUBMITTED are not issued: no hash, ICV, UUID, issued_at, QR, seller or e-invoice document; status draft / submitted", async () => {
    const id = await create({ customerId: b2c, items: line(1_000) });
    const asDraft = await state(id);
    const sub = await h.api("bookkeeper", "POST", `/invoices/${id}/submit`, {});
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const asSubmitted = await state(id);
    table.push(summary("388 simplified — DRAFT", asDraft), summary("388 simplified — SUBMITTED", asSubmitted));
    for (const s of [asDraft, asSubmitted]) {
      expect([s.inv.invoice_hash, s.inv.previous_hash, s.inv.icv, s.inv.zatca_uuid, s.inv.issued_at, s.inv.qr_code, s.inv.seller_name, s.inv.seller_vat_number]).toEqual([null, null, null, null, null, null, null, null]);
      expect(s.doc).toBeNull();
      expect(s.gl).toBe(0);
    }
    expect([asDraft.inv.status, asSubmitted.inv.status]).toEqual(["draft", "submitted"]);
    await approve(id);
    const issued = await state(id);
    table.push(summary("388 simplified — after approve (from submitted)", issued));
    expect(issued.inv.status).toBe("sent");
    expect(issued.inv.invoice_hash).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("388 simplified, 388 standard, 381, 383: approval sets status sent + hash + previous hash + ICV + UUID + issued_at + QR + seller in one issuing write, and (onboarded) queues ONE signed document, status pending", async () => {
    const simplified = await create({ customerId: b2c, items: line(2_000) });
    await approve(simplified);
    const standard = await create({ customerId: b2b, items: line(3_000) });
    await approve(standard);
    const credit = await create({ customerId: b2c, documentType: "credit_note", originalInvoiceId: simplified, noteReason: "Price reduced after delivery", items: line(500) });
    await approve(credit);
    const debit = await create({ customerId: b2c, documentType: "debit_note", originalInvoiceId: simplified, noteReason: "Additional freight", items: line(300) });
    await approve(debit);
    const rows: Array<[string, number, string, string]> = [
      ["388 simplified", simplified, "388", "0200000"],
      ["388 standard", standard, "388", "0100000"],
      ["381 credit note", credit, "381", "0200000"],
      ["383 debit note", debit, "383", "0200000"],
    ];
    for (const [label, id, code, name] of rows) {
      const s = await state(id);
      table.push(summary(label, s));
      expect.soft(s.inv.status, label).toBe("sent");
      expect.soft(s.inv.invoice_hash, label).toMatch(/^[0-9a-f]{64}$/);
      expect.soft(s.inv.icv, label).not.toBeNull();
      expect.soft(s.inv.zatca_uuid, label).not.toBeNull();
      expect.soft(s.inv.issued_at, label).not.toBeNull();
      expect.soft(s.inv.seller_vat_number, label).toBe(VAT);
      expect.soft(s.doc?.status, `${label}: queued, never transmitted`).toBe("pending");
      expect.soft(s.doc?.flow, label).toBe(name === "0100000" ? "clearance" : "reporting");
      expect.soft(`${s.doc?.type_code}/${s.doc?.type_name}`, label).toBe(`${code}/${name}`);
      expect.soft(s.doc?.has_cleared_xml, `${label}: nothing was cleared`).toBe(false);
    }
    // Bank capture only on the 388 (G30): notes print none.
    expect.soft((await state(simplified)).inv.issued_bank_account_id).toBe(bank);
    expect.soft((await state(credit)).inv.issued_bank_account_id).toBeNull();
  }, 90_000);

  it("386 advance, 388 adjusting it, 381 against the 386: the same issuing write; the 388's paid_amount moves INSIDE issuance", async () => {
    const receipt = await h.api("admin", "POST", "/payments", { customerId: b2c, amount: 2_300, paidAt: DATE, bankAccountId: bank, classification: "advance", vatCategory: "S" });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    const adv = await h.api("admin", "POST", `/payments/${receipt.body.id}/advance-invoices`, { amount: 2_300 });
    expect(adv.status, JSON.stringify(adv.body)).toBe(201);
    await approve(adv.body.id);
    const final = await create({ customerId: b2c, items: line(4_000), prepayments: [{ advanceInvoiceId: adv.body.id, amount: 1_150 }] });
    await approve(final);
    const acn = await h.api("admin", "POST", `/invoices/${adv.body.id}/advance-credit-notes`, { amount: 1_150, reason: "Order reduced", date: DATE });
    expect(acn.status, JSON.stringify(acn.body)).toBe(201);
    await approve(acn.body.id);
    const rows: Array<[string, number, string]> = [
      ["386 advance tax invoice", adv.body.id, "386"],
      ["388 adjusting a 386", final, "388"],
      ["381 against a 386 (advance_credit_note)", acn.body.id, "381"],
    ];
    for (const [label, id, code] of rows) {
      const s = await state(id);
      table.push(summary(label, s));
      expect.soft(["sent", "paid"], label).toContain(s.inv.status);
      expect.soft(s.inv.invoice_hash, label).toMatch(/^[0-9a-f]{64}$/);
      expect.soft(s.inv.icv, label).not.toBeNull();
      expect.soft(s.doc?.type_code, label).toBe(code);
    }
    expect.soft(Number((await state(final)).inv.paid_amount), "issuance itself wrote paid_amount on the 388").toBe(1_150);
  }, 90_000);

  it("CONTROL (any freeze must keep this): issuance writes invoices.qr_code AFTER the issuing update — the stored QR is the Phase-2 (9-tag) QR from the signed document", async () => {
    const id = await create({ customerId: b2c, items: line(1_200) });
    await approve(id);
    const s = await state(id);
    const tags = Object.keys(qrTags(s.inv.qr_code)).map(Number);
    // eslint-disable-next-line no-console
    console.warn("[PRC STATE] QR overwrite", JSON.stringify({ tags, equalsDocQr: s.doc?.qr_code === s.inv.qr_code }));
    expect(tags).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(s.doc?.qr_code).toBe(s.inv.qr_code);
  }, 60_000);

  it("CONTROL (any freeze must keep this): the product's payment path settles an issued invoice — status sent → paid, paid_amount moves", async () => {
    const id = await create({ customerId: b2c, items: line(1_000) });
    await approve(id);
    const before = await state(id);
    const pay = await h.api("admin", "POST", "/payments", { customerId: b2c, amount: Number(before.inv.total), paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: id, amount: Number(before.inv.total) }] });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const after = await state(id);
    // eslint-disable-next-line no-console
    console.warn("[PRC STATE] payment", JSON.stringify({ before: [before.inv.status, before.inv.paid_amount], after: [after.inv.status, after.inv.paid_amount] }));
    expect([after.inv.status, after.inv.paid_amount]).toEqual(["paid", before.inv.total]);
    expect(after.inv.invoice_hash).toBe(before.inv.invoice_hash);
  }, 60_000);
});
