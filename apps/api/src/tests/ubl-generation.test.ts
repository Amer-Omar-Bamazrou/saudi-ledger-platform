/**
 * M12.2 — UBL 2.1 generation, unit level.
 *
 * DB-free and Java-free: the generator is a pure function, so these run
 * everywhere including CI. The authoritative structural check lives in
 * `ubl-zatca-validator.test.ts`, which runs ZATCA's own SDK.
 */
import { describe, expect, it } from "vitest";
import { buildInvoiceXml, GENESIS_PIH } from "../services/einvoice/ubl/buildInvoiceXml";
import { advanceCreditNote, advanceInvoice, finalInvoiceWithPrepayment, simplifiedInvoice, standardInvoice } from "../services/einvoice/__fixtures__/sampleInput";
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
    // AP-2: the prepayment (advance payment) tax invoice — XML Standard §11.2.1, subtype 01 / 02 as for an invoice.
    expect(buildInvoiceXml(advanceInvoice())).toContain('<cbc:InvoiceTypeCode name="0100000">386</cbc:InvoiceTypeCode>');
    expect(buildInvoiceXml(advanceInvoice({ subtype: "simplified", buyer: null }))).toContain('<cbc:InvoiceTypeCode name="0200000">386</cbc:InvoiceTypeCode>');
  });

  it("AP-3: the credit note against an advance is a 381 referencing the 386's number, with the reason, and no prepayment fields", () => {
    const xml = buildInvoiceXml(advanceCreditNote());
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>');
    expect(xml).toMatch(/<cac:BillingReference>\s*<cac:InvoiceDocumentReference>\s*<cbc:ID>ADV-0001<\/cbc:ID>/);
    expect(xml).toContain("<cbc:InstructionNote>Order cancelled - advance returned</cbc:InstructionNote>");
    expect(xml).toContain('<cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>');
    expect(xml).not.toContain("<cac:DocumentReference>");
  });

  it("AP-2: an advance invoice carries NO prepayment fields of its own — PrepaidAmount 0.00, PayableAmount = the advance", () => {
    const xml = buildInvoiceXml(advanceInvoice());
    expect(xml).toContain('<cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="SAR">11500.00</cbc:PayableAmount>');
    expect(xml).not.toContain("Prepayment adjustment");
    expect(xml).not.toContain("<cac:DocumentReference>");
  });

  it("AP-2: the final invoice's prepayment adjustment line follows XML Standard 9.5 exactly", () => {
    const xml = buildInvoiceXml(finalInvoiceWithPrepayment());
    // BT-113 = KSA-31 + KSA-32; BT-115 = tax inclusive − prepaid; the document TaxTotal stays the FULL supply VAT.
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="SAR">34500.00</cbc:TaxInclusiveAmount>');
    expect(xml).toContain('<cbc:PrepaidAmount currencyID="SAR">11500.00</cbc:PrepaidAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="SAR">23000.00</cbc:PayableAmount>');
    // Three: the two document-level TaxTotal blocks AND the supply line's own — the adjustment line's is 0.00, never 4500.00.
    expect(xml.match(/<cac:TaxTotal>\s*<cbc:TaxAmount currencyID="SAR">4500.00<\/cbc:TaxAmount>/g)?.length).toBe(3);
    // The adjustment line: id 2 (after the one supply line), zero principal values, the 386 reference, one KSA-31/32 subtotal.
    const line = xml.slice(xml.indexOf("<cbc:ID>2</cbc:ID>") - 20);
    expect(line).toContain('<cbc:InvoicedQuantity unitCode="PCE">0.00</cbc:InvoicedQuantity>');
    expect(line).toContain('<cbc:LineExtensionAmount currencyID="SAR">0.00</cbc:LineExtensionAmount>');
    expect(line).toMatch(/<cac:DocumentReference>\s*<cbc:ID>ADV-0001<\/cbc:ID>\s*<cbc:UUID>8a1d2c3e-4f50-4a6b-9c7d-0e1f2a3b4c5d<\/cbc:UUID>\s*<cbc:IssueDate>2026-03-21<\/cbc:IssueDate>\s*<cbc:IssueTime>10:02:11<\/cbc:IssueTime>\s*<cbc:DocumentTypeCode>386<\/cbc:DocumentTypeCode>\s*<\/cac:DocumentReference>/);
    expect(line).toContain('<cbc:TaxableAmount currencyID="SAR">10000.00</cbc:TaxableAmount>');
    expect(line).toContain('<cbc:TaxAmount currencyID="SAR">1500.00</cbc:TaxAmount>');
    expect(line).toContain("<cbc:Name>Prepayment adjustment</cbc:Name>");
    expect(line).toContain('<cbc:PriceAmount currencyID="SAR">0.00</cbc:PriceAmount>');
    // Element order inside the line: DocumentReference precedes TaxTotal, which precedes Item (the UBL sequence).
    expect(line.indexOf("<cac:DocumentReference>")).toBeLessThan(line.indexOf("<cac:TaxTotal>"));
    expect(line.indexOf("<cac:TaxTotal>")).toBeLessThan(line.indexOf("<cac:Item>"));
  });

  it("AP-2: two advances of one category and rate consolidate into ONE adjustment line with two references (9.5 example 2)", () => {
    const base = finalInvoiceWithPrepayment();
    const adj = base.prepaymentAdjustments[0]!;
    const xml = buildInvoiceXml({
      ...base,
      prepaidAmount: "23000.00",
      payableAmount: "11500.00",
      prepaymentAdjustments: [{ ...adj, references: [adj.references[0]!, { invoiceNumber: "ADV-0002", uuid: null, issueDate: "2026-03-25", issueTime: "08:00:00" }], taxableAmount: "20000.00", taxAmount: "3000.00" }],
    });
    expect(xml.match(/<cac:DocumentReference>/g)?.length).toBe(2);
    expect(xml.match(/Prepayment adjustment/g)?.length).toBe(1);
    expect(xml).toContain("<cbc:ID>ADV-0002</cbc:ID>");
    expect(xml).toContain('<cbc:PrepaidAmount currencyID="SAR">23000.00</cbc:PrepaidAmount>');
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

  /**
   * 🔴 S1 REGRESSION GUARD — this test used to assert the OPPOSITE.
   *
   * It previously pinned that `onboard` and `submit` throw `NotImplementedError`,
   * which was true and correct at M12.2. What no one noticed is that it stayed
   * green through M12.4 (which built onboarding) and M12.6 (which built
   * transport), because BOTH shipped their real logic somewhere else and left
   * the seam throwing. A passing test was quietly certifying that the swap point
   * for a certified vendor did not work.
   *
   * Now inverted: every method must be reachable. If a future change routes a
   * real path around the seam again, this fails.
   */
  it("every EInvoiceProvider method is implemented — the vendor swap point is real", async () => {
    for (const method of ["onboard", "renewCertificate", "buildDocument", "submit"] as const) {
      expect(typeof zatcaDirectProvider[method]).toBe("function");
    }

    // `submit` reaches its own guards rather than a NotImplementedError. An
    // unsigned document is refused as a RESULT, not an exception, so one bad
    // document cannot take down a worker batch.
    const result = await zatcaDirectProvider.submit(
      { xml: "<x/>", invoiceHash: null, qrCode: null, previousInvoiceHash: "", uuid: "u", icv: 1 },
      "clearance",
      { companyId: "no-such-company", uuid: "u" },
    );
    expect(result.status).toBe("failed");
    expect(result.errors?.[0]).toMatchObject({ reason: expect.stringContaining("never signed") });
  });
});
