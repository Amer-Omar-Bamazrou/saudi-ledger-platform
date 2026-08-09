/**
 * M12.2 — UBL 2.1 generation, unit level.
 *
 * DB-free and Java-free: the generator is a pure function, so these run
 * everywhere including CI. The authoritative structural check lives in
 * `ubl-zatca-validator.test.ts`, which runs ZATCA's own SDK.
 */
import { describe, expect, it } from "vitest";
import { buildInvoiceXml, GENESIS_PIH } from "../services/einvoice/ubl/buildInvoiceXml";
import { simplifiedInvoice, standardInvoice } from "../services/einvoice/__fixtures__/sampleInput";
import { assembleEInvoiceInput, subtypeFor, type AssembleRows } from "../services/einvoice/einvoiceInput.assembler";
import { zatcaDirectProvider } from "../services/einvoice/zatca/zatcaDirectProvider";
import { NotImplementedError } from "../services/einvoice/provider";
import { createHash } from "crypto";

/** Crude but dependency-free: the text content of the first matching element. */
function textOf(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}
function countOf(xml: string, tag: string): number {
  return xml.split(`<${tag}`).length - 1;
}

describe("M12.2 — UBL 2.1 invoice generation", () => {
  it("emits the ZATCA document identity fields", () => {
    const xml = buildInvoiceXml(standardInvoice());
    expect(textOf(xml, "cbc:ID")).toBe("INV-0001");
    expect(textOf(xml, "cbc:UUID")).toBe("3cf5ee18-ee25-44ea-a444-2c37ba7f28be");
    // IssueDate and IssueTime are split from the issuance INSTANT, not the
    // accounting date — the 24h reporting clock depends on the time component.
    expect(textOf(xml, "cbc:IssueDate")).toBe("2026-04-01");
    expect(textOf(xml, "cbc:IssueTime")).toBe("09:13:57");
  });

  it("standard invoices carry transaction code 0100000; simplified 0200000", () => {
    expect(buildInvoiceXml(standardInvoice())).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');
    expect(buildInvoiceXml(simplifiedInvoice())).toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>');
  });

  it("maps document type to the UN/CEFACT 1001 code", () => {
    expect(buildInvoiceXml(standardInvoice({ documentType: "invoice" }))).toContain(">388</cbc:InvoiceTypeCode>");
    expect(buildInvoiceXml(standardInvoice({ documentType: "credit_note" }))).toContain(">381</cbc:InvoiceTypeCode>");
    expect(buildInvoiceXml(standardInvoice({ documentType: "debit_note" }))).toContain(">383</cbc:InvoiceTypeCode>");
  });

  it("emits ICV and PIH as SIGNED document references", () => {
    const xml = buildInvoiceXml(standardInvoice({ icv: 42 }));
    expect(xml).toContain("<cbc:ID>ICV</cbc:ID>");
    expect(xml).toContain("<cbc:UUID>42</cbc:UUID>");
    expect(xml).toContain("<cbc:ID>PIH</cbc:ID>");
    expect(xml).toContain(GENESIS_PIH);
  });

  it("the genesis PIH is base64 of the HEX STRING of sha256('0'), not of the raw digest", () => {
    const hex = createHash("sha256").update("0").digest("hex");
    expect(Buffer.from(GENESIS_PIH, "base64").toString()).toBe(hex);
    // The easy mistake — base64 of the raw bytes — is a different value.
    const rawBytes = createHash("sha256").update("0").digest().toString("base64");
    expect(GENESIS_PIH).not.toBe(rawBytes);
  });

  it("does NOT emit the three elements the signature transform excludes", () => {
    // M12.3 injects these. If they ever appear here, the M12.2/M12.3 boundary
    // has drifted and the signature will cover content it must not.
    const xml = buildInvoiceXml(standardInvoice());
    expect(xml).not.toContain("UBLExtensions");
    expect(xml).not.toContain("<cac:Signature>");
    expect(xml).not.toContain("<cbc:ID>QR</cbc:ID>");
  });

  it("emits cbc:CountrySubentity on the buyer (BR-KSA-10 asserts it silently)", () => {
    const xml = buildInvoiceXml(standardInvoice());
    expect(xml).toContain("<cbc:CountrySubentity>Makkah Region</cbc:CountrySubentity>");
    // KSA-23 additional number → PlotIdentification, on both parties.
    expect(countOf(xml, "cbc:PlotIdentification")).toBe(2);
  });

  it("always emits cac:AccountingCustomerParty, even with no buyer", () => {
    // UBL 2.1 makes it mandatory; omitting it fails XSD before any KSA rule.
    const xml = buildInvoiceXml(simplifiedInvoice({ buyer: null }));
    expect(xml).toContain("<cac:AccountingCustomerParty>");
  });

  it("emits two TaxTotal blocks: the bare total then the breakdown", () => {
    const xml = buildInvoiceXml(standardInvoice());
    expect(countOf(xml, "cac:TaxTotal")).toBe(3); // 2 document-level + 1 per line
    expect(countOf(xml, "cac:TaxSubtotal")).toBe(1);
  });

  it("emits an exemption reason for non-standard tax categories only", () => {
    const zeroRated = standardInvoice({
      lines: [
        {
          ...standardInvoice().lines[0],
          taxCategory: "Z",
          taxPercent: "0.00",
          taxAmount: "0.00",
          lineTotalWithTax: "1000.00",
          taxExemptionReasonCode: "VATEX-SA-32",
          taxExemptionReasonText: "Export of goods",
        },
      ],
      taxSubtotals: [
        {
          taxableAmount: "1000.00",
          taxAmount: "0.00",
          category: "Z",
          percent: "0.00",
          exemptionReasonCode: "VATEX-SA-32",
          exemptionReasonText: "Export of goods",
        },
      ],
    });
    const xml = buildInvoiceXml(zeroRated);
    expect(xml).toContain("<cbc:TaxExemptionReasonCode>VATEX-SA-32</cbc:TaxExemptionReasonCode>");
    // A standard-rated document must NOT carry one.
    expect(buildInvoiceXml(standardInvoice())).not.toContain("TaxExemptionReason");
  });
});

describe("M12.2 — assembler", () => {
  const rows = (): AssembleRows => ({
    invoice: {
      invoiceNumber: "INV-1",
      zatcaUuid: "3cf5ee18-ee25-44ea-a444-2c37ba7f28be",
      icv: 1,
      issuedAt: new Date("2026-04-01T09:13:57Z"),
      documentType: "invoice",
      currency: "SAR",
      subtotal: 1000,
      vatAmount: 150,
      discount: 0,
      total: 1150,
      paidAmount: 0,
      notes: null,
    noteReason: null,
    },
    items: [
      {
        description: "Freight",
        quantity: 1,
        unitPrice: 1000,
        vatRate: 15,
        vatAmount: 150,
        discount: 0,
        total: 1150,
        unitCode: "PCE",
        taxCategoryCode: "S",
        taxExemptionReasonCode: null,
        taxExemptionReasonText: null,
      },
    ],
    company: {
      name: "Al-Rashid Trading Est.",
      vatNumber: "310123456789013",
      crNumber: "1010101010",
      buildingNumber: "1234",
      street: "King Fahd Road",
      district: "Al Olaya",
      city: "Riyadh",
      postalCode: "12345",
      additionalNumber: "6789",
    },
    customer: {
      name: "Beta Logistics Co.",
      taxNumber: "311987654321003",
      crNumber: "2020202020",
      buildingNumber: "4321",
      street: "Prince Sultan Street",
      district: "Al Rawdah",
      city: "Jeddah",
      postalCode: "23456",
      additionalNumber: "9876",
      province: "Makkah Region",
      country: "SA",
    nationalId: null,
    },
    previousInvoiceHash: null,
  });

  it("a VAT-registered buyer makes the document standard; otherwise simplified", () => {
    expect(subtypeFor("311987654321003")).toBe("standard");
    expect(subtypeFor(null)).toBe("simplified");
    expect(assembleEInvoiceInput(rows()).subtype).toBe("standard");
  });

  it("falls back to ZATCA's genesis PIH for the first document in a chain", () => {
    expect(assembleEInvoiceInput(rows()).previousInvoiceHash).toBe(GENESIS_PIH);
  });

  it("FAILS CLOSED when a line has no tax category (the ambiguous 0%-VAT case)", () => {
    const r = rows();
    r.items[0].taxCategoryCode = null;
    expect(() => assembleEInvoiceInput(r)).toThrowError(/tax category/i);
  });

  it("FAILS CLOSED when a non-standard category has no exemption reason", () => {
    const r = rows();
    r.items[0].taxCategoryCode = "Z";
    expect(() => assembleEInvoiceInput(r)).toThrowError(/exemption reason/i);
  });

  it("FAILS CLOSED without a company VAT number, a UUID, or an ICV", () => {
    const noVat = rows();
    noVat.company.vatNumber = null;
    expect(() => assembleEInvoiceInput(noVat)).toThrowError(/VAT registration/i);

    const noUuid = rows();
    noUuid.invoice.zatcaUuid = null;
    expect(() => assembleEInvoiceInput(noUuid)).toThrowError(/UUID/i);

    const noIcv = rows();
    noIcv.invoice.icv = null;
    expect(() => assembleEInvoiceInput(noIcv)).toThrowError(/ICV/i);
  });

  it("groups lines into one tax subtotal per (category, percent)", () => {
    const r = rows();
    r.items.push({ ...r.items[0], description: "Handling" });
    const input = assembleEInvoiceInput(r);
    expect(input.lines).toHaveLength(2);
    expect(input.taxSubtotals).toHaveLength(1);
    expect(input.taxSubtotals[0].taxableAmount).toBe("2000.00");
    expect(input.taxSubtotals[0].taxAmount).toBe("300.00");
  });
});

describe("M12.2 — the EInvoiceProvider seam", () => {
  it("zatca-direct builds a document but reports the unbuilt parts as null", async () => {
    const built = await zatcaDirectProvider.buildDocument(standardInvoice());
    expect(built.xml).toContain("<cbc:ID>INV-0001</cbc:ID>");
    // Explicitly null, not absent — persistence stays honest that this document
    // is unsigned until M12.3.
    expect(built.invoiceHash).toBeNull();
    expect(built.qrCode).toBeNull();
    expect(built.icv).toBe(1);
  });

  it("unbuilt provider methods fail loudly rather than silently succeeding", async () => {
    await expect(
      zatcaDirectProvider.onboard({ companyId: "x", otp: "1", egsSerialNumber: "1-a|2-b|3-c", invoiceTypeFlags: "1100" }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    await expect(zatcaDirectProvider.submit({} as any, "clearance")).rejects.toBeInstanceOf(NotImplementedError);
  });
});
