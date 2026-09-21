/**
 * AP-2 (2026-09-21) — THE ADVANCE TAX INVOICE (ZATCA type 386).
 *
 * Decision record: docs/product/advance-payments-decision-pack.md §4 (the
 * texts), §6 E2/E3 (the entries — accountant A2), §14 (as built). What this
 * file does:
 *
 *   createFromReceipt()   a DRAFT 386 for part or all of a receipt's deposit
 *                         that the business has classified as an ADVANCE for
 *                         a taxable supply (AP-1's record — one classification
 *                         model, never a second). Amount is VAT-INCLUSIVE
 *                         (Agreement Art. 23(1): tax is due "to the extent of
 *                         the received amount"); the line is the split at the
 *                         classification's category. Nothing posts here —
 *                         approval (`invoices.approvable`) mints the ICV, the
 *                         hash, the QR, the e-invoice and the E2 entry.
 *   openForCustomer()     the issued 386s a final invoice may still adjust.
 *   figuresFor()          invoiced / adjusted / open / uninvoiced per receipt.
 *   assertWithinUninvoiced()
 *                         the guard D-4 allocate and refund call: a receipt's
 *                         386-invoiced remainder is reserved for the final
 *                         invoice's prepayment adjustment or a credit note on
 *                         the 386; touching it any other way would leave
 *                         declared VAT against cash that has gone.
 *   creditAdvance()       AP-3 (2026-09-21): a DRAFT `advance_credit_note`
 *                         (ZATCA 381, billing reference = the 386 — BR-KSA-56;
 *                         reason — BR-KSA-17) for part or all of the 386's
 *                         OPEN balance: the advance is cancelled before its
 *                         supply (Guideline §8(g); IR Art. 40(1)(a), 54). At
 *                         approval it posts E5 — Dr VAT Payable / Cr Customer
 *                         deposits [the credited VAT] — so the deposit is
 *                         gross again and the receipt's un-invoiced remainder
 *                         RISES by the credited amount: that is what unlocks
 *                         the Batch 1B deposit refund (Dr deposits / Cr bank)
 *                         for exactly that part, and nothing else. The 386,
 *                         the receipt and the note are never edited.
 *
 * What it REFUSES, by name: a receipt that is not a customer's deposit; a
 * migrated (opening) deposit — its VAT position is the previous system's
 * record and Z1 is open (pack §8); a deposit classified erroneous, security
 * deposit or unknown (accountant A1: only a genuine taxable advance triggers
 * type 386); an advance with no VAT category; an amount beyond the
 * un-invoiced remainder; a date before the receipt (a tax point cannot
 * precede its cash) or in a closed month.
 */
import { DEFAULT_VAT_RATE, businessToday, ADVANCE_INVOICE_TYPE, ADVANCE_CREDIT_NOTE_TYPE, INVOICE_IN_BOOKS_STATUSES } from "@workspace/shared";
import { invoiceSettlementRepository } from "../repositories/payments.repository";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../lib/errors";
import { round2 } from "../lib/money";
import { assertDateString } from "../lib/writeGuards";
import { paymentsRepository } from "../repositories/payments.repository";
import { advanceInvoicesRepository, type AdvanceFigures } from "../repositories/advanceInvoices.repository";
import { invoicesRepository } from "../repositories/invoices.repository";
import { customersRepository } from "../repositories/customers.repository";
import { checkPeriodOpen } from "./accounting/periodLock";
import { resolveDraftSeller } from "./sellerIdentity";
import { auditService } from "./audit.service";
import { buildInvoiceOut, type PrepaymentOut } from "./invoices.presenter";
import { isNoteType } from "./creditNotes";
import type { Payment } from "@workspace/db";

export type AdvanceVatCategory = "S" | "Z" | "E";

const TOL = 0.005;
const fmt = (n: number) => n.toFixed(2);
const num = (v: unknown) => Number(v ?? 0);

/**
 * Split a VAT-INCLUSIVE amount at a rate into taxable + VAT, each rounded to
 * the halala, such that taxable + vat = amount EXACTLY and vat = taxable ×
 * rate / 100 within ZATCA's rounding (BR-KSA-80 on KSA-31/32; the standard's
 * own example: 100.00 → 86.96 + 13.04). Money rounding goes through
 * `lib/money.ts` — `round2` to compute; the strings are made at the store.
 *
 * Refuses (422) the rare amount whose split cannot satisfy both — the caller
 * chooses another amount rather than the platform storing a VAT figure ZATCA
 * would reject.
 */
export function splitGross(amount: number, ratePercent: number): { taxable: number; vat: number } {
  const gross = round2(amount);
  const rate = ratePercent / 100;
  const taxable = round2(gross / (1 + rate));
  const vat = round2(gross - taxable);
  if (Math.abs(vat - round2(taxable * rate)) > 0.01 + 1e-9) {
    throw new BusinessRuleError(422, {
      error: `${fmt(gross)} cannot be split into a taxable amount and VAT at ${ratePercent}% to the halala (${fmt(taxable)} + ${fmt(vat)}, but ${fmt(taxable)} × ${ratePercent}% = ${fmt(round2(taxable * rate))}). Choose an amount whose VAT splits exactly.`,
      code: "advance_amount_does_not_split",
      field: "amount",
    });
  }
  return { taxable, vat };
}

/** The rate an advance's VAT category carries: S = the standard rate; Z and E = 0. */
export function rateForCategory(category: AdvanceVatCategory): number {
  return category === "S" ? DEFAULT_VAT_RATE : 0;
}

export type ReceiptAdvanceFigures = AdvanceFigures & { unapplied: number; uninvoiced: number };

/** One prepayment row shaped for a response — the 386's identity beside the KSA-31…34 split. */
export function shapePrepayment({ row, advance }: { row: import("@workspace/db").InvoicePrepayment; advance: { id: number; invoiceNumber: string; date: string } }): PrepaymentOut {
  return {
    id: row.id,
    advanceInvoiceId: advance.id,
    advanceInvoiceNumber: advance.invoiceNumber,
    advanceInvoiceDate: advance.date,
    amount: Number(row.amount),
    taxableAmount: Number(row.taxableAmount),
    taxAmount: Number(row.taxAmount),
    taxCategoryCode: row.taxCategoryCode,
    vatRate: Number(row.vatRate),
    allocationId: row.allocationId ?? null,
  };
}

/** The adjustment rows a final invoice carries, shaped for the response. Empty for a note or a 386. */
export async function prepaymentsOf(inv: { id: number; documentType: string }): Promise<PrepaymentOut[]> {
  if (isNoteType(inv.documentType) || inv.documentType === ADVANCE_INVOICE_TYPE) return [];
  return (await advanceInvoicesRepository.prepaymentsOfInvoice(inv.id)).map(shapePrepayment);
}

export type PreparedPrepayment = {
  advanceInvoiceId: number;
  advanceInvoiceNumber: string;
  amount: number;
  taxableAmount: number;
  taxAmount: number;
  taxCategoryCode: AdvanceVatCategory;
  vatRate: number;
};

async function liveCustomerReceipt(paymentId: number): Promise<Payment> {
  const [payment] = await paymentsRepository.lockPayment(paymentId);
  if (!payment) throw new NotFoundError("Payment not found");
  if (payment.direction !== "in" || payment.customerId == null) {
    throw new BusinessRuleError(422, { error: `Receipt ${paymentId} has no identified customer; an advance tax invoice names the customer whose advance it declares.`, code: "classification_requires_customer", field: "paymentId" });
  }
  return payment;
}

export const advanceInvoicesService = {
  /** invoiced / adjusted / open / unapplied / un-invoiced for one receipt, from the repositories' one definition each. */
  async figuresFor(payment: Payment): Promise<ReceiptAdvanceFigures> {
    const allocated = round2((await paymentsRepository.allocatedTotals([payment.id])).get(payment.id) ?? 0);
    const refunded = round2(await paymentsRepository.refundedFrom({ paymentId: payment.id }));
    const unapplied = round2(num(payment.amount) - allocated - refunded);
    const f = (await advanceInvoicesRepository.figuresForPayments([payment.id])).get(payment.id) ?? { invoiced: 0, invoicedVat: 0, adjusted: 0, adjustedVat: 0, credited: 0, creditedVat: 0, open: 0, openVat: 0 };
    return { ...f, unapplied, uninvoiced: round2(unapplied - f.open) };
  },

  /**
   * 🔴 The guard every OTHER use of a receipt's deposit calls (D-4 allocate,
   * refund): only the UN-INVOICED remainder may be touched. What a 386 has
   * declared VAT for is reserved for a final invoice's prepayment
   * adjustment (or a credit note on the 386 — AP-3). Refused by code, with
   * the next step named.
   */
  async assertWithinUninvoiced(payment: Payment, requested: number, act: "allocated" | "refunded"): Promise<ReceiptAdvanceFigures> {
    const f = await this.figuresFor(payment);
    if (f.open > TOL && requested > f.uninvoiced + TOL) {
      throw new BusinessRuleError(409, {
        error:
          `${fmt(f.open)} of receipt ${payment.id} is covered by an advance tax invoice whose VAT is declared; only ${fmt(f.uninvoiced)} can be ${act} this way. ` +
          `Apply the advance on the customer's final invoice (the prepayment adjustment), or issue a credit note against the advance tax invoice first.`,
        code: "advance_invoiced_requires_prepayment_adjustment",
        field: "amount",
        advanceOpenAmount: fmt(f.open),
        uninvoicedAmount: fmt(f.uninvoiced),
      });
    }
    return f;
  },

  /**
   * A DRAFT advance tax invoice from a receipt's classified deposit. The
   * receipt is locked (the same advisory lock allocation takes) so two
   * concurrent drafts cannot both pass the remainder check at approval —
   * and approval re-checks under the same lock.
   */
  async createFromReceipt(
    paymentId: number,
    body: { amount: unknown; date?: string | null; description?: string | null; descriptionAr?: string | null; taxExemptionReasonCode?: string | null; taxExemptionReasonText?: string | null; notes?: string | null; idempotencyKey?: string | null },
    userId: number | null,
  ) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestError("A positive advance amount (VAT inclusive) is required.");
    const gross = round2(amount);
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const [existing] = await invoicesRepository.findByIdempotencyKey(idempotencyKey);
      if (existing) return buildInvoiceOut(existing, null, await invoicesRepository.itemsByInvoice(existing.id));
    }

    const payment = await liveCustomerReceipt(paymentId);
    if (payment.source === "opening") {
      throw new BusinessRuleError(409, {
        error: `Receipt ${paymentId} is a migrated opening deposit. Its VAT position is the previous system's record; issuing a new advance tax invoice for it would declare its VAT a second time (and referencing the old one is the open ZATCA question Z1). Not supported.`,
        code: "opening_deposit_not_advance_invoiced",
        field: "paymentId",
      });
    }
    const [reversal] = await paymentsRepository.findDepositReversal(paymentId);
    if (reversal) throw new BusinessRuleError(409, { error: `Receipt ${paymentId} is a migrated deposit the migration reversed; it is history.`, code: "opening_item_reversed", field: "paymentId" });

    // A1: only a GENUINE TAXABLE ADVANCE triggers type 386. The current classification decides; nothing is inferred.
    const classification = (await paymentsRepository.latestClassifications([paymentId])).get(paymentId) ?? null;
    if (!classification || classification.classification !== "advance") {
      const what = classification?.classification ?? "unknown";
      throw new BusinessRuleError(409, {
        error:
          what === "unknown"
            ? `Receipt ${paymentId} has not been classified. An advance tax invoice is issued only for a deposit the business has said is an advance for a taxable supply — classify it first.`
            : what === "erroneous"
              ? `Receipt ${paymentId} is classified as an erroneous or duplicate payment — not consideration for a supply, so no advance tax invoice is due. Refund it or allocate it.`
              : `Receipt ${paymentId} is classified as a refundable security deposit — not consideration for a supply, so no advance tax invoice is due unless it is applied to a taxable supply (reclassify it as an advance first).`,
        code: "advance_invoice_requires_advance_classification",
        field: "paymentId",
        classification: what,
      });
    }
    const category = classification.vatCategory as AdvanceVatCategory | null;
    if (!category) {
      throw new BusinessRuleError(422, {
        error: `Receipt ${paymentId} is an advance with no VAT category. Reclassify it stating S (standard), Z (zero-rated) or E (exempt) — the advance tax invoice declares VAT at that category.`,
        code: "advance_vat_category_required",
        field: "paymentId",
      });
    }
    const exemptionCode = body.taxExemptionReasonCode?.trim() || null;
    const exemptionText = body.taxExemptionReasonText?.trim() || null;
    if (category !== "S" && !exemptionCode && !exemptionText) {
      throw new BusinessRuleError(422, {
        error: `A ${category === "Z" ? "zero-rated" : "exempt"} advance needs a VAT exemption reason (code or text) — ZATCA requires it on every non-standard line.`,
        code: "advance_exemption_reason_required",
        field: "taxExemptionReasonCode",
      });
    }

    const figures = await this.figuresFor(payment);
    if (gross > figures.uninvoiced + TOL) {
      throw new BusinessRuleError(422, {
        error: `An advance tax invoice for ${fmt(gross)} exceeds the ${fmt(figures.uninvoiced)} of receipt ${paymentId} not yet covered by one (on account ${fmt(figures.unapplied)}, already invoiced and open ${fmt(figures.open)}).`,
        code: "advance_invoice_exceeds_uninvoiced",
        field: "amount",
        uninvoicedAmount: fmt(figures.uninvoiced),
      });
    }

    // The accounting date: the TAX POINT is the receipt (Art. 23(1)), so the
    // default is the receipt date when its month is open, else today; never
    // before the receipt, never into a closed month. A user-chosen date wins.
    let date: string;
    if (body.date) {
      date = assertDateString(body.date, "date");
    } else {
      date = payment.paidAt;
      try {
        await checkPeriodOpen(date);
      } catch {
        date = businessToday();
      }
    }
    if (date < payment.paidAt) {
      throw new BusinessRuleError(422, { error: `The advance tax invoice cannot be dated ${date}, before the receipt of ${payment.paidAt}: the tax point is the receipt.`, code: "advance_invoice_before_receipt", field: "date" });
    }
    await checkPeriodOpen(date);

    const rate = rateForCategory(category);
    const { taxable, vat } = splitGross(gross, rate);
    const [cust] = await customersRepository.findById(payment.customerId!);
    const invoiceNumber = await invoicesRepository.allocateInvoiceNumber(date);
    const draftSeller = await resolveDraftSeller({});
    const description = body.description?.trim() || `Advance payment received ${payment.paidAt} (receipt RCPT-${payment.id})`;
    const descriptionAr = body.descriptionAr?.trim() || null;

    const [inv] = await invoicesRepository.insert({
      invoiceNumber,
      date,
      dueDate: null,
      customerId: payment.customerId,
      documentType: ADVANCE_INVOICE_TYPE,
      advancePaymentId: payment.id,
      subtotal: fmt(taxable),
      vatAmount: fmt(vat),
      discount: "0",
      total: fmt(gross),
      currency: "SAR",
      status: "draft",
      notes: body.notes?.trim() || null,
      idempotencyKey,
      createdBy: userId ?? null,
      sellerName: draftSeller.sellerName,
      sellerVatNumber: draftSeller.sellerVatNumber,
    } as Parameters<typeof invoicesRepository.insert>[0]);
    await invoicesRepository.insertItems([
      {
        invoiceId: inv!.id,
        description,
        descriptionAr,
        quantity: "1",
        unitPrice: fmt(taxable),
        vatRate: fmt(rate),
        vatAmount: fmt(vat),
        discount: "0",
        total: fmt(gross),
        taxCategoryCode: category,
        taxExemptionReasonCode: category === "S" ? null : exemptionCode,
        taxExemptionReasonText: category === "S" ? null : exemptionText,
        unitCode: "PCE",
      },
    ]);
    const items = await invoicesRepository.itemsByInvoice(inv!.id);
    const out = buildInvoiceOut(inv!, cust ?? null, items);
    await auditService.record({ action: "create", entityType: "invoice", entityId: inv!.id, after: { ...out, advanceOf: { paymentId: payment.id, uninvoicedBefore: figures.uninvoiced, classificationId: classification.id } } });
    return out;
  },

  /**
   * Validate a FINAL invoice's prepayment selection at create/update (the
   * draft): each named 386 is issued, is this customer's, and has the open
   * balance; Σ ≤ the invoice total (over-advance default: limit to the
   * invoice — Guideline §8(g) option 2). Returns the rows to insert, each
   * split at the 386's own category and rate (KSA-31…34): a FULL adjustment
   * copies the 386's stored split exactly; a partial one splits the gross the
   * same way the 386 was split. A draft reserves nothing — approval re-checks
   * under the locks.
   */
  async preparePrepayments(customerId: number | null, invoiceTotal: number, input: unknown): Promise<PreparedPrepayment[]> {
    if (input == null) return [];
    if (!Array.isArray(input)) throw new BadRequestError("prepayments must be an array of { advanceInvoiceId, amount }.");
    if (input.length === 0) return [];
    if (customerId == null) {
      throw new BusinessRuleError(422, { error: "An advance tax invoice can only be applied on an invoice that names the customer it was issued to.", code: "prepayment_requires_customer", field: "customerId" });
    }
    const seen = new Set<number>();
    const out: PreparedPrepayment[] = [];
    let sum = 0;
    for (const [i, raw] of (input as Array<{ advanceInvoiceId?: unknown; amount?: unknown }>).entries()) {
      const advanceInvoiceId = Number(raw?.advanceInvoiceId);
      if (!Number.isInteger(advanceInvoiceId) || advanceInvoiceId <= 0) throw new BadRequestError(`prepayments[${i}].advanceInvoiceId must be a positive integer.`);
      if (seen.has(advanceInvoiceId)) throw new BusinessRuleError(422, { error: `Advance tax invoice ${advanceInvoiceId} appears twice — one line per advance invoice.`, code: "prepayment_duplicate_advance", field: "prepayments" });
      seen.add(advanceInvoiceId);
      const [adv] = await invoicesRepository.findById(advanceInvoiceId);
      if (!adv || adv.documentType !== ADVANCE_INVOICE_TYPE) {
        throw new BusinessRuleError(422, { error: `Advance tax invoice ${advanceInvoiceId} does not exist for this organization.`, code: "reference_not_found", field: "prepayments" });
      }
      if (adv.status === "draft" || adv.status === "submitted") {
        throw new BusinessRuleError(409, { error: `Advance tax invoice ${adv.invoiceNumber} has not been issued (status: ${adv.status}); only an issued advance tax invoice can be adjusted.`, code: "prepayment_advance_not_issued", field: "prepayments" });
      }
      if ((adv.customerId ?? null) !== customerId) {
        throw new BusinessRuleError(422, { error: `Advance tax invoice ${adv.invoiceNumber} belongs to a different customer than this invoice.`, code: "prepayment_party_mismatch", field: "prepayments" });
      }
      const advTotal = num(adv.total);
      const bal = (await advanceInvoicesRepository.openBalances([adv.id])).get(adv.id) ?? { adjusted: 0, credited: 0, open: advTotal };
      const adjusted = bal.adjusted;
      const open = bal.open;
      const amount = raw?.amount == null || raw.amount === "" ? open : Number(raw.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestError(`prepayments[${i}].amount must be a positive number (VAT inclusive).`);
      const gross = round2(amount);
      if (gross > open + TOL) {
        throw new BusinessRuleError(409, { error: `Only ${fmt(open)} of advance tax invoice ${adv.invoiceNumber} is still open to adjust (${fmt(advTotal)} issued, ${fmt(adjusted)} already adjusted, ${fmt(bal.credited)} credited); ${fmt(gross)} was requested.`, code: "prepayment_exceeds_open_advance", field: "prepayments", openAmount: fmt(open) });
      }
      const [line] = await invoicesRepository.itemsByInvoice(adv.id);
      const category = (line?.taxCategoryCode ?? "S") as AdvanceVatCategory;
      const rate = num(line?.vatRate ?? rateForCategory(category));
      const split = Math.abs(gross - advTotal) < TOL ? { taxable: num(adv.subtotal), vat: num(adv.vatAmount) } : splitGross(gross, rate);
      sum = round2(sum + gross);
      out.push({ advanceInvoiceId: adv.id, advanceInvoiceNumber: adv.invoiceNumber, amount: gross, taxableAmount: split.taxable, taxAmount: split.vat, taxCategoryCode: category, vatRate: rate });
    }
    if (sum > invoiceTotal + TOL) {
      throw new BusinessRuleError(422, {
        error: `The advances applied total ${fmt(sum)}, more than this invoice's ${fmt(invoiceTotal)}. Apply at most the invoice total; what remains of the advance stays on the customer's deposit for a later invoice (or a credit note against the advance tax invoice).`,
        code: "prepayment_exceeds_invoice",
        field: "prepayments",
      });
    }
    return out;
  },

  /**
   * AP-3 — a DRAFT credit note against an ISSUED advance tax invoice, for
   * part or all of its OPEN balance (issued − applied on final invoices −
   * already credited). One line, the 386's category and rate: a full credit
   * copies the 386's stored split exactly; a partial one is split the same
   * way the 386 was. The 386 row is locked so a concurrent final invoice or
   * note cannot both pass the open check; approval re-checks under the same
   * lock before the ICV is consumed (`assertNoteIsValid`, the note path).
   */
  async creditAdvance(
    advanceInvoiceId: number,
    body: { amount: unknown; reason?: string | null; date?: string | null; notes?: string | null; idempotencyKey?: string | null },
    userId: number | null,
  ) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestError("A positive credit amount (VAT inclusive) is required.");
    const gross = round2(amount);
    const reason = body.reason?.trim();
    if (!reason) throw new BusinessRuleError(400, { code: "note_reason_required", error: "A credit note must state why it is being issued (ZATCA rule BR-KSA-17). For example: \"Order cancelled\" or \"Advance returned\".", field: "reason" });
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const [existing] = await invoicesRepository.findByIdempotencyKey(idempotencyKey);
      if (existing) return buildInvoiceOut(existing, null, await invoicesRepository.itemsByInvoice(existing.id));
    }

    const [adv] = await invoiceSettlementRepository.lockInvoices([advanceInvoiceId]);
    if (!adv) throw new NotFoundError("Advance tax invoice not found");
    if (adv.documentType !== ADVANCE_INVOICE_TYPE) {
      throw new BusinessRuleError(409, { code: "advance_credit_note_original_not_advance", error: `${adv.invoiceNumber} is not an advance tax invoice; only an advance tax invoice (type 386) is credited here. Use an ordinary credit note.`, field: "id" });
    }
    if (!(INVOICE_IN_BOOKS_STATUSES as readonly string[]).includes(adv.status)) {
      throw new BusinessRuleError(409, { code: "note_original_not_issued", error: `Advance tax invoice ${adv.invoiceNumber} has not been issued (status: ${adv.status}); a draft is deleted, not credited.`, field: "id" });
    }
    const bal = (await advanceInvoicesRepository.openBalances([adv.id])).get(adv.id) ?? { adjusted: 0, credited: 0, open: num(adv.total) };
    if (gross > bal.open + TOL) {
      throw new BusinessRuleError(409, {
        code: "advance_credit_note_exceeds_open",
        error: `A credit note for ${fmt(gross)} exceeds the ${fmt(bal.open)} of advance tax invoice ${adv.invoiceNumber} still open (issued ${fmt(num(adv.total))}, applied on final invoices ${fmt(bal.adjusted)}, already credited ${fmt(bal.credited)}). An applied part is corrected by a credit note on the final invoice that applied it.`,
        field: "amount",
        openAmount: fmt(bal.open),
      });
    }
    const date = body.date ? assertDateString(body.date, "date") : businessToday();
    // A cancellation is dated when it happens — never before the document it cancels (IR Art. 40(5): the later period).
    if (date < adv.date) {
      throw new BusinessRuleError(422, { code: "advance_credit_note_before_advance", error: `The credit note cannot be dated ${date}, before advance tax invoice ${adv.invoiceNumber} of ${adv.date}.`, field: "date" });
    }
    await checkPeriodOpen(date);

    const [line] = await invoicesRepository.itemsByInvoice(adv.id);
    const category = (line?.taxCategoryCode ?? "S") as AdvanceVatCategory;
    const rate = num(line?.vatRate ?? rateForCategory(category));
    const split = Math.abs(gross - num(adv.total)) < TOL ? { taxable: num(adv.subtotal), vat: num(adv.vatAmount) } : splitGross(gross, rate);
    const [cust] = await customersRepository.findById(adv.customerId!);
    const invoiceNumber = await invoicesRepository.allocateInvoiceNumber(date);
    const draftSeller = await resolveDraftSeller({});
    const [note] = await invoicesRepository.insert({
      invoiceNumber,
      date,
      dueDate: null,
      customerId: adv.customerId,
      documentType: ADVANCE_CREDIT_NOTE_TYPE,
      originalInvoiceId: adv.id,
      noteReason: reason,
      subtotal: fmt(split.taxable),
      vatAmount: fmt(split.vat),
      discount: "0",
      total: fmt(gross),
      currency: "SAR",
      status: "draft",
      notes: body.notes?.trim() || null,
      idempotencyKey,
      createdBy: userId ?? null,
      sellerName: draftSeller.sellerName,
      sellerVatNumber: draftSeller.sellerVatNumber,
    } as Parameters<typeof invoicesRepository.insert>[0]);
    await invoicesRepository.insertItems([
      {
        invoiceId: note!.id,
        description: line?.description ? `Credit of advance — ${line.description}` : `Credit of advance tax invoice ${adv.invoiceNumber}`,
        descriptionAr: line?.descriptionAr ?? null,
        quantity: "1",
        unitPrice: fmt(split.taxable),
        vatRate: fmt(rate),
        vatAmount: fmt(split.vat),
        discount: "0",
        total: fmt(gross),
        taxCategoryCode: category,
        taxExemptionReasonCode: line?.taxExemptionReasonCode ?? null,
        taxExemptionReasonText: line?.taxExemptionReasonText ?? null,
        unitCode: "PCE",
      },
    ]);
    const items = await invoicesRepository.itemsByInvoice(note!.id);
    const out = buildInvoiceOut(note!, cust ?? null, items);
    await auditService.record({ action: "create", entityType: "invoice", entityId: note!.id, after: { ...out, creditOf: { advanceInvoiceId: adv.id, advanceInvoiceNumber: adv.invoiceNumber, receiptId: adv.advancePaymentId, openBefore: bal.open } } });
    return out;
  },

  /** A customer's issued advance tax invoices with an open balance a final invoice may adjust. */
  async openForCustomer(customerId: number) {
    const [cust] = await customersRepository.findById(customerId);
    if (!cust) throw new NotFoundError("Customer not found");
    const rows = await advanceInvoicesRepository.openForCustomer(customerId);
    return rows.map((r) => ({
      id: r.inv.id,
      invoiceNumber: r.inv.invoiceNumber,
      date: r.inv.date,
      issuedAt: r.inv.issuedAt ? r.inv.issuedAt.toISOString() : null,
      paymentId: r.payment.id,
      receiptDate: r.payment.paidAt,
      total: num(r.inv.total),
      subtotal: num(r.inv.subtotal),
      vatAmount: num(r.inv.vatAmount),
      adjustedAmount: round2(r.adjusted),
      creditedAmount: round2(r.credited),
      openAmount: r.open,
    }));
  },
};

/** One 386 as a receipt's detail card lists it, with its credit notes (AP-3) beneath. */
export type ReceiptAdvanceInvoiceOut = {
  id: number;
  invoiceNumber: string;
  status: string;
  date: string;
  total: number;
  subtotal: number;
  vatAmount: number;
  vatCategory: string | null;
  adjustedAmount: number;
  creditedAmount: number;
  openAmount: number;
  creditNotes: Array<{ id: number; invoiceNumber: string; status: string; date: string; total: number; vatAmount: number; noteReason: string | null }>;
};
