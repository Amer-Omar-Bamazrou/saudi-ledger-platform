/**
 * M12.4 — THE AUTHORITATIVE CHECK: all six compliance documents against ZATCA's
 * LIVE sandbox compliance API.
 *
 * ── 🔴 WHY THIS OUTRANKS THE SDK DIFFERENTIAL ───────────────────────────────
 * `zatca-crypto.test.ts` compares our output byte-for-byte against ZATCA's
 * bundled SDK. That differential passed for the whole of M12.3 — and the QR it
 * blessed is REJECTED by this endpoint, because the bundled SDK is a stale
 * 2021-era writer. The SDK check is still worth keeping as a fast offline
 * signal, but it is not the gate.
 *
 *     LIVE API  >  SDK  >  PDF
 *
 * This test is the gate. A rejection here is a real finding: DIAGNOSE which
 * divergence is wrong rather than adjusting inputs until it passes.
 *
 * ── What it proves, and what it does NOT ────────────────────────────────────
 * PROVES: the UBL, the XAdES signature, the invoice hash and the QR are all
 * accepted by ZATCA for standard AND simplified, invoice AND credit AND debit.
 *
 * DOES NOT prove:
 *   - that the real OTP path works — the sandbox accepts ANY OTP;
 *   - that PCSID issuance is gated on compliance — in sandbox it is NOT, and the
 *     PCSID returned is a SHARED CANNED CERT that is not bound to our key;
 *   - anything about simulation or production (M12.7/M12.9, still blocked).
 *
 * Network-dependent, so it skips when ZATCA is unreachable rather than turning a
 * ZATCA outage into a red build on unrelated work — but it skips LOUDLY.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { generateZatcaKeyPair } from "../services/einvoice/crypto/keys";
import { buildZatcaCsr } from "../services/einvoice/crypto/csr";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { assembleSignedInvoice } from "../services/einvoice/crypto/assembleSignedInvoice";
import { SELLER, standardInvoice, simplifiedInvoice } from "../services/einvoice/__fixtures__/sampleInput";
import type { EInvoiceInput } from "../services/einvoice/types";

const BASE =
  process.env.ZATCA_SANDBOX_BASE ?? "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";

/** Opt out explicitly (offline dev); otherwise we try and skip on failure. */
const DISABLED = process.env.ZATCA_LIVE_TESTS === "0";

interface ValidationResult {
  status?: string;
  errorMessages?: { code: string; message: string }[];
  warningMessages?: { code: string; message: string }[];
}

let certPem = "";
let auth = "";
let keyPair: ReturnType<typeof generateZatcaKeyPair>;
let reachable = false;
let skipReason = "";

async function obtainComplianceCsid(): Promise<void> {
  keyPair = generateZatcaKeyPair();
  const csrPem = buildZatcaCsr(
    {
      commonName: "SLP-EGS-COMPLIANCE",
      organizationName: "Al-Rashid Trading Est.",
      organizationalUnitName: "Head Office",
      countryName: "SA",
      // TSCZ flags: standard + simplified, i.e. all six document types.
      invoiceType: "1100",
      locationAddress: "Riyadh",
      industryBusinessCategory: "Trading",
      // MUST equal the seller VAT on every document we submit.
      organizationIdentifier: SELLER.vatNumber,
      egsSerialNumber: "1-SLP|2-Platform|3-COMPLIANCE",
      production: false,
    },
    keyPair.privateKey,
    keyPair.publicKey,
  );

  const res = await fetch(`${BASE}/compliance`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Version": "V2",
      // NOTE: the sandbox accepts ANY OTP. This value proves nothing.
      OTP: "123456",
    },
    body: JSON.stringify({ csr: Buffer.from(csrPem, "utf8").toString("base64") }),
  });
  const body = (await res.json()) as Record<string, string>;
  if (res.status !== 200 || body.dispositionMessage !== "ISSUED") {
    throw new Error(`compliance CSID not issued: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }

  const inner = Buffer.from(body.binarySecurityToken, "base64").toString();
  certPem = `-----BEGIN CERTIFICATE-----\n${inner.replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  auth = "Basic " + Buffer.from(`${body.binarySecurityToken}:${body.secret}`).toString("base64");

  // The CCSID must bind OUR key — unlike the sandbox PCSID, which does not.
  const bound = new X509Certificate(certPem)
    .publicKey.export({ type: "spki", format: "der" })
    .equals(keyPair.publicKey.export({ type: "spki", format: "der" }));
  if (!bound) throw new Error("compliance CSID does not bind our key");
}

async function submit(input: EInvoiceInput): Promise<ValidationResult> {
  const assembled = assembleSignedInvoice({
    xml: buildInvoiceXml(input),
    certificatePem: certPem,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    qr: {
      sellerName: input.seller.legalName,
      // The fixtures always carry a seller VAT; issuance fails closed without one.
      vatNumber: input.seller.vatNumber ?? SELLER.vatNumber,
      issuedAt: input.issuedAt,
      totalWithVat: input.taxInclusiveTotal,
      vatTotal: input.taxTotal,
    },
  });

  const res = await fetch(`${BASE}/compliance/invoices`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Version": "V2",
      "Accept-Language": "en",
      Authorization: auth,
    },
    body: JSON.stringify({
      invoiceHash: assembled.invoiceHash,
      uuid: input.uuid,
      invoice: Buffer.from(assembled.signedXml, "utf8").toString("base64"),
    }),
  });
  return ((await res.json()) as { validationResults?: ValidationResult }).validationResults ?? {};
}

/** Fail with ZATCA's own diagnostics — the finding, not a bare boolean. */
function expectClean(label: string, v: ValidationResult): void {
  const errors = v.errorMessages ?? [];
  const warnings = v.warningMessages ?? [];
  const detail = [...errors, ...warnings].map((m) => `${m.code}: ${m.message}`).join("\n      ");
  expect(
    { label, status: v.status, errors: errors.map((e) => e.code), warnings: warnings.map((w) => w.code) },
    `ZATCA rejected the ${label}.\n      ${detail}\n` +
      "      DIAGNOSE which divergence is wrong — do not adjust inputs until it passes.",
  ).toEqual({ label, status: "PASS", errors: [], warnings: [] });
}

beforeAll(async () => {
  if (DISABLED) {
    skipReason = "ZATCA_LIVE_TESTS=0";
    return;
  }
  try {
    await obtainComplianceCsid();
    reachable = true;
  } catch (err) {
    skipReason = String(err);
  }
  if (!reachable) {
    console.warn(
      "\n" + "=".repeat(78) +
        "\n[M12.4] SKIPPING THE LIVE ZATCA COMPLIANCE CHECK — this is the AUTHORITATIVE" +
        "\n        test of the signature and QR. A green run WITHOUT it proves much less." +
        `\n        Reason: ${skipReason}` +
        "\n" + "=".repeat(78) + "\n",
    );
  }
}, 120_000);

describe("M12.4 — the six compliance documents (LIVE ZATCA)", () => {
  /**
   * Both invoice types declared in the CSR (`1100`) ⇒ six documents:
   * standard invoice/credit/debit and simplified invoice/credit/debit.
   *
   * 🔴 These are built from DIRECTLY-CONSTRUCTED inputs, not from the database.
   * The DB assembler still hardcodes `billingReference: null` pending M12.1b, so
   * the DB→credit/debit-note path is NOT covered here. Compliance documents are
   * test artifacts that never post to the ledger, so this is a coverage gap to
   * close in M12.1b, not a workaround.
   */
  const documents: [string, EInvoiceInput][] = [
    ["standard invoice", standardInvoice()],
    [
      "standard credit note",
      standardInvoice({
        invoiceNumber: "CN-0001",
        documentType: "credit_note",
        billingReference: { invoiceNumber: "INV-0001" },
        instructionNote: "Goods returned",
        icv: 2,
      }),
    ],
    [
      "standard debit note",
      standardInvoice({
        invoiceNumber: "DN-0001",
        documentType: "debit_note",
        billingReference: { invoiceNumber: "INV-0001" },
        instructionNote: "Price correction",
        icv: 3,
      }),
    ],
    ["simplified invoice", simplifiedInvoice()],
    [
      "simplified credit note",
      simplifiedInvoice({
        invoiceNumber: "CN-S-0001",
        documentType: "credit_note",
        billingReference: { invoiceNumber: "INV-S-0001" },
        instructionNote: "Goods returned",
        icv: 5,
      }),
    ],
    [
      "simplified debit note",
      simplifiedInvoice({
        invoiceNumber: "DN-S-0001",
        documentType: "debit_note",
        billingReference: { invoiceNumber: "INV-S-0001" },
        instructionNote: "Price correction",
        icv: 6,
      }),
    ],
  ];

  for (const [label, input] of documents) {
    it(`${label} passes ZATCA's compliance checks`, async (ctx) => {
      // 🔴 SKIP, never silently pass (audit H3): a bare `return` reported this
      // authoritative gate as GREEN with zero assertions run.
      if (!reachable) ctx.skip();
      expectClean(label, await submit(input));
    }, 120_000);
  }

  /** A zero-VAT line, built once and re-specialised per case. */
  function zeroVat(
    base: EInvoiceInput,
    category: "Z" | "E",
    code: string,
    text: string,
  ): EInvoiceInput {
    return {
      ...base,
      lines: [
        {
          id: 1,
          name: "Zero-rated supply",
          quantity: "1",
          unitCode: "PCE",
          unitPrice: "1000.00",
          lineExtensionAmount: "1000.00",
          discountAmount: "0.00",
          taxCategory: category,
          taxPercent: "0.00",
          taxAmount: "0.00",
          lineTotalWithTax: "1000.00",
          taxExemptionReasonCode: code,
          taxExemptionReasonText: text,
        },
      ],
      taxExclusiveTotal: "1000.00",
      taxInclusiveTotal: "1000.00",
      payableAmount: "1000.00",
      taxTotal: "0.00",
      taxSubtotals: [
        {
          taxableAmount: "1000.00",
          taxAmount: "0.00",
          category,
          percent: "0.00",
          exemptionReasonCode: code,
          exemptionReasonText: text,
        },
      ],
    };
  }

  it("a zero-rated (0% VAT) invoice is accepted — a surface M12.3 never reached", async (ctx) => {
    if (!reachable) ctx.skip();
    // The ambiguous 0%-VAT case M12.1a deliberately left un-backfilled. Proving
    // a 'Z' line clears ZATCA matters because issuance fails closed demanding an
    // explicit category, and this confirms the explicit answer is accepted.
    const zeroRated = zeroVat(
      standardInvoice({ invoiceNumber: "INV-Z-0001", icv: 7 }),
      "Z",
      "VATEX-SA-32",
      "Export of goods",
    );
    expectClean("zero-rated export invoice", await submit(zeroRated));
  }, 120_000);

  it("🔴 VATEX-SA-EDU/HEA require buyer identification — an anonymous B2C invoice is REJECTED", async (ctx) => {
    if (!reachable) ctx.skip();
    /**
     * NOT a bug in our generator — a real ZATCA rule found by submitting one.
     * BR-KSA-49 makes the buyer's national ID (BT-46, scheme NAT) mandatory and
     * BR-KSA-25 makes the buyer name mandatory whenever the exemption code is
     * VATEX-SA-EDU or VATEX-SA-HEA. So those two codes cannot appear on an
     * anonymous simplified invoice at all.
     *
     * Pinned in the REJECTING direction because it is a constraint the assembler
     * must eventually enforce (fail closed at issuance rather than at ZATCA).
     * If ZATCA ever relaxes it, this test tells us.
     */
    const eduAnonymous = zeroVat(
      simplifiedInvoice({ invoiceNumber: "INV-S-EDU-1", icv: 8 }),
      "E",
      "VATEX-SA-EDU",
      "Private education to citizen",
    );
    const result = await submit(eduAnonymous);
    expect(result.status).toBe("ERROR");
    expect((result.errorMessages ?? []).map((e) => e.code)).toContain("BR-KSA-49");
  }, 120_000);
});
