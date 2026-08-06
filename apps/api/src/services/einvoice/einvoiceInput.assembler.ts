/**
 * Assembles an {@link EInvoiceInput} from our domain rows (M12.2).
 *
 * This is the ONLY place that knows both our schema and the ZATCA document
 * model, which keeps `buildInvoiceXml` a pure function of plain data. The
 * mapping function itself is pure too — it takes rows, not ids — so the whole
 * translation can be unit-tested without a database.
 */
import { BusinessRuleError } from "../../lib/errors";
import { GENESIS_PIH } from "./ubl/buildInvoiceXml";
import type {
  EInvoiceInput,
  EInvoiceLine,
  EInvoiceParty,
  EInvoiceSubtype,
  NationalAddress,
  TaxCategoryCode,
  TaxSubtotal,
} from "./types";

/**
 * Money → the exact string that goes on the wire (and gets signed).
 *
 * Guarded against silent IEEE-754 precision loss. `numeric(15,2)` in Postgres
 * exceeds JavaScript's exact-integer range (2^53), so a large enough total would
 * round on conversion — and because this string is what gets hashed and signed,
 * the resulting document would be internally consistent but WRONG, with no error
 * anywhere. Unreachable in practice (the bound is ~SAR 90 trillion) but the check
 * costs nothing and turns an invisible corruption into a loud failure.
 */
export function money(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) {
    throw new BusinessRuleError(400, {
      error: `Invoice amount "${String(value)}" is not a finite number.`,
      code: "amount_not_finite",
    });
  }
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER / 100) {
    throw new BusinessRuleError(400, {
      error:
        `Invoice amount ${n} is too large to represent exactly, so the value that would be ` +
        "signed could differ from the value stored. Split the invoice.",
      code: "amount_exceeds_safe_precision",
    });
  }
  return n.toFixed(2);
}

/** VAT percent, e.g. 15 → "15.00". */
function percent(value: unknown): string {
  return Number(value ?? 0).toFixed(2);
}

const VALID_CATEGORIES: readonly string[] = ["S", "Z", "E", "O"];

export interface AssembleRows {
  invoice: {
    invoiceNumber: string;
    zatcaUuid: string | null;
    icv: number | null;
    issuedAt: Date | null;
    documentType: string;
    currency: string | null;
    subtotal: unknown;
    vatAmount: unknown;
    discount: unknown;
    total: unknown;
    paidAmount: unknown;
    notes: string | null;
  };
  items: Array<{
    description: string;
    quantity: unknown;
    unitPrice: unknown;
    vatRate: unknown;
    vatAmount: unknown;
    discount: unknown;
    total: unknown;
    unitCode: string | null;
    taxCategoryCode: string | null;
    taxExemptionReasonCode: string | null;
    taxExemptionReasonText: string | null;
  }>;
  company: {
    name: string;
    vatNumber: string | null;
    crNumber: string | null;
    buildingNumber: string | null;
    street: string | null;
    district: string | null;
    city: string | null;
    postalCode: string | null;
    additionalNumber: string | null;
  };
  customer: {
    name: string;
    taxNumber: string | null;
    crNumber: string | null;
    buildingNumber: string | null;
    street: string | null;
    district: string | null;
    city: string | null;
    postalCode: string | null;
    additionalNumber: string | null;
    /** BR-KSA-10 requires this on the buyer of a STANDARD invoice. */
    province: string | null;
    country: string | null;
  } | null;
  previousInvoiceHash: string | null;
}

function addressOf(src: {
  buildingNumber: string | null;
  street: string | null;
  district: string | null;
  city: string | null;
  postalCode: string | null;
  additionalNumber: string | null;
  province?: string | null;
  country?: string | null;
}): NationalAddress {
  return {
    buildingNumber: src.buildingNumber,
    street: src.street,
    district: src.district,
    city: src.city,
    postalCode: src.postalCode,
    additionalNumber: src.additionalNumber,
    province: src.province ?? null,
    countryCode: src.country ?? "SA",
  };
}

/**
 * Standard (B2B) vs simplified (B2C) is decided by whether the BUYER is
 * VAT-registered — that is the substantive distinction ZATCA draws, and it also
 * decides clearance vs reporting. A buyer with a VAT number is a business.
 */
export function subtypeFor(customerVatNumber: string | null | undefined): EInvoiceSubtype {
  return customerVatNumber ? "standard" : "simplified";
}

/**
 * Group lines into document-level tax subtotals, one bucket per
 * (category, percent). ZATCA validates the breakdown against the line sums.
 */
function buildSubtotals(lines: EInvoiceLine[]): TaxSubtotal[] {
  const buckets = new Map<string, TaxSubtotal>();
  for (const l of lines) {
    const key = `${l.taxCategory}|${l.taxPercent}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.taxableAmount = money(Number(existing.taxableAmount) + Number(l.lineExtensionAmount));
      existing.taxAmount = money(Number(existing.taxAmount) + Number(l.taxAmount));
    } else {
      buckets.set(key, {
        taxableAmount: l.lineExtensionAmount,
        taxAmount: l.taxAmount,
        category: l.taxCategory,
        percent: l.taxPercent,
        exemptionReasonCode: l.taxExemptionReasonCode,
        exemptionReasonText: l.taxExemptionReasonText,
      });
    }
  }
  return [...buckets.values()];
}

/**
 * Map domain rows to the ZATCA document model.
 *
 * FAILS CLOSED on anything that would produce a legally-invalid document rather
 * than substituting a default — the M11.6 principle. In particular a line whose
 * `tax_category_code` is NULL (the ambiguous 0%-VAT case M12.1a deliberately
 * left unbackfilled) is rejected here with an actionable error instead of being
 * guessed at.
 */
export function assembleEInvoiceInput(rows: AssembleRows): EInvoiceInput {
  const { invoice, items, company, customer } = rows;

  if (!invoice.zatcaUuid) throw new BusinessRuleError(400, { error: "Invoice has no ZATCA UUID.", code: "missing_uuid" });
  if (invoice.icv == null) throw new BusinessRuleError(400, { error: "Invoice has no ICV.", code: "missing_icv" });
  if (!invoice.issuedAt) throw new BusinessRuleError(400, { error: "Invoice has no issuance timestamp.", code: "missing_issued_at" });
  if (!company.vatNumber) {
    throw new BusinessRuleError(400, {
      error: "Your company's VAT registration number is required to issue an invoice.",
      code: "company_vat_missing",
    });
  }

  const lines: EInvoiceLine[] = items.map((it, i) => {
    const category = it.taxCategoryCode;
    if (!category || !VALID_CATEGORIES.includes(category)) {
      // The ambiguous 0%-VAT case: zero-rated and exempt are different tax
      // treatments and the data does not distinguish them. Demand an answer.
      throw new BusinessRuleError(400, {
        error:
          `Line ${i + 1} ("${it.description}") has no VAT tax category. ` +
          "Set it to S (standard), Z (zero-rated), E (exempt) or O (out of scope) before issuing.",
        code: "line_tax_category_missing",
      });
    }
    const cat = category as TaxCategoryCode;
    if (cat !== "S" && !it.taxExemptionReasonCode && !it.taxExemptionReasonText) {
      throw new BusinessRuleError(400, {
        error: `Line ${i + 1} ("${it.description}") is ${cat}-rated and needs a VAT exemption reason.`,
        code: "line_exemption_reason_missing",
      });
    }

    const net = Number(it.total ?? 0) - Number(it.vatAmount ?? 0);
    return {
      id: i + 1,
      name: it.description,
      quantity: String(Number(it.quantity ?? 1)),
      unitCode: it.unitCode ?? "PCE",
      unitPrice: money(it.unitPrice),
      lineExtensionAmount: money(net),
      discountAmount: money(it.discount),
      taxCategory: cat,
      taxPercent: percent(it.vatRate),
      taxAmount: money(it.vatAmount),
      lineTotalWithTax: money(it.total),
      taxExemptionReasonCode: it.taxExemptionReasonCode,
      taxExemptionReasonText: it.taxExemptionReasonText,
    };
  });

  const seller: EInvoiceParty = {
    legalName: company.name,
    vatNumber: company.vatNumber,
    identification: company.crNumber ? { schemeId: "CRN", value: company.crNumber } : null,
    address: addressOf(company),
  };

  const buyer: EInvoiceParty | null = customer
    ? {
        legalName: customer.name,
        vatNumber: customer.taxNumber,
        identification: customer.crNumber ? { schemeId: "CRN", value: customer.crNumber } : null,
        address: addressOf(customer),
      }
    : null;

  const documentType =
    invoice.documentType === "credit_note" || invoice.documentType === "debit_note"
      ? (invoice.documentType as "credit_note" | "debit_note")
      : "invoice";

  return {
    invoiceNumber: invoice.invoiceNumber,
    uuid: invoice.zatcaUuid,
    icv: invoice.icv,
    previousInvoiceHash: rows.previousInvoiceHash ?? GENESIS_PIH,
    documentType,
    subtype: subtypeFor(customer?.taxNumber),
    issuedAt: invoice.issuedAt,
    currency: invoice.currency ?? "SAR",
    seller,
    buyer,
    lines,
    lineExtensionTotal: money(invoice.subtotal),
    allowanceTotal: money(invoice.discount),
    taxExclusiveTotal: money(invoice.subtotal),
    taxInclusiveTotal: money(invoice.total),
    prepaidAmount: money(invoice.paidAmount),
    payableAmount: money(Number(invoice.total ?? 0) - Number(invoice.paidAmount ?? 0)),
    taxTotal: money(invoice.vatAmount),
    taxSubtotals: buildSubtotals(lines),
    paymentMeansCode: "30", // credit transfer — the safe default (BR-KSA-16)
    billingReference: null, // credit/debit note reference arrives with M12.1b
    instructionNote: null,
    notes: invoice.notes,
  };
}
