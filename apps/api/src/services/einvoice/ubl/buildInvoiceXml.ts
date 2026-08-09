/**
 * UBL 2.1 invoice generation for ZATCA Phase 2 (M12.2).
 *
 * A PURE function: `EInvoiceInput` in, XML string out. No database, no request
 * context, no clock. Everything it needs is already resolved by the assembler,
 * which is what lets the whole document surface be unit-tested and diffed
 * against the ZATCA SDK validator without standing anything up.
 *
 * ── What this deliberately does NOT emit ────────────────────────────────────
 * The ZATCA signature transform excludes exactly three elements:
 *
 *     ext:UBLExtensions
 *     cac:Signature
 *     cac:AdditionalDocumentReference[cbc:ID='QR']
 *
 * Those three are what M12.3 INJECTS at signing time. So the boundary between
 * M12.2 and M12.3 is not invented — it is read straight off the spec's transform
 * chain. Everything this module emits IS signed content, including the ICV and
 * PIH document references.
 *
 * ── Element order is significant ────────────────────────────────────────────
 * UBL types are XSD `xsd:sequence`, so a correct-but-reordered document fails
 * schema validation. The order below follows UBL-Invoice-2.1.xsd; do not
 * rearrange for readability.
 */
import { create } from "xmlbuilder2";
import type { EInvoiceInput, EInvoiceLine, EInvoiceParty, NationalAddress, TaxSubtotal } from "../types";
import { splitIssuedAt } from "../issuedAt";

const NS = {
  inv: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  ext: "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
} as const;

/**
 * ZATCA's genesis Previous Invoice Hash, shipped in the SDK at
 * `Data/PIH/pih.txt`. It is Base64 of the **hex string** of SHA-256("0") — note
 * the double encoding; it is NOT Base64 of the raw digest bytes. Our legacy
 * `"GENESIS"` literal has nothing to do with this.
 */
export const GENESIS_PIH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";

/** UN/CEFACT 1001 document type codes. */
const TYPE_CODE = { invoice: "388", debit_note: "383", credit_note: "381" } as const;

/**
 * KSA-2 "invoice transaction code" — 7 digits, validated by BR-KSA-06.
 *   pos 1-2  01 = standard (B2B/B2G), 02 = simplified (B2C)
 *   pos 3    third-party      pos 4  nominal      pos 5  exports
 *   pos 6    summary          pos 7  self-billed
 * We emit the plain case; the optional flags become inputs if those scenarios
 * are ever supported.
 */
function transactionCode(subtype: EInvoiceInput["subtype"]): string {
  return subtype === "standard" ? "0100000" : "0200000";
}

/** `2026-04-01T09:13:57.123Z` → `["2026-04-01", "09:13:57"]`. */
// Shared with the QR builder — ZATCA cross-checks tag 3 against these two
// fields, so they must come from ONE formatter. See `../issuedAt.ts`.

/**
 * Emit `cac:PostalAddress`.
 *
 * Element order follows the UBL XSD sequence (StreetName → BuildingNumber →
 * PlotIdentification → CitySubdivisionName → CityName → PostalZone →
 * CountrySubentity → Country) — reordering fails schema validation.
 *
 * `cbc:CountrySubentity` is emitted for the BUYER of a standard invoice: the
 * BR-KSA-10 assertion requires it even though the rule's message never mentions
 * it. Verified by running ZATCA's own validator.
 */
function addAddress(parent: any, addr: NationalAddress): void {
  const a = parent.ele(NS.cac, "cac:PostalAddress");
  if (addr.street) a.ele(NS.cbc, "cbc:StreetName").txt(addr.street);
  if (addr.buildingNumber) a.ele(NS.cbc, "cbc:BuildingNumber").txt(addr.buildingNumber);
  // KSA-23 "additional number" maps to PlotIdentification.
  if (addr.additionalNumber) a.ele(NS.cbc, "cbc:PlotIdentification").txt(addr.additionalNumber);
  // KSA-3 "neighbourhood" maps to CitySubdivisionName.
  if (addr.district) a.ele(NS.cbc, "cbc:CitySubdivisionName").txt(addr.district);
  if (addr.city) a.ele(NS.cbc, "cbc:CityName").txt(addr.city);
  if (addr.postalCode) a.ele(NS.cbc, "cbc:PostalZone").txt(addr.postalCode);
  if (addr.province) a.ele(NS.cbc, "cbc:CountrySubentity").txt(addr.province);
  a.ele(NS.cac, "cac:Country").ele(NS.cbc, "cbc:IdentificationCode").txt(addr.countryCode);
}

function addParty(parent: any, wrapper: string, party: EInvoiceParty): void {
  const p = parent.ele(NS.cac, wrapper).ele(NS.cac, "cac:Party");

  if (party.identification) {
    p.ele(NS.cac, "cac:PartyIdentification")
      .ele(NS.cbc, "cbc:ID")
      .att("schemeID", party.identification.schemeId)
      .txt(party.identification.value);
  }

  addAddress(p, party.address);

  // BR-KSA-08/14: the VAT number goes in PartyTaxScheme/CompanyID. The
  // TaxScheme block is required even when the party is not VAT-registered.
  const ts = p.ele(NS.cac, "cac:PartyTaxScheme");
  if (party.vatNumber) ts.ele(NS.cbc, "cbc:CompanyID").txt(party.vatNumber);
  ts.ele(NS.cac, "cac:TaxScheme").ele(NS.cbc, "cbc:ID").txt("VAT");

  p.ele(NS.cac, "cac:PartyLegalEntity").ele(NS.cbc, "cbc:RegistrationName").txt(party.legalName);
}

/** `cac:TaxCategory`, shared by the document subtotals and the line items. */
function addTaxCategory(parent: any, category: string, percent: string, reasonCode: string | null, reasonText: string | null): void {
  const tc = parent.ele(NS.cac, "cac:TaxCategory");
  tc.ele(NS.cbc, "cbc:ID").att("schemeID", "UN/ECE 5305").att("schemeAgencyID", "6").txt(category);
  tc.ele(NS.cbc, "cbc:Percent").txt(percent);
  // Mandatory whenever VAT is not charged at the standard rate.
  if (category !== "S") {
    if (reasonCode) tc.ele(NS.cbc, "cbc:TaxExemptionReasonCode").txt(reasonCode);
    if (reasonText) tc.ele(NS.cbc, "cbc:TaxExemptionReason").txt(reasonText);
  }
  tc.ele(NS.cac, "cac:TaxScheme")
    .ele(NS.cbc, "cbc:ID")
    .att("schemeID", "UN/ECE 5153")
    .att("schemeAgencyID", "6")
    .txt("VAT");
}

function addSubtotal(parent: any, st: TaxSubtotal, currency: string): void {
  const s = parent.ele(NS.cac, "cac:TaxSubtotal");
  s.ele(NS.cbc, "cbc:TaxableAmount").att("currencyID", currency).txt(st.taxableAmount);
  s.ele(NS.cbc, "cbc:TaxAmount").att("currencyID", currency).txt(st.taxAmount);
  addTaxCategory(s, st.category, st.percent, st.exemptionReasonCode, st.exemptionReasonText);
}

function addLine(parent: any, line: EInvoiceLine, currency: string): void {
  const l = parent.ele(NS.cac, "cac:InvoiceLine");
  l.ele(NS.cbc, "cbc:ID").txt(String(line.id));
  l.ele(NS.cbc, "cbc:InvoicedQuantity").att("unitCode", line.unitCode).txt(line.quantity);
  l.ele(NS.cbc, "cbc:LineExtensionAmount").att("currencyID", currency).txt(line.lineExtensionAmount);

  // Line-level VAT. RoundingAmount is the line total INCLUDING tax (KSA-11).
  const tt = l.ele(NS.cac, "cac:TaxTotal");
  tt.ele(NS.cbc, "cbc:TaxAmount").att("currencyID", currency).txt(line.taxAmount);
  tt.ele(NS.cbc, "cbc:RoundingAmount").att("currencyID", currency).txt(line.lineTotalWithTax);

  const item = l.ele(NS.cac, "cac:Item");
  item.ele(NS.cbc, "cbc:Name").txt(line.name);
  const ctc = item.ele(NS.cac, "cac:ClassifiedTaxCategory");
  ctc.ele(NS.cbc, "cbc:ID").txt(line.taxCategory);
  ctc.ele(NS.cbc, "cbc:Percent").txt(line.taxPercent);
  ctc.ele(NS.cac, "cac:TaxScheme").ele(NS.cbc, "cbc:ID").txt("VAT");

  const price = l.ele(NS.cac, "cac:Price");
  price.ele(NS.cbc, "cbc:PriceAmount").att("currencyID", currency).txt(line.unitPrice);
  if (line.discountAmount !== "0.00") {
    const ac = price.ele(NS.cac, "cac:AllowanceCharge");
    ac.ele(NS.cbc, "cbc:ChargeIndicator").txt("false");
    ac.ele(NS.cbc, "cbc:AllowanceChargeReason").txt("discount");
    ac.ele(NS.cbc, "cbc:Amount").att("currencyID", currency).txt(line.discountAmount);
  }
}

/**
 * Build the UBL 2.1 XML for one document.
 *
 * The result is complete and schema-valid EXCEPT for the three
 * signature-related elements listed in the module docstring, which M12.3 adds.
 */
export function buildInvoiceXml(input: EInvoiceInput): string {
  const [issueDate, issueTime] = splitIssuedAt(input.issuedAt);
  const cur = input.currency;

  const doc = create({ version: "1.0", encoding: "UTF-8" })
    .ele(NS.inv, "Invoice")
    .att("xmlns:cac", NS.cac)
    .att("xmlns:cbc", NS.cbc)
    .att("xmlns:ext", NS.ext);

  // ── ext:UBLExtensions — INJECTED BY M12.3 (excluded from the signature) ──

  // Standard invoices are CLEARED; simplified are REPORTED.
  doc.ele(NS.cbc, "cbc:ProfileID").txt("reporting:1.0");
  doc.ele(NS.cbc, "cbc:ID").txt(input.invoiceNumber);
  doc.ele(NS.cbc, "cbc:UUID").txt(input.uuid);
  doc.ele(NS.cbc, "cbc:IssueDate").txt(issueDate);
  doc.ele(NS.cbc, "cbc:IssueTime").txt(issueTime);
  doc
    .ele(NS.cbc, "cbc:InvoiceTypeCode")
    .att("name", transactionCode(input.subtype))
    .txt(TYPE_CODE[input.documentType]);
  if (input.notes) doc.ele(NS.cbc, "cbc:Note").txt(input.notes);
  doc.ele(NS.cbc, "cbc:DocumentCurrencyCode").txt(cur);
  doc.ele(NS.cbc, "cbc:TaxCurrencyCode").txt(cur);

  // BR-KSA-17: a credit or debit note must reference the original document.
  if (input.billingReference) {
    doc
      .ele(NS.cac, "cac:BillingReference")
      .ele(NS.cac, "cac:InvoiceDocumentReference")
      .ele(NS.cbc, "cbc:ID")
      .txt(input.billingReference.invoiceNumber);
  }

  // ── Signed document references: ICV and PIH ──────────────────────────────
  const icv = doc.ele(NS.cac, "cac:AdditionalDocumentReference");
  icv.ele(NS.cbc, "cbc:ID").txt("ICV");
  icv.ele(NS.cbc, "cbc:UUID").txt(String(input.icv));

  const pih = doc.ele(NS.cac, "cac:AdditionalDocumentReference");
  pih.ele(NS.cbc, "cbc:ID").txt("PIH");
  pih
    .ele(NS.cac, "cac:Attachment")
    .ele(NS.cbc, "cbc:EmbeddedDocumentBinaryObject")
    .att("mimeCode", "text/plain")
    .txt(input.previousInvoiceHash);

  // ── QR AdditionalDocumentReference + cac:Signature — INJECTED BY M12.3 ──

  addParty(doc, "cac:AccountingSupplierParty", input.seller);
  // `cac:AccountingCustomerParty` is MANDATORY in UBL 2.1 even when there is no
  // identifiable buyer — a simplified (B2C) sale to a walk-in customer still
  // needs the element, just with no content. Omitting it fails XSD validation
  // before any KSA rule is even reached. BR-KSA-10's buyer-address requirements
  // are what simplified invoices are exempt from, not the element itself.
  if (input.buyer) {
    addParty(doc, "cac:AccountingCustomerParty", input.buyer);
  } else {
    doc.ele(NS.cac, "cac:AccountingCustomerParty").ele(NS.cac, "cac:Party");
  }

  doc.ele(NS.cac, "cac:Delivery").ele(NS.cbc, "cbc:ActualDeliveryDate").txt(issueDate);

  if (input.paymentMeansCode) {
    const pm = doc.ele(NS.cac, "cac:PaymentMeans");
    pm.ele(NS.cbc, "cbc:PaymentMeansCode").txt(input.paymentMeansCode);
    // BR-KSA-17: notes must state WHY they were issued.
    if (input.instructionNote) pm.ele(NS.cbc, "cbc:InstructionNote").txt(input.instructionNote);
  }

  // Document-level discount, declared as an allowance against the standard rate.
  if (input.allowanceTotal !== "0.00") {
    const ac = doc.ele(NS.cac, "cac:AllowanceCharge");
    ac.ele(NS.cbc, "cbc:ChargeIndicator").txt("false");
    ac.ele(NS.cbc, "cbc:AllowanceChargeReason").txt("discount");
    ac.ele(NS.cbc, "cbc:Amount").att("currencyID", cur).txt(input.allowanceTotal);
    addTaxCategory(ac, "S", "15.00", null, null);
  }

  // ZATCA expects TWO TaxTotal blocks: a bare total, then the breakdown.
  doc.ele(NS.cac, "cac:TaxTotal").ele(NS.cbc, "cbc:TaxAmount").att("currencyID", cur).txt(input.taxTotal);
  const breakdown = doc.ele(NS.cac, "cac:TaxTotal");
  breakdown.ele(NS.cbc, "cbc:TaxAmount").att("currencyID", cur).txt(input.taxTotal);
  for (const st of input.taxSubtotals) addSubtotal(breakdown, st, cur);

  const lmt = doc.ele(NS.cac, "cac:LegalMonetaryTotal");
  lmt.ele(NS.cbc, "cbc:LineExtensionAmount").att("currencyID", cur).txt(input.lineExtensionTotal);
  lmt.ele(NS.cbc, "cbc:TaxExclusiveAmount").att("currencyID", cur).txt(input.taxExclusiveTotal);
  lmt.ele(NS.cbc, "cbc:TaxInclusiveAmount").att("currencyID", cur).txt(input.taxInclusiveTotal);
  lmt.ele(NS.cbc, "cbc:AllowanceTotalAmount").att("currencyID", cur).txt(input.allowanceTotal);
  lmt.ele(NS.cbc, "cbc:PrepaidAmount").att("currencyID", cur).txt(input.prepaidAmount);
  lmt.ele(NS.cbc, "cbc:PayableAmount").att("currencyID", cur).txt(input.payableAmount);

  for (const line of input.lines) addLine(doc, line, cur);

  return doc.end({ prettyPrint: true });
}
