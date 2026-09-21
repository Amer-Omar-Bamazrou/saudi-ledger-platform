/**
 * AP-4 (2026-09-21) — ADVANCE PAYMENTS: THE COMPLIANCE VALIDATION PHASE.
 *
 * Nothing here adds a workflow. It asks ZATCA's LIVE sandbox — the top of the
 * trust order (LIVE API > SDK > PDF) — whether the documents AP-1/AP-2/AP-3
 * produce are accepted, and it asks in a way whose PASS means something:
 *
 *   1. THE INSTRUMENT IS VALIDATED BEFORE IT IS BELIEVED. The sandbox is an
 *      external validator, and "external validators check the weakest
 *      property they plausibly could" (CLAUDE.md §3). So beside every correct
 *      document this suite submits PLANTED-WRONG ones — one per prepayment
 *      rule of the XML Implementation Standard v1.2 (BR-KSA-73, 74, 75, 79,
 *      80) plus BR-KSA-56 on the note and BR-CO-16 as an arithmetic control —
 *      and asserts the sandbox NAMES each rule. Only then is a clean PASS on
 *      our documents evidence that the prepayment rules were checked.
 *      (Observed 2026-09-21: the sandbox reports these as WARNINGs and still
 *      clears the document — except BR-KSA-74, an ERROR / NOT_CLEARED — so the
 *      assertion is "no warnings", not merely "cleared".)
 *
 *   2. THE DOCUMENTS ARE THE PRODUCT'S OWN. The lifecycle (receipt →
 *      classification → 386 → 388 with the adjustment → 381 against the 386 →
 *      refund) is driven through the services, and every submitted XML is
 *      built from ROWS READ BACK OUT OF POSTGRES, the way issuance builds it
 *      (standing rule 2). The field matrix is asserted on those XMLs.
 *
 *   3. THE SHIPPED SDK IS RUN ON THE SAME REAL-ROW DOCUMENTS, so the
 *      divergence (§15 of the divergences log — its 2021 rule set rejects the
 *      386 code and has no prepayment rule) is measured on the artefacts that
 *      matter, not only on fixtures.
 *
 * What a green run ATTESTS: `POST /compliance/invoices` (sandbox) returned
 * `status: PASS`, no warnings, `clearanceStatus: CLEARED` (standard) or
 * `reportingStatus: REPORTED` (simplified) for each document. What it does NOT
 * attest: the production clearance/reporting endpoints (never called — CLAUDE.md
 * §2), PIH continuity (the compliance endpoint accepts a genesis PIH on every
 * document), simulation or production behaviour, or anything about the
 * ACCOUNTING — the sandbox reads a document's shape, not the ledger, and says
 * nothing about which period the advance's VAT belongs to (an open accountant
 * question, pack §16).
 *
 * Skips LOUDLY when the sandbox is unreachable or there is no database — a
 * green run without the live part proves much less, and says so.
 */
process.env.SESSION_SECRET ??= "ap4-live-test-session-secret-0123456789abcdef";
process.env.PORT ??= "3000";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { generateZatcaKeyPair } from "../services/einvoice/crypto/keys";
import { buildZatcaCsr } from "../services/einvoice/crypto/csr";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { assembleSignedInvoice } from "../services/einvoice/crypto/assembleSignedInvoice";
import { splitIssuedAt } from "../services/einvoice/issuedAt";
import { loadEInvoiceInput } from "../services/einvoice/einvoiceInput.loader";
import { invoicesRepository } from "../repositories/invoices.repository";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { advanceInvoicesService } from "../services/advanceInvoices.service";
import { SELLER, advanceCreditNote, advanceInvoice, finalInvoiceWithPrepayment, standardInvoice } from "../services/einvoice/__fixtures__/sampleInput";
import { createApproved } from "./helpers/createApproved";
import type { EInvoiceInput } from "../services/einvoice/types";

const BASE = process.env.ZATCA_SANDBOX_BASE ?? "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
const LIVE_DISABLED = process.env.ZATCA_LIVE_TESTS === "0";
const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
/** When set, every sandbox response body is written here verbatim — the record the decision pack quotes. */
const RECORD_OUT = process.env.AP4_RECORD_OUT;

// ── the sandbox ──────────────────────────────────────────────────────────

interface Message { type: string; code: string; category?: string; message: string; status?: string }
interface SandboxAnswer {
  httpStatus: number;
  validationResults: { status?: string; infoMessages?: Message[]; warningMessages?: Message[]; errorMessages?: Message[] };
  clearanceStatus: string | null;
  reportingStatus: string | null;
}

let certPem = "";
let auth = "";
let keyPair: ReturnType<typeof generateZatcaKeyPair>;
let reachable = false;
let skipReason = "";
const record: Record<string, SandboxAnswer> = {};

async function obtainComplianceCsid(sellerVat: string): Promise<void> {
  keyPair = generateZatcaKeyPair();
  const csrPem = buildZatcaCsr(
    {
      commonName: "SLP-EGS-AP4",
      organizationName: "Al-Rashid Trading Est.",
      organizationalUnitName: "Head Office",
      countryName: "SA",
      invoiceType: "1100",
      locationAddress: "Riyadh",
      industryBusinessCategory: "Trading",
      // MUST equal the seller VAT on every document submitted under it.
      organizationIdentifier: sellerVat,
      egsSerialNumber: "1-SLP|2-Platform|3-AP4",
      production: false,
    },
    keyPair.privateKey,
    keyPair.publicKey,
  );
  const res = await fetch(`${BASE}/compliance`, {
    method: "POST",
    // NOTE: the sandbox accepts ANY OTP. This value proves nothing.
    headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Version": "V2", OTP: "123456" },
    body: JSON.stringify({ csr: Buffer.from(csrPem, "utf8").toString("base64") }),
  });
  const body = (await res.json()) as Record<string, string>;
  if (res.status !== 200 || body.dispositionMessage !== "ISSUED") {
    throw new Error(`compliance CSID not issued: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  const inner = Buffer.from(body.binarySecurityToken, "base64").toString();
  certPem = `-----BEGIN CERTIFICATE-----\n${inner.replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  auth = "Basic " + Buffer.from(`${body.binarySecurityToken}:${body.secret}`).toString("base64");
}

/** Sign the given XML (already built — possibly deliberately mutated) and ask the sandbox. */
async function submitXml(label: string, input: EInvoiceInput, xml: string): Promise<SandboxAnswer> {
  const assembled = assembleSignedInvoice({
    xml,
    certificatePem: certPem,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    qr: {
      sellerName: input.seller.legalName,
      vatNumber: input.seller.vatNumber ?? SELLER.vatNumber,
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
  const body = (await res.json()) as Partial<SandboxAnswer>;
  const answer: SandboxAnswer = {
    httpStatus: res.status,
    validationResults: body.validationResults ?? {},
    clearanceStatus: body.clearanceStatus ?? null,
    reportingStatus: body.reportingStatus ?? null,
  };
  record[label] = answer;
  if (RECORD_OUT) writeFileSync(RECORD_OUT, JSON.stringify(record, null, 2));
  return answer;
}

const submit = (label: string, input: EInvoiceInput) => submitXml(label, input, buildInvoiceXml(input));

const codes = (a: SandboxAnswer) => ({
  errors: (a.validationResults.errorMessages ?? []).map((m) => m.code),
  warnings: (a.validationResults.warningMessages ?? []).map((m) => m.code),
});

/** A clean PASS — no errors AND no warnings — with the expected disposition. */
function expectAccepted(label: string, a: SandboxAnswer, subtype: "standard" | "simplified"): void {
  const { errors, warnings } = codes(a);
  const detail = [...(a.validationResults.errorMessages ?? []), ...(a.validationResults.warningMessages ?? [])].map((m) => `${m.type} ${m.code}: ${m.message}`).join("\n      ");
  expect(
    { label, status: a.validationResults.status, errors, warnings, clearanceStatus: a.clearanceStatus, reportingStatus: a.reportingStatus },
    `ZATCA did not cleanly accept the ${label}.\n      ${detail}\n      DIAGNOSE which divergence is wrong — do not adjust inputs until it passes.`,
  ).toEqual({
    label,
    status: "PASS",
    errors: [],
    warnings: [],
    clearanceStatus: subtype === "standard" ? "CLEARED" : null,
    reportingStatus: subtype === "simplified" ? "REPORTED" : null,
  });
}

// ── the XML matrix helper ─────────────────────────────────────────────────

type Node = { nodeName: string; childNodes: ArrayLike<Node>; textContent: string | null; getAttribute?(n: string): string | null };
function children(n: Node, name: string): Node[] {
  return Array.from(n.childNodes).filter((c) => c.nodeName === name);
}
/** `q(root, "cac:LegalMonetaryTotal/cbc:PrepaidAmount")` — the FIRST match at each step; `[n]` picks a sibling. */
function q(root: Node, path: string): Node | null {
  let cur: Node | null = root;
  for (const step of path.split("/")) {
    if (!cur) return null;
    const m = step.match(/^(.+?)(?:\[(\d+)\])?$/)!;
    const kids = children(cur, m[1]!);
    cur = kids[Number(m[2] ?? 0)] ?? null;
  }
  return cur;
}
const t = (root: Node, path: string) => q(root, path)?.textContent ?? null;
function parse(xml: string): Node {
  const doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as { documentElement: Node };
  return doc.documentElement;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — the sandbox's answer on the three shapes, and the planted negatives
// that prove it reads them (directly-constructed fixtures; no database).
// ═══════════════════════════════════════════════════════════════════════════

beforeAll(async () => {
  if (LIVE_DISABLED) {
    skipReason = "ZATCA_LIVE_TESTS=0";
    return;
  }
  try {
    await obtainComplianceCsid(SELLER.vatNumber);
    reachable = true;
  } catch (err) {
    skipReason = String(err);
  }
  if (!reachable) {
    console.warn(
      "\n" + "=".repeat(78) +
        "\n[AP-4] SKIPPING THE LIVE ZATCA CHECK OF THE ADVANCE-PAYMENT DOCUMENTS." +
        "\n       This is the ONLY authoritative validation of a 386, a 388 with a" +
        "\n       prepayment adjustment and a 381 against a 386 (the shipped SDK cannot" +
        "\n       validate a 386 — divergences log §15). A green run WITHOUT it attests" +
        "\n       NOTHING about them at ZATCA. Report AP-4 SANDBOX VALIDATION: BLOCKED." +
        `\n       Reason: ${skipReason}` +
        "\n" + "=".repeat(78) + "\n",
    );
  }
}, 120_000);

describe("AP-4 part 1 — the three advance-payment shapes at the LIVE sandbox", () => {
  const positives: [string, EInvoiceInput, "standard" | "simplified"][] = [
    ["386 advance tax invoice (standard)", advanceInvoice(), "standard"],
    ["388 final invoice with a prepayment adjustment line", finalInvoiceWithPrepayment(), "standard"],
    ["381 credit note against the 386", advanceCreditNote(), "standard"],
    // Not a product surface (B2C advances are out of scope — pack §3.3); recorded
    // because the sandbox's answer on the simplified subtype costs nothing.
    ["386 advance tax invoice (simplified — informational)", advanceInvoice({ subtype: "simplified", buyer: null, invoiceNumber: "ADV-S-0001", uuid: "8a1d2c3e-4f50-4a6b-9c7d-0e1f2a3b4c5e", icv: 4 }), "simplified"],
  ];
  for (const [label, input, subtype] of positives) {
    it(`🔴 ${label}: PASS, no warnings, ${subtype === "standard" ? "CLEARED" : "REPORTED"}`, async (ctx) => {
      // 🔴 SKIP, never silently pass: a bare `return` reports a gate as green with nothing run.
      if (!reachable) ctx.skip();
      expectAccepted(label, await submit(label, input), subtype);
    }, 120_000);
  }

  /**
   * 🔴 THE PLANTED NEGATIVES. Each is the correct document with ONE rule
   * broken. The sandbox must NAME that rule; if it ever stops doing so, the
   * positives above stop being evidence and this suite says so first.
   */
  const adj = finalInvoiceWithPrepayment().prepaymentAdjustments[0]!;
  const negatives: [string, string, EInvoiceInput, ((xml: string) => string)?][] = [
    ["BR-KSA-73", "PrepaidAmount given with NO adjustment line", finalInvoiceWithPrepayment({ icv: 11, prepaymentAdjustments: [] })],
    ["BR-KSA-74", "KSA-30 reads 388 instead of 386", finalInvoiceWithPrepayment({ icv: 12 }), (x) => x.replace("<cbc:DocumentTypeCode>386</cbc:DocumentTypeCode>", "<cbc:DocumentTypeCode>388</cbc:DocumentTypeCode>")],
    ["BR-KSA-75", "KSA-30 given but the KSA-31…34 subtotal removed", finalInvoiceWithPrepayment({ icv: 17 }), (x) => x.replace(/<cac:TaxSubtotal>\s*<cbc:TaxableAmount currencyID="SAR">10000\.00<\/cbc:TaxableAmount>[\s\S]*?<\/cac:TaxSubtotal>\s*(<\/cac:TaxTotal>\s*<cac:Item>\s*<cbc:Name>Prepayment adjustment)/, "$1")],
    ["BR-KSA-79", "KSA-32 ≠ KSA-31 × KSA-34 (10,000 × 15% given as 1,000; BT-113 kept consistent)", finalInvoiceWithPrepayment({ icv: 13, prepaidAmount: "11000.00", payableAmount: "23500.00", prepaymentAdjustments: [{ ...adj, taxAmount: "1000.00" }] })],
    ["BR-KSA-80", "PrepaidAmount 11,500 while the adjustment sums to 10,350", finalInvoiceWithPrepayment({ icv: 14, prepaymentAdjustments: [{ ...adj, taxableAmount: "9000.00", taxAmount: "1350.00" }] })],
    ["BR-KSA-56", "381 against the 386 with NO billing reference", advanceCreditNote({ icv: 15, billingReference: null })],
    ["BR-CO-16", "PayableAmount ≠ TaxInclusive − Prepaid (the arithmetic control)", finalInvoiceWithPrepayment({ icv: 16, payableAmount: "34500.00" })],
  ];
  for (const [rule, what, input, mutate] of negatives) {
    it(`🔴 planted negative — ${rule}: ${what} → the sandbox names ${rule}`, async (ctx) => {
      if (!reachable) ctx.skip();
      const raw = buildInvoiceXml(input);
      const xml = mutate ? mutate(raw) : raw;
      if (mutate) expect(xml, "the planted mutation must actually change the document").not.toBe(raw);
      const a = await submitXml(`planted ${rule}`, input, xml);
      const { errors, warnings } = codes(a);
      expect([...errors, ...warnings], `the sandbox did not flag ${rule} — the positives above are no longer evidence of it`).toContain(rule);
      expect(a.validationResults.status).not.toBe("PASS");
    }, 120_000);
  }

  it("🔴 the positives are not vacuous: the sandbox flagged every planted rule it was shown", (ctx) => {
    if (!reachable) ctx.skip();
    const flagged = Object.entries(record).filter(([k]) => k.startsWith("planted ")).map(([k, a]) => [k, [...codes(a).errors, ...codes(a).warnings]] as const);
    expect(flagged.length).toBe(negatives.length);
    for (const [k, c] of flagged) expect(c, k).toContain(k.replace("planted ", ""));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — the lifecycle from REAL ROWS: receipt → classification → 386 →
// 388 with the adjustment → 381 against the 386 → refund; every document
// read back out of Postgres, checked field by field, then sent to ZATCA.
// ═══════════════════════════════════════════════════════════════════════════

const describeDb = REAL_DB ? describe : describe.skip;
const SLUG = "ap4-live";
const EMAIL = "ap4-live@test.local";
const RECEIPT_DATE = "2026-06-15";
const LATER_DATE = "2026-07-10";
/**
 * Part 3 runs the SDK's JVM with `-Dfile.encoding=UTF-8`: on Windows, Java 17's
 * default charset is the ANSI code page, and the SDK's own `-sign` then rewrites
 * a document containing any non-ASCII text (the product's "Credit of advance —"
 * line, an Arabic name) into an XSD-INVALID file — a harness artefact, not a
 * document defect (the sandbox accepts the same bytes). Diagnosed here 2026-09-21;
 * pack §16.
 */
const SELLER_VAT = "310123456789013";

describeDb("AP-4 part 2 — the lifecycle from REAL ROWS, field by field and at the LIVE sandbox", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let bank = 0;
  // chain 1: a full adjustment · chain 2: a partial adjustment, then the note, then the refund
  let adv1 = 0, final1 = 0, adv2 = 0, final2 = 0, note2 = 0, receipt2 = 0;
  const xmlOf: Record<string, string> = {};
  const inputOf: Record<string, EInvoiceInput> = {};

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };

  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const tbl of [
        "invoice_prepayments", "payment_classifications", "customer_refunds", "payment_allocation_reversals", "payment_allocations", "payments",
        "journal_entry_lines", "journal_entries", "invoice_items", "einvoice_documents", "invoices", "customers", "period_locks", "audit_logs",
        "organization_memberships", "bank_accounts", "categories", "companies",
      ]) {
        await client.query(`DELETE FROM ${tbl} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  /** Resolve the chain head the way issuance does, then build the model — the production read, not a hardcoded genesis. */
  const loadFromLedger = (invoiceId: number) =>
    inTenant(async () => {
      const [inv] = await invoicesRepository.findById(invoiceId);
      const pih = await invoicesRepository.zatcaPreviousInvoiceHash(inv!.companyId, invoiceId);
      return loadEInvoiceInput(invoiceId, pih);
    });
  const row = async (id: number) =>
    (await pool.query(`SELECT invoice_number, document_type, status, icv, zatca_uuid, issued_at, invoice_hash, subtotal::text AS subtotal, vat_amount::text AS vat, total::text AS total, original_invoice_id, note_reason FROM invoices WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AP4 Live','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Al-Rashid Trading Est.','1010101010',$2,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId, SELLER_VAT])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','AP4 Live',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    // A VAT-registered buyer with a full national address => STANDARD documents (BR-KSA-10).
    customerId = (await pool.query(
      `INSERT INTO customers (organization_id, name, tax_number, cr_number, building_number, street, district, city, postal_code, additional_number, province, country)
       VALUES ($1,'Beta Logistics Co.','311987654321003','2020202020','4321','Prince Sultan Street','Al Rawdah','Jeddah','23456','9876','Makkah Region','SA') RETURNING id`, [orgId])).rows[0].id;
    bank = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;

    const receiveAdvance = (amount: number) =>
      inTenant(() => paymentsService.receive({ customerId, amount, paidAt: RECEIPT_DATE, bankAccountId: bank, classification: "advance", vatCategory: "S" }, userId));
    const issueAdvance = async (paymentId: number, amount: number) => {
      const draft = await inTenant(() => advanceInvoicesService.createFromReceipt(paymentId, { amount }, userId));
      return inTenant(() => invoicesService.approve(draft.id, userId));
    };
    const issueFinal = (number: string, net: number, prepayments: Array<{ advanceInvoiceId: number; amount?: number }>) =>
      inTenant(() => createApproved<{ id: number }>(invoicesService, { invoiceNumber: number, date: LATER_DATE, dueDate: LATER_DATE, customerId, items: [{ description: "Consulting project", quantity: 1, unitPrice: net, vatRate: 15, taxCategoryCode: "S", unitCode: "PCE" }], prepayments }, userId));

    // chain 1 — receipt 11,500 → 386 for all of it → 388 (30,000 + 4,500) adjusting the whole 386
    const r1 = await receiveAdvance(11_500);
    adv1 = (await issueAdvance(r1.id, 11_500)).id;
    final1 = (await issueFinal("AP4-INV-1", 30_000, [{ advanceInvoiceId: adv1 }])).id;
    // chain 2 — receipt 11,500 → 386 → 388 (20,000 + 3,000) adjusting 4,600 of it → 381 for the open 6,900 → refund 6,900
    const r2 = await receiveAdvance(11_500);
    receipt2 = r2.id;
    adv2 = (await issueAdvance(r2.id, 11_500)).id;
    final2 = (await issueFinal("AP4-INV-2", 20_000, [{ advanceInvoiceId: adv2, amount: 4_600 }])).id;
    const noteDraft = await inTenant(() => advanceInvoicesService.creditAdvance(adv2, { amount: 6_900, reason: "Order cancelled - advance returned", date: LATER_DATE }, userId));
    note2 = (await inTenant(() => invoicesService.approve(noteDraft.id, userId))).id;
    await inTenant(() => paymentsService.refund({ customerId, origin: "deposit", paymentId: receipt2, amount: 6_900, bankAccountId: bank, refundedAt: LATER_DATE, reason: "advance returned" }, userId));

    for (const [label, id] of [["386-1", adv1], ["388-1", final1], ["386-2", adv2], ["388-2", final2], ["381-2", note2]] as const) {
      inputOf[label] = await loadFromLedger(id);
      xmlOf[label] = buildInvoiceXml(inputOf[label]!);
    }
    // the live part needs a CSID whose organization identifier is THIS seller's VAT
    if (!LIVE_DISABLED && reachable && SELLER_VAT !== SELLER.vatNumber) await obtainComplianceCsid(SELLER_VAT);
  }, 240_000);
  afterAll(cleanup);

  it("the five documents are issued rows with ICV, UUID, issuance instant and hash — ICVs in issuance order, nothing reused", async () => {
    const rows = await Promise.all([adv1, final1, adv2, final2, note2].map(row));
    expect(rows.map((r) => r.document_type)).toEqual(["advance_invoice", "invoice", "advance_invoice", "invoice", "advance_credit_note"]);
    for (const r of rows) {
      expect(r.status, r.invoice_number).not.toBe("draft");
      expect(r.icv, r.invoice_number).not.toBeNull();
      expect(r.zatca_uuid, r.invoice_number).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.issued_at, r.invoice_number).toBeTruthy();
      expect(r.invoice_hash, r.invoice_number).toBeTruthy();
    }
    const icvs = rows.map((r) => Number(r.icv));
    expect(icvs).toEqual([...icvs].sort((a, b) => a - b));
    expect(new Set(icvs).size).toBe(5);
    expect(rows[4]!.original_invoice_id).toBe(adv2);
    expect(rows[4]!.note_reason).toBe("Order cancelled - advance returned");
  });

  it("🔴 the 386 (real rows): type 386 / subtype 01, UUID, number, issue date+time from issued_at, S 15%, 10,000 + 1,500 = 11,500, no prepayment fields, seller and buyer", async () => {
    const r = await row(adv1);
    const x = parse(xmlOf["386-1"]!);
    const [d, tm] = splitIssuedAt(new Date(r.issued_at));
    expect(t(x, "cbc:ID")).toBe(r.invoice_number);
    expect(t(x, "cbc:UUID")).toBe(r.zatca_uuid);
    expect(t(x, "cbc:IssueDate")).toBe(d);
    expect(t(x, "cbc:IssueTime")).toBe(tm);
    expect(t(x, "cbc:InvoiceTypeCode")).toBe("386");
    expect(q(x, "cbc:InvoiceTypeCode")!.getAttribute!("name")).toBe("0100000");
    expect(q(x, "cac:BillingReference")).toBeNull();
    expect(t(x, "cac:AccountingSupplierParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID")).toBe(SELLER_VAT);
    expect(t(x, "cac:AccountingSupplierParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName")).toBe("Al-Rashid Trading Est.");
    expect(t(x, "cac:AccountingCustomerParty/cac:Party/cac:PartyTaxScheme/cbc:CompanyID")).toBe("311987654321003");
    expect(t(x, "cac:AccountingCustomerParty/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName")).toBe("Beta Logistics Co.");
    expect(t(x, "cac:TaxTotal/cbc:TaxAmount")).toBe("1500.00");
    expect(t(x, "cac:TaxTotal[1]/cac:TaxSubtotal/cbc:TaxableAmount")).toBe("10000.00");
    expect(t(x, "cac:TaxTotal[1]/cac:TaxSubtotal/cbc:TaxAmount")).toBe("1500.00");
    expect(t(x, "cac:TaxTotal[1]/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")).toBe("S");
    expect(t(x, "cac:TaxTotal[1]/cac:TaxSubtotal/cac:TaxCategory/cbc:Percent")).toBe("15.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount")).toBe("10000.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount")).toBe("11500.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:PrepaidAmount")).toBe("0.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:PayableAmount")).toBe("11500.00");
    expect(children(x, "cac:InvoiceLine")).toHaveLength(1);
    expect(xmlOf["386-1"]).not.toContain("Prepayment adjustment");
    // the stored row and the document agree
    expect([r.subtotal, r.vat, r.total]).toEqual(["10000.00", "1500.00", "11500.00"]);
  });

  it("🔴 the 388 with a FULL adjustment (real rows): supply 30,000 + 4,500; KSA-26/28/29/30 name the 386 by number, UUID, issue date and time, 386; KSA-31 10,000 · KSA-32 1,500 · KSA-33 S · KSA-34 15.00; PrepaidAmount 11,500; PayableAmount 23,000; the tax totals declare the FULL supply", async () => {
    const adv = await row(adv1);
    const r = await row(final1);
    const x = parse(xmlOf["388-1"]!);
    const [d, tm] = splitIssuedAt(new Date(adv.issued_at));
    expect(t(x, "cbc:ID")).toBe("AP4-INV-1");
    expect(t(x, "cbc:UUID")).toBe(r.zatca_uuid);
    expect(t(x, "cbc:InvoiceTypeCode")).toBe("388");
    expect(q(x, "cbc:InvoiceTypeCode")!.getAttribute!("name")).toBe("0100000");
    expect(q(x, "cac:BillingReference")).toBeNull();
    // the tax totals: the full supply (the advance's VAT is deducted by the adjustment line, not by understating the supply)
    expect(t(x, "cac:TaxTotal/cbc:TaxAmount")).toBe("4500.00");
    expect(t(x, "cac:TaxTotal[1]/cac:TaxSubtotal/cbc:TaxableAmount")).toBe("30000.00");
    expect(t(x, "cac:TaxTotal[1]/cac:TaxSubtotal/cbc:TaxAmount")).toBe("4500.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:LineExtensionAmount")).toBe("30000.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount")).toBe("30000.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount")).toBe("34500.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:PrepaidAmount")).toBe("11500.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:PayableAmount")).toBe("23000.00");
    const lines = children(x, "cac:InvoiceLine");
    expect(lines).toHaveLength(2);
    // the supply line
    expect(t(lines[0]!, "cbc:LineExtensionAmount")).toBe("30000.00");
    expect(t(lines[0]!, "cac:TaxTotal/cbc:TaxAmount")).toBe("4500.00");
    // the prepayment adjustment line (XML Standard 9.5): principal values ZERO, the reference, the KSA-31..34 subtotal
    const adjLine = lines[1]!;
    expect(t(adjLine, "cbc:ID")).toBe("2");
    expect(t(adjLine, "cbc:InvoicedQuantity")).toBe("0.00");
    expect(t(adjLine, "cbc:LineExtensionAmount")).toBe("0.00");
    expect(t(adjLine, "cac:DocumentReference/cbc:ID")).toBe(adv.invoice_number); // KSA-26
    expect(t(adjLine, "cac:DocumentReference/cbc:UUID")).toBe(adv.zatca_uuid); // KSA-1 of the 386
    expect(t(adjLine, "cac:DocumentReference/cbc:IssueDate")).toBe(d); // KSA-28
    expect(t(adjLine, "cac:DocumentReference/cbc:IssueTime")).toBe(tm); // KSA-29
    expect(t(adjLine, "cac:DocumentReference/cbc:DocumentTypeCode")).toBe("386"); // KSA-30
    expect(t(adjLine, "cac:TaxTotal/cbc:TaxAmount")).toBe("0.00");
    expect(t(adjLine, "cac:TaxTotal/cbc:RoundingAmount")).toBe("0.00");
    expect(t(adjLine, "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")).toBe("10000.00"); // KSA-31
    expect(t(adjLine, "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount")).toBe("1500.00"); // KSA-32
    expect(t(adjLine, "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")).toBe("S"); // KSA-33
    expect(t(adjLine, "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:Percent")).toBe("15.00"); // KSA-34
    expect(t(adjLine, "cac:Price/cbc:PriceAmount")).toBe("0.00");
    // the arithmetic the sandbox enforces (BR-KSA-79, BR-KSA-80, BR-CO-16), computed here from the document itself
    const ksa31 = Number(t(adjLine, "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount"));
    const ksa32 = Number(t(adjLine, "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount"));
    const ksa34 = Number(t(adjLine, "cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:Percent"));
    expect(ksa32).toBe(Math.round(ksa31 * ksa34) / 100);
    expect(Number(t(x, "cac:LegalMonetaryTotal/cbc:PrepaidAmount"))).toBe(ksa31 + ksa32);
    expect(Number(t(x, "cac:LegalMonetaryTotal/cbc:PayableAmount"))).toBe(Number(t(x, "cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount")) - Number(t(x, "cac:LegalMonetaryTotal/cbc:PrepaidAmount")));
  });

  it("🔴 the 388 with a PARTIAL adjustment (real rows): 4,600 of the 386 → KSA-31 4,000 · KSA-32 600; PrepaidAmount 4,600; PayableAmount 18,400; the 386 keeps 6,900 open", async () => {
    const adv = await row(adv2);
    const x = parse(xmlOf["388-2"]!);
    expect(t(x, "cbc:InvoiceTypeCode")).toBe("388");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount")).toBe("23000.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:PrepaidAmount")).toBe("4600.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:PayableAmount")).toBe("18400.00");
    const adjLine = children(x, "cac:InvoiceLine")[1]!;
    expect(t(adjLine, "cac:DocumentReference/cbc:ID")).toBe(adv.invoice_number);
    expect(t(adjLine, "cac:DocumentReference/cbc:DocumentTypeCode")).toBe("386");
    expect(t(adjLine, "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxableAmount")).toBe("4000.00");
    expect(t(adjLine, "cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount")).toBe("600.00");
    const open = (await pool.query(`SELECT (i.total - coalesce((SELECT sum(x.amount) FROM invoice_prepayments x WHERE x.advance_invoice_id = i.id AND x.allocation_id IS NOT NULL), 0)
                                             - coalesce((SELECT sum(n.total) FROM invoices n WHERE n.original_invoice_id = i.id AND n.document_type = 'advance_credit_note' AND n.invoice_hash IS NOT NULL), 0))::text AS open
                                       FROM invoices i WHERE i.id = $1`, [adv2])).rows[0].open;
    // 11,500 − 4,600 adjusted − 6,900 credited (the note in beforeAll) = 0 — and 6,900 was what the note could take
    expect(open).toBe("0.00");
  });

  it("🔴 the 381 against the 386 (real rows): type 381 / subtype 01, BillingReference = the 386's NUMBER (BR-KSA-56), InstructionNote (BR-KSA-17), 6,000 + 900 = 6,900, no prepayment fields", async () => {
    const adv = await row(adv2);
    const r = await row(note2);
    const x = parse(xmlOf["381-2"]!);
    const [d, tm] = splitIssuedAt(new Date(r.issued_at));
    expect(t(x, "cbc:ID")).toBe(r.invoice_number);
    expect(t(x, "cbc:UUID")).toBe(r.zatca_uuid);
    expect(t(x, "cbc:IssueDate")).toBe(d);
    expect(t(x, "cbc:IssueTime")).toBe(tm);
    expect(t(x, "cbc:InvoiceTypeCode")).toBe("381");
    expect(q(x, "cbc:InvoiceTypeCode")!.getAttribute!("name")).toBe("0100000");
    expect(t(x, "cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID")).toBe(adv.invoice_number);
    expect(t(x, "cac:PaymentMeans/cbc:InstructionNote")).toBe("Order cancelled - advance returned");
    expect(t(x, "cac:TaxTotal/cbc:TaxAmount")).toBe("900.00");
    expect(t(x, "cac:TaxTotal[1]/cac:TaxSubtotal/cbc:TaxableAmount")).toBe("6000.00");
    expect(t(x, "cac:TaxTotal[1]/cac:TaxSubtotal/cac:TaxCategory/cbc:ID")).toBe("S");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount")).toBe("6900.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:PrepaidAmount")).toBe("0.00");
    expect(t(x, "cac:LegalMonetaryTotal/cbc:PayableAmount")).toBe("6900.00");
    expect(children(x, "cac:InvoiceLine")).toHaveLength(1);
    expect(xmlOf["381-2"]).not.toContain("Prepayment adjustment");
    expect([r.subtotal, r.vat, r.total]).toEqual(["6000.00", "900.00", "6900.00"]);
  });

  for (const label of ["386-1", "388-1", "386-2", "388-2", "381-2"] as const) {
    it(`🔴 LIVE: the ${label} built from REAL ROWS is accepted by ZATCA — PASS, no warnings, CLEARED`, async (ctx) => {
      if (!reachable) ctx.skip();
      expectAccepted(`${label} (real rows)`, await submitXml(`${label} (real rows)`, inputOf[label]!, xmlOf[label]!), "standard");
    }, 120_000);
  }

  it("🔴 the accounting is the AS-BUILT shape (pack §14/§15), unchanged by AP-4: the receipt's Batch 1B entry gross, the 386's SEPARATE entry Dr deposits / Cr VAT, E3 on the 388, E5 on the note, the refund", async () => {
    const entries = (await pool.query(
      `SELECT e.entry_number, e.date::text AS date, json_agg(json_build_array(c.system_code, l.debit_amount::text, l.credit_amount::text) ORDER BY l.id) AS lines
         FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND e.status IN ('posted','reversed') GROUP BY e.id ORDER BY e.id`, [orgId])).rows as Array<{ entry_number: string; date: string; lines: [string, string, string][] }>;
    const by = (prefix: string) => entries.filter((e) => e.entry_number.startsWith(prefix));
    const adv1Row = await row(adv1);
    const adv2Row = await row(adv2);
    const noteRow = await row(note2);
    // E1 — the receipt: Dr Bank / Cr Customer deposits, GROSS, dated the receipt (Batch 1B, unchanged)
    const receipts = by("RCPT-");
    expect(receipts).toHaveLength(2);
    for (const r of receipts) {
      expect(r.date).toBe(RECEIPT_DATE);
      expect(r.lines.map(([code, d, c]) => [code === "CUSTOMER_DEPOSITS" ? code : "BANK", d, c])).toEqual([["BANK", "11500.00", "0.00"], ["CUSTOMER_DEPOSITS", "0.00", "11500.00"]]);
    }
    // E2 — the 386: a SEPARATE entry (its own number, the 386's date), Dr Customer deposits 1,500 / Cr VAT Payable 1,500 — the split the accountant is still considering (pack §16)
    for (const a of [adv1Row, adv2Row]) {
      const [e] = by(`GL-${a.invoice_number}`);
      expect(e, `E2 for ${a.invoice_number}`).toBeTruthy();
      expect(e!.lines).toEqual([["CUSTOMER_DEPOSITS", "1500.00", "0.00"], ["VAT_OUTPUT", "0.00", "1500.00"]]);
    }
    // E3 — the 388s: Dr AR (due) · Dr deposits (net advance) / Cr Sales (full) · Cr VAT (full − advance VAT)
    const [e3full] = by("GL-AP4-INV-1");
    expect(e3full!.lines).toEqual([["AR", "23000.00", "0.00"], ["CUSTOMER_DEPOSITS", "10000.00", "0.00"], ["SALES", "0.00", "30000.00"], ["VAT_OUTPUT", "0.00", "3000.00"]]);
    const [e3part] = by("GL-AP4-INV-2");
    expect(e3part!.lines).toEqual([["AR", "18400.00", "0.00"], ["CUSTOMER_DEPOSITS", "4000.00", "0.00"], ["SALES", "0.00", "20000.00"], ["VAT_OUTPUT", "0.00", "2400.00"]]);
    // E5 — the note: Dr VAT Payable / Cr Customer deposits for the credited VAT, dated the note
    const [e5] = by(`GL-${noteRow.invoice_number}`);
    expect(e5!.date).toBe(LATER_DATE);
    expect(e5!.lines).toEqual([["VAT_OUTPUT", "900.00", "0.00"], ["CUSTOMER_DEPOSITS", "0.00", "900.00"]]);
    // the refund — Batch 1B's own entry: Dr Customer deposits / Cr Bank
    const refunds = by("REFUND-");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.lines.map(([code, d, c]) => [code === "CUSTOMER_DEPOSITS" ? code : "BANK", d, c])).toEqual([["CUSTOMER_DEPOSITS", "6900.00", "0.00"], ["BANK", "0.00", "6900.00"]]);
    // every entry balances
    for (const e of entries) {
      const dr = e.lines.reduce((s, [, d]) => s + Number(d), 0);
      const cr = e.lines.reduce((s, [, , c]) => s + Number(c), 0);
      expect(dr, e.entry_number).toBeCloseTo(cr, 2);
    }
  });

  it("Z1 stays shut: a migrated opening deposit gets no 386 here (and so no note, no unlocked refund)", async () => {
    const opening = await pool.query(
      `INSERT INTO payments (organization_id, company_id, direction, party_type, customer_id, bank_account_id, amount, paid_at, source, journal_entry_id)
       SELECT $1, $2, 'in', 'customer', $3, $4, 3000, '2026-01-01', 'opening', (SELECT id FROM journal_entries WHERE organization_id = $1 ORDER BY id LIMIT 1) RETURNING id`,
      [orgId, companyId, customerId, bank]);
    let err: any;
    try { await inTenant(() => advanceInvoicesService.createFromReceipt(opening.rows[0].id, { amount: 3000 }, userId)); } catch (e) { err = e; }
    expect(err?.statusCode ?? err?.status).toBe(409);
    expect(err?.payload?.code ?? err?.body?.code ?? err?.code).toBe("opening_deposit_not_advance_invoiced");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // PART 3 — the SHIPPED SDK on the same real-row documents: the divergence
  // measured on the artefacts that matter (skips loudly without Java/the SDK).
  // ═════════════════════════════════════════════════════════════════════════
  const SDK_ROOT = resolve(__dirname, "../../../../docs/zatca/sdk/extracted/zatca-envoice-sdk-203");
  const JAR = join(SDK_ROOT, "Apps", "cli-3.0.8-jar-with-dependencies.jar");
  const CONFIG = join(SDK_ROOT, "Configuration", "config.json");
  const hasJava = () => { try { execFileSync("java", ["-version"], { stdio: "pipe" }); return true; } catch { return false; } };
  const CAN_SDK = existsSync(JAR) && hasJava();
  if (!CAN_SDK) console.warn("\n[AP-4] the shipped SDK was NOT run on the real-row documents (Java or the SDK is missing) — part 3 skipped.\n");

  function runSdk(args: string[]): string {
    try {
      return execFileSync("java", ["-Dfile.encoding=UTF-8", "-jar", JAR, "--globalVersion", "3.0.8", "-certpassword", "123456789", ...args], { env: { ...process.env, SDK_CONFIG: CONFIG }, encoding: "utf8", stdio: "pipe", cwd: join(SDK_ROOT, "Apps") });
    } catch (err: any) {
      const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      if (!out) throw err;
      return out;
    }
  }
  function sdkValidate(name: string, xml: string) {
    const defaults = JSON.parse(readFileSync(join(SDK_ROOT, "Configuration", "defaults.json"), "utf8"));
    writeFileSync(CONFIG, JSON.stringify(Object.fromEntries(Object.entries(defaults).map(([k, v]) => (typeof v === "string" && v.startsWith("../") ? [k, join(SDK_ROOT, v.slice(3))] : [k, v]))), null, 2));
    const dir = mkdtempSync(join(tmpdir(), "ap4-sdk-"));
    const unsigned = join(dir, `${name}.xml`);
    const signed = join(dir, `${name}-signed.xml`);
    writeFileSync(unsigned, xml);
    expect(runSdk(["-sign", "-invoice", unsigned, "-signedInvoice", signed])).toContain("signed successfully");
    const out = runSdk(["-validate", "-invoice", signed]);
    const stages: Record<string, string> = {};
    const errors: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      const st = line.match(/\[(XSD|EN|KSA|QR|SIGNATURE)\] validation result : (\w+)/);
      if (st) stages[st[1]!.toLowerCase()] = st[2]!;
      const e = line.match(/CODE : ([^,]+), MESSAGE : (.*)$/);
      if (e) errors.push(e[1]!.trim());
    }
    return { stages, errors };
  }
  const describeSdk = CAN_SDK ? describe : describe.skip;
  describeSdk("AP-4 part 3 — the shipped SDK (2021 rules) on the real-row documents", () => {
    it("the 386 from real rows: XSD and EN 16931 PASS; the ONLY error is BR-KSA-05 (the 2021 code list) — the pinned divergence, measured on the artefact", () => {
      const r = sdkValidate("ap4-386", xmlOf["386-1"]!);
      expect(r.stages.xsd).toBe("PASSED");
      expect(r.stages.en).toBe("PASSED");
      expect(r.errors).toEqual(["BR-KSA-05"]);
    }, 180_000);
    it("the 388 with the adjustment from real rows: XSD, EN 16931 and the shipped BR-KSA rules PASS (the shipped set has no prepayment rule — the live sandbox, part 1/2, has)", () => {
      const r = sdkValidate("ap4-388", xmlOf["388-1"]!);
      expect(r.errors).toEqual([]);
      expect([r.stages.xsd, r.stages.en, r.stages.ksa]).toEqual(["PASSED", "PASSED", "PASSED"]);
    }, 180_000);
    it("the 381 against the 386 from real rows: XSD, EN 16931 and the shipped BR-KSA rules PASS", () => {
      const r = sdkValidate("ap4-381", xmlOf["381-2"]!);
      expect(r.errors).toEqual([]);
      expect([r.stages.xsd, r.stages.en, r.stages.ksa]).toEqual(["PASSED", "PASSED", "PASSED"]);
    }, 180_000);
  });
});
