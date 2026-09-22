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

/**
 * ZATCA document types (UN/CEFACT 1001): invoice 388 · credit_note 381 ·
 * debit_note 383 · advance_invoice 386 (AP-2 — the PREPAYMENT tax invoice,
 * XML Implementation Standard v1.2 ¶9.5 / §11.2.1).
 */
export type EInvoiceDocumentType = "invoice" | "credit_note" | "debit_note" | "advance_invoice" | "advance_credit_note" | "recovery_invoice";

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

/**
 * AP-2 — ONE PREPAYMENT ADJUSTMENT LINE of a final invoice (XML Standard
 * ¶9.5; BR-KSA-73…82): an additional `cac:InvoiceLine` whose principal
 * values are all ZERO (quantity, LineExtensionAmount, line TaxAmount,
 * RoundingAmount, PriceAmount), carrying one `cac:DocumentReference` per
 * advance tax invoice it adjusts (KSA-26 number, KSA-28 issue date, KSA-29
 * issue time, KSA-30 type code 386 — and the 386's UUID, KSA-1, which the
 * Guideline §8(b) names as "currently optional, to be mandated") and ONE
 * `cac:TaxSubtotal` (KSA-31 taxable, KSA-32 tax, KSA-33 category, KSA-34
 * rate) consolidating the adjusted advances of that category and rate.
 * `PrepaidAmount` (BT-113) = Σ over these lines of (KSA-31 + KSA-32).
 */
export interface PrepaymentAdjustmentLine {
  references: Array<{ invoiceNumber: string; uuid: string | null; issueDate: string; issueTime: string }>;
  /** KSA-31 — Σ taxable amounts of the adjusted advances at this category and rate. */
  taxableAmount: string;
  /** KSA-32 — Σ their VAT. */
  taxAmount: string;
  /** KSA-33. */
  taxCategory: TaxCategoryCode;
  /** KSA-34 — the ADVANCE invoice's rate (may be a historic rate). */
  taxPercent: string;
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
  /**
   * KSA-5 supply date (`cac:Delivery/cbc:ActualDeliveryDate`), `YYYY-MM-DD`.
   * Null ⇒ the issue date (the pre-2026-09-22 behaviour for every ordinary
   * document). Set for the documents whose TAX POINT precedes issuance
   * (accountant, 2026-09-22): an advance tax invoice (386) carries the
   * RECEIPT date; an Art. 40(9) recovery invoice carries the recovery
   * payment's date. Three dates, kept apart: tax point/supply date, the
   * accounting date, and IssueDate.
   */
  supplyDate: string | null;
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
  /**
   * BT-113 — the VAT-INCLUSIVE advance adjusted by this invoice: Σ of the
   * prepayment adjustment lines' (KSA-31 + KSA-32). "0.00" when none.
   * 🔴 Never the cash received (Guideline §8(c): populated only when a
   * separate advance invoice was issued at the time of the advance).
   */
  prepaidAmount: string;
  /** BT-115 — TaxInclusiveAmount − PrepaidAmount. */
  payableAmount: string;
  /** AP-2 — the prepayment adjustment lines, appended after the supply lines. Empty unless the invoice adjusts an advance. */
  prepaymentAdjustments: PrepaymentAdjustmentLine[];
  /** Total VAT (`cac:TaxTotal/cbc:TaxAmount`). */
  taxTotal: string;
  taxSubtotals: TaxSubtotal[];

  /** UN/CEFACT 4461 payment means. 10 = cash, 30 = credit transfer, 42 = bank. */
  paymentMeansCode: string | null;
  /**
   * Credit/debit notes MUST reference the original and state a reason
   * (BR-KSA-56, BR-KSA-17). An Art. 40(9) recovery invoice (388) ALSO carries
   * the original tax invoice here — BG-3 "preceding invoice reference" is
   * not restricted to notes by the standard; the sandbox is the arbiter
   * (ap-period-correction live test).
   */
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
