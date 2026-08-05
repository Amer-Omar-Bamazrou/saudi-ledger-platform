/**
 * ZATCA Phase 2 e-invoice domain types (M12.2).
 *
 * `EInvoiceInput` is a FULLY-RESOLVED, plain-data description of one document.
 * The UBL generator takes only this — no repositories, no `db`, no request
 * context — which is what makes it a pure function and trivially testable. The
 * assembler (`einvoiceInput.assembler.ts`) is the only thing that touches the
 * database.
 *
 * Money is carried as `string` throughout, already rounded to the scale that
 * goes on the wire. Numbers would invite float drift between what we compute,
 * what we sign, and what we send — and the signature covers the rendered text,
 * so the string IS the value.
 */

/** ZATCA document types. `invoice` today; the notes arrive with M12.1b. */
export type EInvoiceDocumentType = "invoice" | "credit_note" | "debit_note";

/**
 * Standard (B2B/B2G) is CLEARED before issuance; simplified (B2C) is REPORTED
 * within 24h. This also drives `InvoiceTypeCode/@name` and whether a buyer
 * address is mandatory (BR-KSA-10 exempts simplified).
 */
export type EInvoiceSubtype = "standard" | "simplified";

/**
 * UN/CEFACT 5305 tax category, restricted to the values ZATCA accepts.
 *   S = standard rate · Z = zero-rated · E = exempt · O = out of scope
 */
export type TaxCategoryCode = "S" | "Z" | "E" | "O";

/**
 * A Saudi National Address.
 *
 * Field-by-field this is what the ZATCA schematron actually asserts:
 *   buildingNumber   cbc:BuildingNumber        BR-KSA-09 (seller) · max 4 chars (BR-CL-KSA-17)
 *   street           cbc:StreetName            BR-KSA-09, BR-KSA-10
 *   additionalNumber cbc:PlotIdentification    BR-KSA-09  (KSA-23)
 *   district         cbc:CitySubdivisionName   BR-KSA-09, BR-KSA-10  (KSA-3)
 *   city             cbc:CityName              BR-KSA-09, BR-KSA-10
 *   postalCode       cbc:PostalZone            BR-KSA-09, BR-KSA-10
 *   province         cbc:CountrySubentity      BR-KSA-10 ONLY  (buyer, BT-54)
 *   countryCode      cac:Country/cbc:Id…       BR-KSA-09, BR-KSA-10
 */
export interface NationalAddress {
  buildingNumber: string | null;
  street: string | null;
  district: string | null;
  city: string | null;
  postalCode: string | null;
  additionalNumber: string | null;
  /** Province / region. Required on the BUYER of a standard invoice. */
  province: string | null;
  /** ISO 3166 alpha-2. Defaults to SA. */
  countryCode: string;
}

export interface EInvoiceParty {
  /** Legal registration name (`cac:PartyLegalEntity/cbc:RegistrationName`). */
  legalName: string;
  /** VAT registration number — 15 digits. Null for an unregistered buyer. */
  vatNumber: string | null;
  /**
   * Additional scheme identity, e.g. Commercial Registration.
   * `schemeId` is ZATCA's code: CRN, MOM, MLS, SAG, OTH, NAT, GCC, IQA, PAS, TIN.
   */
  identification: { schemeId: string; value: string } | null;
  address: NationalAddress;
}

export interface EInvoiceLine {
  /** 1-based position; becomes `cac:InvoiceLine/cbc:ID`. */
  id: number;
  name: string;
  quantity: string;
  /** UN/ECE Rec 20 unit code. */
  unitCode: string;
  /** Unit price, VAT-exclusive. */
  unitPrice: string;
  /** Line net after discount, VAT-exclusive (`cbc:LineExtensionAmount`). */
  lineExtensionAmount: string;
  /** Line-level discount, VAT-exclusive. "0.00" when none. */
  discountAmount: string;
  taxCategory: TaxCategoryCode;
  /** VAT percent as a plain number string, e.g. "15.00". */
  taxPercent: string;
  taxAmount: string;
  /** lineExtensionAmount + taxAmount (`cac:TaxTotal/cbc:RoundingAmount`). */
  lineTotalWithTax: string;
  /** Mandatory when taxCategory is Z, E or O. */
  taxExemptionReasonCode: string | null;
  taxExemptionReasonText: string | null;
}

/** One tax-category bucket in the document-level `cac:TaxTotal`. */
export interface TaxSubtotal {
  taxableAmount: string;
  taxAmount: string;
  category: TaxCategoryCode;
  percent: string;
  exemptionReasonCode: string | null;
  exemptionReasonText: string | null;
}

export interface EInvoiceInput {
  /** Human invoice number (`cbc:ID`). */
  invoiceNumber: string;
  /** ZATCA's 128-bit document UUID (`cbc:UUID`). */
  uuid: string;
  /** Invoice Counter Value — sequential per EGS unit, never reused. */
  icv: number;
  /**
   * Previous Invoice Hash. For the first document in a company's chain this is
   * ZATCA's genesis value (base64 of the hex string of SHA-256("0")), not an
   * arbitrary literal — see GENESIS_PIH.
   */
  previousInvoiceHash: string;

  documentType: EInvoiceDocumentType;
  subtype: EInvoiceSubtype;
  /** Issuance instant (NOT the accounting date). Drives IssueDate + IssueTime. */
  issuedAt: Date;
  /** ISO 4217. SAR unless the tenant invoices in another currency. */
  currency: string;

  seller: EInvoiceParty;
  buyer: EInvoiceParty | null;

  lines: EInvoiceLine[];

  /** Sum of line extension amounts, VAT-exclusive. */
  lineExtensionTotal: string;
  /** Document-level allowance (discount), VAT-exclusive. */
  allowanceTotal: string;
  taxExclusiveTotal: string;
  taxInclusiveTotal: string;
  prepaidAmount: string;
  payableAmount: string;
  /** Total VAT (`cac:TaxTotal/cbc:TaxAmount`). */
  taxTotal: string;
  taxSubtotals: TaxSubtotal[];

  /** UN/CEFACT 4461 payment means. 10 = cash, 30 = credit transfer, 42 = bank. */
  paymentMeansCode: string | null;
  /** Credit/debit notes MUST reference the original and state a reason. */
  billingReference: { invoiceNumber: string } | null;
  instructionNote: string | null;
  notes: string | null;
}

/** What a provider returns once it has built (and, from M12.3, signed) a document. */
export interface BuiltDocument {
  /** The UBL 2.1 document. Unsigned until M12.3. */
  xml: string;
  /** base64( SHA-256( C14N XML ) ) — M12.3. */
  invoiceHash: string | null;
  /** Base64 TLV QR, tags 1-9 — M12.3. */
  qrCode: string | null;
  /** Echoed so the caller can persist the chain link without recomputing. */
  previousInvoiceHash: string;
  uuid: string;
  icv: number;
}
