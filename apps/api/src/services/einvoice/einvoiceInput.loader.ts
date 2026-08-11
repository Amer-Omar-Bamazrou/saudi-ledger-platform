/**
 * Load a ZATCA document model from REAL ledger rows (M12.1b).
 *
 * ── Why this did not exist before ───────────────────────────────────────────
 * `assembleEInvoiceInput` is a pure row→model mapper, and until now its ONLY
 * callers were tests using hand-built fixtures. Nothing in the product ever fed
 * it a database row, because issuance never wrote `icv`/`zatca_uuid` and the
 * assembler rejects a row without them — so the whole Phase-2 pipeline was
 * unreachable from real data.
 *
 * M12.1b assigns ICV/UUID at issuance, which makes this loader possible. It is
 * the seam the outbox (M12.6) and clearance/reporting will call.
 *
 * It resolves the note→original reference from the FK, so the ZATCA
 * `cac:BillingReference` always names the row it actually points at.
 */
import { NotFoundError } from "../../lib/errors";
import { invoicesRepository } from "../../repositories/invoices.repository";
import { companiesRepository } from "../../repositories/companies.repository";
import { customersRepository } from "../../repositories/customers.repository";
import { assembleEInvoiceInput } from "./einvoiceInput.assembler";
import type { EInvoiceInput } from "./types";

/**
 * Build the ZATCA document model for an ISSUED invoice, credit note or debit note.
 *
 * 🔴 `previousInvoiceHash` is a REQUIRED PARAMETER, not something this function
 * looks up (M12.8). It used to call `zatcaPreviousInvoiceHash` itself, which put
 * the chain-head read wherever the loader happened to be called — outside the
 * per-company sequence lock, and therefore outside the critical section that
 * makes the chain safe. Reading the head and writing the next document's hash is
 * read-then-write; if those straddle the lock boundary, two documents can claim
 * the same predecessor and FORK THE CHAIN.
 *
 * Passing it in makes the requirement type-enforced: a caller must already hold
 * a value, and the only production caller obtains it under
 * `invoicesRepository.lockCompanySequence`. Pass `null` for the first document
 * in a company's chain and the assembler substitutes ZATCA's genesis constant.
 */
export async function loadEInvoiceInput(
  invoiceId: number,
  previousInvoiceHash: string | null,
): Promise<EInvoiceInput> {
  const [invoice] = await invoicesRepository.findById(invoiceId);
  if (!invoice) throw new NotFoundError("Invoice not found");

  const [items, company] = await Promise.all([
    invoicesRepository.itemsByInvoice(invoiceId),
    companiesRepository.findById(invoice.companyId),
  ]);
  if (!company) throw new NotFoundError("Company not found");

  const customer = invoice.customerId
    ? (await customersRepository.findById(invoice.customerId))[0] ?? null
    : null;

  // The note's original — the FK, resolved to the row, so the billing reference
  // can never name a document that does not exist.
  const original = invoice.originalInvoiceId
    ? (await invoicesRepository.findById(invoice.originalInvoiceId))[0] ?? null
    : null;

  return assembleEInvoiceInput({
    invoice: {
      invoiceNumber: invoice.invoiceNumber,
      zatcaUuid: invoice.zatcaUuid,
      icv: invoice.icv,
      issuedAt: invoice.issuedAt,
      documentType: invoice.documentType,
      currency: invoice.currency,
      subtotal: invoice.subtotal,
      vatAmount: invoice.vatAmount,
      discount: invoice.discount,
      total: invoice.total,
      paidAmount: invoice.paidAmount,
      notes: invoice.notes,
      noteReason: invoice.noteReason,
    },
    originalInvoice: original ? { invoiceNumber: original.invoiceNumber } : null,
    items: items.map((it) => ({
      description: it.description,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      vatRate: it.vatRate,
      vatAmount: it.vatAmount,
      discount: it.discount,
      total: it.total,
      unitCode: it.unitCode,
      taxCategoryCode: it.taxCategoryCode,
      taxExemptionReasonCode: it.taxExemptionReasonCode,
      taxExemptionReasonText: it.taxExemptionReasonText,
    })),
    company: {
      name: company.name,
      vatNumber: company.vatNumber,
      crNumber: company.crNumber,
      buildingNumber: company.buildingNumber,
      street: company.street,
      district: company.district,
      city: company.city,
      postalCode: company.postalCode,
      additionalNumber: company.additionalNumber,
    },
    customer: customer
      ? {
          name: customer.name,
          taxNumber: customer.taxNumber,
          crNumber: customer.crNumber,
          buildingNumber: customer.buildingNumber,
          street: customer.street,
          district: customer.district,
          city: customer.city,
          postalCode: customer.postalCode,
          additionalNumber: customer.additionalNumber,
          province: customer.province,
          country: customer.country,
          nationalId: customer.nationalId,
        }
      : null,
    /**
     * 🔴 THE ZATCA PIH — deliberately NOT `invoices.previous_hash`.
     *
     * `invoices.invoice_hash` / `previous_hash` hold the HOMEGROWN chain
     * (hex SHA-256 of a pipe-joined string, genesis `"GENESIS"`). ZATCA's PIH is
     * the base64 SHA-256 of the canonical XML. They share nothing — the landmine
     * recorded in CLAUDE.md.
     *
     * Feeding the legacy value here fails LOUDLY on the first document of a
     * chain (`'GENESIS' is not a valid value for 'base64Binary'` — an XSD
     * rejection, found exactly this way) and, worse, SILENTLY afterwards: a
     * 64-character hex string is accidentally well-formed base64, so ZATCA
     * accepts a PIH that means nothing.
     *
     * The real ZATCA chain lives in `einvoice_documents`. It is resolved by the
     * caller under the per-company sequence lock — see this function's contract.
     */
    previousInvoiceHash,
  });
}
