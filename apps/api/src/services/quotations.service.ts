/**
 * Quotations service (M21.1).
 *
 * 🔴 THE INVARIANT THIS FILE EXISTS TO PROTECT: a quotation moves NOTHING.
 * There is no `postJournalEntry` call here, no period-lock check, no AR, no
 * VAT return effect, at any status. A quotation dated inside a CLOSED period
 * is deliberately allowed — the lock protects the ledger, and a quotation
 * never reaches it. If a future change adds a ledger effect to this file, the
 * zero-movement tests will fail, and they should.
 *
 * Totals arithmetic is copied EXACTLY from `invoices.service.ts` (round each
 * line, then sum the rounded values) rather than re-derived. Not laziness —
 * conversion turns these lines into invoice lines, and if the two used
 * different rounding, a converted quotation and its invoice would disagree by
 * halalas on mixed-rate documents. Same reason the invoice header is Σ rounded
 * lines rather than a rounded Σ.
 */
import { ConflictError, NotFoundError, BadRequestError, BusinessRuleError } from "../lib/errors";
import { pick, assertAmount, assertRate, assertDateString, assertTaxCategoryCode } from "../lib/writeGuards";
import { customersRepository } from "../repositories/customers.repository";

/**
 * MED (audit 2026-08-20) class fix: FK checks run outside RLS, so a
 * nonexistent OR other-tenant customerId reached the FK — see the full note
 * in invoices.service. Same 422 here so the sibling path cannot disagree.
 */
async function assertCustomerExists(customerId: unknown): Promise<void> {
  if (customerId == null) return;
  const [c] = await customersRepository.findById(Number(customerId));
  if (!c) {
    throw new BusinessRuleError(422, {
      error: `Customer ${customerId} does not exist for this organization.`,
      code: "reference_not_found",
      field: "customerId",
    });
  }
}
import { auditService } from "./audit.service";
import { approvalService } from "./approval";
import { quotationApprovable } from "./quotations.approvable";
import { quotationsRepository, type QuotationListFilter } from "../repositories/quotations.repository";
import { buildQuotationOut } from "./quotations.presenter";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Header fields a client may set. Everything else is derived or minted. */
const QUOTATION_FIELDS = [
  "date", "validUntil", "customerId", "currency", "discount",
  "notes", "termsAndConditions",
] as const;

/**
 * Compute line values and header totals.
 *
 * `taxCategoryCode`: the invoice rule (positive rate ⇒ 'S'; 0% left NULL
 * because zero-rated / exempt / out-of-scope are different tax facts an
 * amount cannot distinguish). 🔴 Unlike an invoice this NEVER fails closed —
 * a quotation is not issued to ZATCA, and the single tax gate stays at invoice
 * creation. Carrying the code means conversion has something to hand over.
 */
function prepareItems(items: any[]) {
  let subtotal = 0;
  let vatTotal = 0;
  const prepared = items.map((it: any) => {
    const lineTotal = Number(it.quantity) * Number(it.unitPrice);
    const disc = Number(it.discount ?? 0);
    const base = round2(lineTotal - disc);
    const vatRate = Number(it.vatRate ?? 15);
    const vat = round2(base * (vatRate / 100));
    subtotal = round2(subtotal + base);
    vatTotal = round2(vatTotal + vat);
    return {
      productId: it.productId ?? null,
      description: String(it.description ?? ""),
      ...(it.descriptionAr ? { descriptionAr: String(it.descriptionAr) } : {}),
      quantity: String(it.quantity),
      unitPrice: String(it.unitPrice),
      vatRate: String(vatRate),
      vatAmount: vat.toFixed(2),
      discount: disc.toFixed(2),
      total: round2(base + vat).toFixed(2),
      taxCategoryCode: it.taxCategoryCode ?? (vatRate > 0 ? "S" : null),
      ...(it.unitCode ? { unitCode: String(it.unitCode) } : {}),
    };
  });
  return { prepared, subtotal, vatTotal };
}

function validateItems(items: any[]) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new BadRequestError("A quotation needs at least one line.");
  }
  items.forEach((it, i) => {
    if (!it || typeof it.description !== "string" || !it.description.trim()) {
      throw new BadRequestError(`Line ${i + 1} needs a description.`);
    }
    // 🔴 The `> 0` is checked explicitly, NOT via `assertAmount(.., {min: 0})`.
    // That helper's guard is `n < min`, so `min: 0` ACCEPTS zero — a reading
    // that would have let a zero-quantity line through the service and been
    // caught only by the DB CHECK, as a raw 500 instead of a named 400.
    // A zero-quantity line is not a line, and conversion (M21.2) reads these
    // quantities as the ceiling on what may be taken.
    const qty = assertAmount(it.quantity, `line ${i + 1} quantity`, { min: 0, allowZero: true });
    if (qty <= 0) throw new BadRequestError(`Line ${i + 1} quantity must be greater than zero.`);
    assertAmount(it.unitPrice, `line ${i + 1} unit price`, { min: 0, allowZero: true });
    if (it.discount != null) assertAmount(it.discount, `line ${i + 1} discount`, { min: 0, allowZero: true });
    if (it.vatRate != null) assertRate(it.vatRate, `line ${i + 1} VAT rate`);
    // MED (audit 2026-08-20): validated here too, not only at invoice
    // creation — a garbage code stored now would refuse CONVERSION later,
    // surfacing the error months from the act that caused it.
    assertTaxCategoryCode(it.taxCategoryCode, `line ${i + 1} taxCategoryCode`);
  });
}

/**
 * Refuse an edit that would rewrite a line the customer has already accepted.
 *
 * Compares against the quantities and prices as STORED, using the same 3-dp /
 * 2-dp tolerances the columns use — so a re-submitted "10" vs "10.000" is not
 * treated as a change, while a real price move is.
 */
async function assertConvertedLinesUnchanged(quotationId: number, incoming: any[]) {
  const converted = await quotationsRepository.convertedQuantities(quotationId);
  if (converted.size === 0) return;

  const existing = await quotationsRepository.itemsByQuotation(quotationId);
  const incomingById = new Map<number, any>();
  for (const line of incoming) {
    if (line?.id != null) incomingById.set(Number(line.id), line);
  }

  for (const item of existing) {
    const convertedQty = converted.get(item.id) ?? 0;
    if (convertedQty <= 0) continue;

    const line = incomingById.get(item.id);
    if (!line) {
      throw new ConflictError(
        `"${item.description}" has already been invoiced and cannot be removed from this quotation.`,
      );
    }
    if (Math.abs(Number(line.quantity) - Number(item.quantity)) > 0.0005) {
      throw new ConflictError(
        `"${item.description}" has already been invoiced; its quantity can no longer be changed.`,
      );
    }
    if (Math.abs(Number(line.unitPrice) - Number(item.unitPrice)) > 0.005) {
      throw new ConflictError(
        `"${item.description}" has already been invoiced at ${Number(item.unitPrice)}; its price can no longer be changed. Correct the invoice with a credit note instead.`,
      );
    }
  }
}

export const quotationsService = {
  async list(filter: QuotationListFilter) {
    const rows = await quotationsRepository.list(filter);
    return rows.map((r) => buildQuotationOut(r.quo, r.cust));
  },

  async getById(id: number) {
    const [row] = await quotationsRepository.findWithCustomer(id);
    if (!row) throw new NotFoundError("Not found");
    const items = await quotationsRepository.itemsByQuotation(id);
    // M21.2: converted quantities are DERIVED here, from the conversion rows.
    // There is no column to read — see the schema header.
    const converted = await quotationsRepository.convertedQuantities(id);
    return buildQuotationOut(row.quo, row.cust, items, converted);
  },

  /**
   * Create a quotation as a DRAFT. `autoApprove` (from the RBAC matrix, the
   * same seam invoices use) issues it in one call for a caller who holds
   * approve rights — so an owner quoting a customer does it in one click while
   * a bookkeeper's quotation queues for review.
   */
  async create(body: Record<string, any>, userId: number | null, opts: { autoApprove?: boolean } = {}) {
    const { items = [] } = body;
    validateItems(items);

    const header = pick<Record<string, unknown>>(body, [...QUOTATION_FIELDS]) as Record<string, any>;
    const date = header.date ?? new Date().toISOString().slice(0, 10);
    assertDateString(date, "date");
    if (header.validUntil != null) assertDateString(header.validUntil, "validUntil");
    if (header.discount != null) assertAmount(header.discount, "discount", { min: 0, allowZero: true });
    await assertCustomerExists(header.customerId);

    // 🔴 NO period-lock check, deliberately. A closed period protects the
    // ledger; a quotation never touches it. Blocking here would refuse a
    // legitimate offer for an accounting reason that does not apply.

    const { prepared, subtotal, vatTotal } = prepareItems(items);
    const total = round2(subtotal + vatTotal - Number(header.discount ?? 0));

    const quotationNumber = await quotationsRepository.nextNumber(date);

    const [quo] = await quotationsRepository.insert({
      ...header,
      date,
      quotationNumber,
      subtotal: subtotal.toFixed(2),
      vatAmount: vatTotal.toFixed(2),
      total: total.toFixed(2),
      status: "draft",
      createdBy: userId ?? null,
    } as any);

    await quotationsRepository.insertItems(prepared.map((p) => ({ ...p, quotationId: quo.id })) as any);
    await auditService.created("quotation", quo.id, quo);

    if (opts.autoApprove) {
      return approvalService.approve(quotationApprovable(), quo.id, { userId: userId ?? null });
    }
    return this.getById(quo.id);
  },

  /**
   * Edit a quotation.
   *
   * Editable while `draft` (the enterer's own work) AND while `approved` — the
   * latter is a deliberate DIFFERENCE from invoices, and the reason is that a
   * quotation is not a legal document: renegotiating a price the customer has
   * not yet accepted is normal business, not a correction requiring a credit
   * note. `submitted` is locked because it is sitting in someone's queue.
   *
   * 🔴 THE FREEZE RULE (M21.2). A line with ANY conversion against it is
   * frozen — the invoice it produced already quotes those numbers, and the
   * invoice is the legal document. Untouched lines stay editable, because
   * renegotiating the part the customer has not accepted is exactly what a
   * live quotation is for.
   *
   * Since lines are replaced wholesale on edit, the check is: every line that
   * has been converted must still be present, with the SAME quantity and
   * price. Anything else would silently rewrite what was agreed.
   *
   * 🔴 Editing NEVER cascades to a produced invoice. If the invoice is wrong
   * it is corrected by credit note — the existing mechanism. Do not add a
   * cascade here.
   */
  async update(id: number, data: Record<string, any>) {
    const [existing] = await quotationsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status === "submitted") {
      throw new ConflictError("A submitted quotation is locked while it awaits approval. Ask for it to be sent back.");
    }
    if (existing.outcome) {
      throw new ConflictError(`This quotation was ${existing.outcome} and can no longer be edited.`);
    }

    const values = pick<Record<string, unknown>>(data, [...QUOTATION_FIELDS, "reviewNote"]) as Record<string, any>;
    if (values.date !== undefined) assertDateString(values.date, "date");
    if (values.validUntil != null) assertDateString(values.validUntil, "validUntil");
    if (values.discount != null) assertAmount(values.discount, "discount", { min: 0, allowZero: true });
    await assertCustomerExists(values.customerId);

    // Lines are replaced wholesale when supplied — the same shape the invoice
    // editor uses, and totals are always recomputed from them so the header
    // cannot drift from the lines it claims to sum.
    if (data.items !== undefined) {
      validateItems(data.items);
      await assertConvertedLinesUnchanged(id, data.items);
      const { prepared, subtotal, vatTotal } = prepareItems(data.items);
      values.subtotal = subtotal.toFixed(2);
      values.vatAmount = vatTotal.toFixed(2);
      values.total = round2(subtotal + vatTotal - Number(values.discount ?? existing.discount ?? 0)).toFixed(2);

      // 🔴 Lines are RECONCILED BY ID, not replaced wholesale.
      //
      // The obvious implementation — delete every line, insert the new set —
      // was what this did before conversions existed, and it is wrong the
      // moment one does: a converted line would be deleted (raising the
      // RESTRICT FK from `quotation_conversion_items` as a raw 500) and, if it
      // somehow succeeded, re-inserted with a NEW id, orphaning the record of
      // what the customer accepted. Keeping ids stable is what makes the
      // conversion history point at the right line.
      const existingItems = await quotationsRepository.itemsByQuotation(id);
      const existingIds = new Set(existingItems.map((i) => i.id));
      const keptIds = new Set<number>();

      for (let idx = 0; idx < prepared.length; idx++) {
        const incomingId = data.items[idx]?.id;
        if (incomingId != null && existingIds.has(Number(incomingId))) {
          keptIds.add(Number(incomingId));
          await quotationsRepository.updateItem(Number(incomingId), prepared[idx] as never);
        } else {
          await quotationsRepository.insertItems([{ ...prepared[idx], quotationId: id }] as never);
        }
      }

      const removed = [...existingIds].filter((existingId) => !keptIds.has(existingId));
      await quotationsRepository.deleteItemsByIds(removed);
    } else if (values.discount != null) {
      // Header discount changed without touching lines: total must follow.
      values.total = round2(
        Number(existing.subtotal) + Number(existing.vatAmount) - Number(values.discount),
      ).toFixed(2);
    }

    const [updated] = await quotationsRepository.update(id, values);
    await auditService.updated("quotation", id, existing, updated);
    return this.getById(id);
  },

  submit(id: number, userId: number | null) {
    return approvalService.submit(quotationApprovable(), id, { userId: userId ?? null });
  },

  approve(id: number, userId: number | null) {
    return approvalService.approve(quotationApprovable(), id, { userId: userId ?? null });
  },

  sendBack(id: number, userId: number | null, note?: string) {
    return approvalService.sendBack(quotationApprovable(), id, { userId: userId ?? null }, note);
  },

  reject(id: number, userId: number | null) {
    return approvalService.reject(quotationApprovable(), id, { userId: userId ?? null });
  },

  /**
   * Record the tenant's terminal act: the customer declined, or the remainder
   * is being abandoned.
   *
   * 🔴 This is the ONLY way a quotation stops being live. The platform never
   * infers it — not from expiry, not from age, not from a full conversion.
   * A remainder is dead when the tenant says so, because only they know
   * whether the customer is still deciding (design §8.2, the M17.1 posture).
   */
  async setOutcome(id: number, outcome: "declined" | "closed", userId: number | null) {
    const [existing] = await quotationsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "approved") {
      throw new ConflictError("Only an issued quotation can be declined or closed.");
    }
    if (existing.outcome) {
      throw new ConflictError(`This quotation is already ${existing.outcome}.`);
    }
    const [updated] = await quotationsRepository.update(id, { outcome });
    await auditService.updated("quotation", id, existing, updated);
    void userId;
    return this.getById(id);
  },

  /** Reopen a quotation the tenant closed or declined in error. */
  async reopen(id: number) {
    const [existing] = await quotationsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (!existing.outcome) throw new ConflictError("This quotation is already live.");
    const [updated] = await quotationsRepository.update(id, { outcome: null });
    await auditService.updated("quotation", id, existing, updated);
    return this.getById(id);
  },

  async remove(id: number) {
    const [existing] = await quotationsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    // A converted quotation is the record of what the customer agreed to, and
    // an invoice points at it. The FK would refuse this anyway; a named 409
    // beats a raw 500 (the audit's 500-where-4xx family).
    if (await quotationsRepository.hasConversions(id)) {
      throw new ConflictError(
        "This quotation has been converted into an invoice and cannot be deleted. Close it instead.",
      );
    }
    await quotationsRepository.deleteItems(id);
    await quotationsRepository.delete(id);
    await auditService.deleted("quotation", id, existing);
    return { deleted: true };
  },
};
