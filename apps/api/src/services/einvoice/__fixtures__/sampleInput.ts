/**
 * Sample `EInvoiceInput` fixtures for the UBL generator tests (M12.2).
 *
 * These are hand-built rather than derived from the database on purpose: the
 * generator is a pure function, so its tests should not need a tenant, a
 * transaction, or a migration.
 */
import type { EInvoiceInput } from "../types";

/** A fully-populated seller — every BR-KSA-09 address component present. */
export const SELLER = {
  legalName: "Al-Rashid Trading Est.",
  vatNumber: "310123456789013",
  identification: { schemeId: "CRN", value: "1010101010" },
  address: {
    buildingNumber: "1234",
    street: "King Fahd Road",
    district: "Al Olaya",
    city: "Riyadh",
    postalCode: "12345",
    additionalNumber: "6789",
    // Not required on the seller (BR-KSA-09 omits CountrySubentity).
    province: null,
    countryCode: "SA",
  },
} as const;

/** A VAT-registered buyer — makes the document STANDARD (cleared). */
export const BUYER_B2B = {
  legalName: "Beta Logistics Co.",
  vatNumber: "311987654321003",
  identification: { schemeId: "CRN", value: "2020202020" },
  address: {
    buildingNumber: "4321",
    street: "Prince Sultan Street",
    district: "Al Rawdah",
    city: "Jeddah",
    postalCode: "23456",
    additionalNumber: "9876",
    // REQUIRED on the buyer of a standard invoice — BR-KSA-10 asserts
    // cbc:CountrySubentity even though its message never mentions it.
    province: "Makkah Region",
    countryCode: "SA",
  },
} as const;

const LINE_STANDARD = {
  id: 1,
  name: "Freight services",
  quantity: "1",
  unitCode: "PCE",
  unitPrice: "1000.00",
  lineExtensionAmount: "1000.00",
  discountAmount: "0.00",
  taxCategory: "S" as const,
  taxPercent: "15.00",
  taxAmount: "150.00",
  lineTotalWithTax: "1150.00",
  taxExemptionReasonCode: null,
  taxExemptionReasonText: null,
};

/** Standard (B2B) tax invoice — the clearance path. */
export function standardInvoice(overrides: Partial<EInvoiceInput> = {}): EInvoiceInput {
  return {
    invoiceNumber: "INV-0001",
    uuid: "3cf5ee18-ee25-44ea-a444-2c37ba7f28be",
    icv: 1,
    previousInvoiceHash:
      "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==",
    documentType: "invoice",
    subtype: "standard",
    issuedAt: new Date("2026-04-01T09:13:57Z"),
    supplyDate: null,
    currency: "SAR",
    seller: SELLER,
    buyer: BUYER_B2B,
    lines: [LINE_STANDARD],
    lineExtensionTotal: "1000.00",
    allowanceTotal: "0.00",
    taxExclusiveTotal: "1000.00",
    taxInclusiveTotal: "1150.00",
    prepaidAmount: "0.00",
    payableAmount: "1150.00",
    prepaymentAdjustments: [],
    taxTotal: "150.00",
    taxSubtotals: [
      {
        taxableAmount: "1000.00",
        taxAmount: "150.00",
        category: "S",
        percent: "15.00",
        exemptionReasonCode: null,
        exemptionReasonText: null,
      },
    ],
    paymentMeansCode: "30",
    billingReference: null,
    instructionNote: null,
    notes: null,
    ...overrides,
  };
}

/**
 * AP-2 — an ADVANCE PAYMENT tax invoice (type 386): the same document shape
 * as a standard invoice with the type code changed (XML Standard §11.2.1);
 * its one line is the advance's split (11,500 received = 10,000 + 1,500).
 */
export function advanceInvoice(overrides: Partial<EInvoiceInput> = {}): EInvoiceInput {
  return standardInvoice({
    invoiceNumber: "ADV-0001",
    uuid: "8a1d2c3e-4f50-4a6b-9c7d-0e1f2a3b4c5d",
    documentType: "advance_invoice",
    lines: [{ ...LINE_STANDARD, name: "Advance payment received 2026-03-20 (receipt RCPT-7)", unitPrice: "10000.00", lineExtensionAmount: "10000.00", taxAmount: "1500.00", lineTotalWithTax: "11500.00" }],
    lineExtensionTotal: "10000.00",
    taxExclusiveTotal: "10000.00",
    taxInclusiveTotal: "11500.00",
    payableAmount: "11500.00",
    taxTotal: "1500.00",
    taxSubtotals: [{ taxableAmount: "10000.00", taxAmount: "1500.00", category: "S", percent: "15.00", exemptionReasonCode: null, exemptionReasonText: null }],
    ...overrides,
  });
}

/**
 * AP-2 — the FINAL invoice (388) adjusting the advance above: full supply
 * lines (30,000 + 4,500), one prepayment adjustment line (XML Standard
 * ¶9.5), PrepaidAmount 11,500 = KSA-31 + KSA-32, PayableAmount 23,000.
 */
export function finalInvoiceWithPrepayment(overrides: Partial<EInvoiceInput> = {}): EInvoiceInput {
  return standardInvoice({
    invoiceNumber: "INV-0002",
    icv: 2,
    lines: [{ ...LINE_STANDARD, name: "Consulting project", unitPrice: "30000.00", lineExtensionAmount: "30000.00", taxAmount: "4500.00", lineTotalWithTax: "34500.00" }],
    lineExtensionTotal: "30000.00",
    taxExclusiveTotal: "30000.00",
    taxInclusiveTotal: "34500.00",
    prepaidAmount: "11500.00",
    payableAmount: "23000.00",
    prepaymentAdjustments: [
      {
        references: [{ invoiceNumber: "ADV-0001", uuid: "8a1d2c3e-4f50-4a6b-9c7d-0e1f2a3b4c5d", issueDate: "2026-03-21", issueTime: "10:02:11" }],
        taxableAmount: "10000.00",
        taxAmount: "1500.00",
        taxCategory: "S",
        taxPercent: "15.00",
      },
    ],
    taxTotal: "4500.00",
    taxSubtotals: [{ taxableAmount: "30000.00", taxAmount: "4500.00", category: "S", percent: "15.00", exemptionReasonCode: null, exemptionReasonText: null }],
    ...overrides,
  });
}

/**
 * AP-3 — the CREDIT NOTE AGAINST the advance above (type 381): the same
 * shape as any credit note — a billing reference to the 386's number
 * (BR-KSA-56) and a reason (BR-KSA-17) — carrying the advance's split.
 */
export function advanceCreditNote(overrides: Partial<EInvoiceInput> = {}): EInvoiceInput {
  return advanceInvoice({
    invoiceNumber: "CN-ADV-0001",
    uuid: "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5e",
    icv: 3,
    documentType: "advance_credit_note",
    billingReference: { invoiceNumber: "ADV-0001" },
    instructionNote: "Order cancelled - advance returned",
    ...overrides,
  });
}

/** Simplified (B2C) invoice — the reporting path; no buyer required. */
export function simplifiedInvoice(overrides: Partial<EInvoiceInput> = {}): EInvoiceInput {
  return standardInvoice({
    invoiceNumber: "INV-S-0001",
    subtype: "simplified",
    buyer: null,
    ...overrides,
  });
}
