/**
 * Quotation → invoice conversion (M21.2).
 *
 * ── 🔴 THE RULE THIS FILE MUST NOT BREAK ────────────────────────────────────
 * Conversion is NOT a posting path. It builds the input for
 * `invoicesService.create` and calls it — the same function the manual invoice
 * form calls, so approval, GL posting, the hash chain, ICV allocation and
 * ZATCA issuance all behave exactly as they do for a hand-typed invoice.
 * There is deliberately no `postJournalEntry` in this file, and there must
 * never be one: that would be a second writer for an effect that already has
 * one, which is the failure mode meta-finding #9 was about.
 *
 * The precedent is A3's recurring generator, which does the same thing from a
 * different trigger (`generation.service.ts` → `invoicesService.create`).
 *
 * ── What conversion records ─────────────────────────────────────────────────
 * A DATED event with per-line quantities, written in the SAME tenant
 * transaction as the invoice. If the invoice creation throws, the tenant
 * transaction rolls back and no conversion row survives claiming an invoice
 * that does not exist. (`lib/tenant.ts` wraps each request in one transaction;
 * this service does not open its own, which is what makes the two atomic.)
 *
 * ── Price freezing ──────────────────────────────────────────────────────────
 * Line values are COPIED from the quotation, never re-read from `products`.
 * A quoted price is a commitment; re-reading would silently honour a different
 * price than the one the customer agreed to.
 */
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors";
import { assertAmount, assertDateString } from "../lib/writeGuards";
import { quotationsRepository } from "../repositories/quotations.repository";
import { invoicesService } from "./invoices.service";
import { auditService } from "./audit.service";

export interface ConvertLineInput {
  quotationItemId: number;
  quantity: number;
}

export interface ConvertQuotationInput {
  /** Omit to convert everything still outstanding — the common case. */
  lines?: ConvertLineInput[];
  /** The invoice's accounting date. Defaults to today. */
  date?: string;
  dueDate?: string;
  /** The date the customer ACCEPTED. Defaults to the invoice date. */
  convertedOn?: string;
  /** Optional override; otherwise allocated server-side. */
  invoiceNumber?: string;
  notes?: string;
}

/** Tolerance matching numeric(15,3): half of the smallest representable unit. */
const QTY_EPSILON = 0.0005;

export const quotationConversionService = {
  /**
   * Convert part or all of a quotation into an invoice.
   *
   * @param autoApprove whether the produced invoice is issued immediately.
   *   🔴 Resolved from the caller's `invoices:approve` grant, NOT
   *   `quotations:approve` — what is being issued is an INVOICE, so the
   *   authority that matters is authority over invoices. A bookkeeper may
   *   convert (it is ordinary work) and gets a draft an approver still has to
   *   issue.
   */
  async convert(
    quotationId: number,
    input: ConvertQuotationInput,
    userId: number | null,
    opts: { autoApprove?: boolean } = {},
  ) {
    const [quotation] = await quotationsRepository.findById(quotationId);
    if (!quotation) throw new NotFoundError("Not found");

    // ── Eligibility ────────────────────────────────────────────────────────
    if (quotation.status !== "approved") {
      throw new ConflictError(
        "Only an approved quotation can be converted. Approve it first — issuing a price to a customer is what approval means.",
      );
    }
    if (quotation.outcome) {
      throw new ConflictError(
        `This quotation was ${quotation.outcome}. Reopen it before converting.`,
      );
    }
    // 🔴 An EXPIRED quotation is deliberately NOT blocked. `valid_until` having
    // passed is a fact the UI warns on; a customer accepting a lapsed quote is
    // a commercial decision, and refusing it here would be the software
    // overruling the business (design §8.8).

    const items = await quotationsRepository.itemsByQuotation(quotationId);
    if (items.length === 0) throw new BadRequestError("This quotation has no lines to convert.");

    const alreadyConverted = await quotationsRepository.convertedQuantities(quotationId);
    const remainingFor = (itemId: number, quantity: number) =>
      quantity - (alreadyConverted.get(itemId) ?? 0);

    // ── Resolve what is being taken ────────────────────────────────────────
    // No `lines` supplied ⇒ everything still outstanding. That is the one-click
    // "the customer accepted the whole thing" case, and it must not silently
    // re-convert what has already been invoiced.
    let requested: { item: (typeof items)[number]; quantity: number }[];
    if (input.lines === undefined) {
      requested = items
        .map((item) => ({ item, quantity: remainingFor(item.id, Number(item.quantity)) }))
        .filter((r) => r.quantity > QTY_EPSILON);
      if (requested.length === 0) {
        throw new ConflictError("Every line on this quotation has already been converted.");
      }
    } else {
      if (!Array.isArray(input.lines) || input.lines.length === 0) {
        throw new BadRequestError("Select at least one line to convert.");
      }
      const byId = new Map(items.map((i) => [i.id, i]));
      const seen = new Set<number>();
      requested = input.lines.map((line, idx) => {
        const item = byId.get(Number(line.quotationItemId));
        if (!item) {
          throw new BadRequestError(`Line ${idx + 1} does not belong to this quotation.`);
        }
        if (seen.has(item.id)) {
          // Two entries for one line would silently sum, making the 409 below
          // depend on the caller's formatting rather than the arithmetic.
          throw new BadRequestError(`Line ${idx + 1} appears more than once.`);
        }
        seen.add(item.id);
        const quantity = assertAmount(line.quantity, `line ${idx + 1} quantity`, { min: 0, allowZero: true });
        if (quantity <= 0) throw new BadRequestError(`Line ${idx + 1} quantity must be greater than zero.`);
        return { item, quantity };
      });
    }

    // ── 🔴 Over-conversion is REFUSED, the same posture as overpaying an
    // invoice (`invoicesService.pay` 409s). Converting more than was quoted is
    // not a rounding question: it means the invoice would claim the customer
    // agreed to something they were never offered.
    for (const { item, quantity } of requested) {
      const remaining = remainingFor(item.id, Number(item.quantity));
      if (quantity > remaining + QTY_EPSILON) {
        throw new ConflictError(
          `Cannot convert ${quantity} of "${item.description}" — only ${Math.max(0, remaining)} remain${remaining === 1 ? "s" : ""} on this quotation.`,
        );
      }
    }

    const date = input.date ?? new Date().toISOString().slice(0, 10);
    assertDateString(date, "date");
    if (input.dueDate != null) assertDateString(input.dueDate, "dueDate");
    const convertedOn = input.convertedOn ?? date;
    assertDateString(convertedOn, "convertedOn");

    // ── Build the invoice body ─────────────────────────────────────────────
    // 🔴 PRICES ARE COPIED, not looked up. `unitPrice`, `vatRate`, and the tax
    // category come from the quotation line as quoted. `productId` is carried
    // for reporting, but it is NOT used to re-derive a price.
    //
    // The per-line `discount` is scaled to the converted proportion: a 100 SAR
    // discount on 10 units is 40 SAR when 4 are invoiced. Not scaling it would
    // apply the WHOLE discount to a partial invoice, and the customer would be
    // undercharged by a real amount on the first conversion and overcharged on
    // the rest.
    const invoiceItems = requested.map(({ item, quantity }) => {
      const quotedQty = Number(item.quantity);
      const proportion = quotedQty > 0 ? quantity / quotedQty : 0;
      const scaledDiscount = Math.round(Number(item.discount ?? 0) * proportion * 100) / 100;
      return {
        productId: item.productId,
        description: item.description,
        descriptionAr: item.descriptionAr,
        quantity,
        unitPrice: Number(item.unitPrice),
        vatRate: Number(item.vatRate ?? 15),
        discount: scaledDiscount,
        taxCategoryCode: item.taxCategoryCode ?? undefined,
        unitCode: item.unitCode,
      };
    });

    const invoiceNumber =
      input.invoiceNumber?.trim() || (await quotationsRepository.nextInvoiceNumber(date));

    const invoice = await invoicesService.create(
      {
        invoiceNumber,
        date,
        dueDate: input.dueDate,
        customerId: quotation.customerId,
        currency: quotation.currency,
        notes: input.notes ?? `Converted from quotation ${quotation.quotationNumber}`,
        termsAndConditions: quotation.termsAndConditions,
        items: invoiceItems,
      },
      userId,
      { autoApprove: opts.autoApprove ?? false },
    );

    // ── Record the event, in this same transaction ─────────────────────────
    const [conversion] = await quotationsRepository.insertConversion({
      quotationId,
      invoiceId: invoice.id,
      convertedOn,
      convertedBy: userId ?? null,
    } as never);

    await quotationsRepository.insertConversionItems(
      requested.map(({ item, quantity }) => ({
        conversionId: conversion.id,
        quotationItemId: item.id,
        quantity: String(quantity),
      })) as never,
    );

    await auditService.created("quotation_conversion", conversion.id, {
      quotationId,
      invoiceId: invoice.id,
      convertedOn,
      lines: requested.map(({ item, quantity }) => ({ quotationItemId: item.id, quantity })),
    });

    return { conversion: { id: conversion.id, convertedOn }, invoice };
  },

  /** The dated history: what became an invoice, when, and which invoice. */
  async history(quotationId: number) {
    const [quotation] = await quotationsRepository.findById(quotationId);
    if (!quotation) throw new NotFoundError("Not found");
    const rows = await quotationsRepository.conversions(quotationId);
    return rows.map((r) => ({
      id: r.conv.id,
      convertedOn: r.conv.convertedOn,
      invoiceId: r.conv.invoiceId,
      invoiceNumber: r.inv?.invoiceNumber ?? null,
      invoiceStatus: r.inv?.status ?? null,
      invoiceTotal: r.inv ? Number(r.inv.total) : null,
    }));
  },
};
