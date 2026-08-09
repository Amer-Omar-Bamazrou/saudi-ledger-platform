/**
 * The six compliance documents ZATCA requires when a CSR declares both invoice
 * types (TSCZ `1100`): standard invoice / credit note / debit note, and the same
 * three simplified.
 *
 * ── 🔴 THESE ARE TEST ARTIFACTS, NOT LEDGER ENTRIES ─────────────────────────
 * They are submitted to ZATCA to prove the solution can produce each document
 * type correctly. They never post to the GL, never consume an invoice number,
 * and never touch the tenant's books.
 *
 * That is why they do NOT require M12.1b. M12.1b is the *accounting* work for
 * credit/debit notes (the note→original DB reference, the reversed GL posting,
 * AR-aging and VAT-return treatment). The XML those notes need — `InvoiceTypeCode`
 * 381/383 and `cac:BillingReference` — has existed since M12.2.
 *
 * ⚠️ KNOWN COVERAGE GAP (closes with M12.1b): because these are built from
 * directly-constructed inputs, the DATABASE→note path is not exercised against
 * ZATCA. `einvoiceInput.assembler.ts` still hardcodes `billingReference: null`,
 * so a note assembled from real ledger rows has never been validated by ZATCA.
 */
import type { EInvoiceInput, EInvoiceParty } from "../types";

export interface ComplianceDocument {
  label: string;
  input: EInvoiceInput;
}

/**
 * A VAT-registered buyer is required for the STANDARD documents — a standard
 * (cleared) invoice is by definition B2B, and BR-KSA-10 requires the buyer's
 * full national address.
 */
function complianceBuyer(): EInvoiceParty {
  return {
    legalName: "Compliance Check Buyer",
    vatNumber: "399999999900003",
    identification: { schemeId: "CRN", value: "1010101010" },
    address: {
      buildingNumber: "1111",
      street: "Compliance Street",
      district: "Compliance District",
      city: "Riyadh",
      postalCode: "12345",
      additionalNumber: "1111",
      // BR-KSA-10 asserts cbc:CountrySubentity even though its message omits it.
      province: "Riyadh Region",
      countryCode: "SA",
    },
  };
}

const LINE = {
  id: 1,
  name: "Compliance check line",
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

/**
 * Build all six documents for one seller.
 *
 * ICVs are sequential within the compliance run and are deliberately NOT drawn
 * from the tenant's real invoice counter — a compliance document must not
 * consume a sequence number from the legally-required chain.
 */
export function complianceDocumentSet(opts: {
  seller: EInvoiceParty;
  uuid: () => string;
  issuedAt?: Date;
}): ComplianceDocument[] {
  const issuedAt = opts.issuedAt ?? new Date();
  const buyer = complianceBuyer();

  const base = (icv: number): EInvoiceInput => ({
    invoiceNumber: `COMPLIANCE-${icv}`,
    uuid: opts.uuid(),
    icv,
    // The genesis PIH — a compliance run starts its own chain.
    previousInvoiceHash:
      "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==",
    documentType: "invoice",
    subtype: "standard",
    issuedAt,
    currency: "SAR",
    seller: opts.seller,
    buyer,
    lines: [LINE],
    lineExtensionTotal: "1000.00",
    allowanceTotal: "0.00",
    taxExclusiveTotal: "1000.00",
    taxInclusiveTotal: "1150.00",
    prepaidAmount: "0.00",
    payableAmount: "1150.00",
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
  });

  const originalStandard = "COMPLIANCE-1";
  const originalSimplified = "COMPLIANCE-4";

  return [
    { label: "standard invoice", input: base(1) },
    {
      label: "standard credit note",
      input: {
        ...base(2),
        documentType: "credit_note",
        billingReference: { invoiceNumber: originalStandard },
        instructionNote: "Compliance check — credit note",
      },
    },
    {
      label: "standard debit note",
      input: {
        ...base(3),
        documentType: "debit_note",
        billingReference: { invoiceNumber: originalStandard },
        instructionNote: "Compliance check — debit note",
      },
    },
    { label: "simplified invoice", input: { ...base(4), subtype: "simplified", buyer: null } },
    {
      label: "simplified credit note",
      input: {
        ...base(5),
        subtype: "simplified",
        buyer: null,
        documentType: "credit_note",
        billingReference: { invoiceNumber: originalSimplified },
        instructionNote: "Compliance check — credit note",
      },
    },
    {
      label: "simplified debit note",
      input: {
        ...base(6),
        subtype: "simplified",
        buyer: null,
        documentType: "debit_note",
        billingReference: { invoiceNumber: originalSimplified },
        instructionNote: "Compliance check — debit note",
      },
    },
  ];
}
