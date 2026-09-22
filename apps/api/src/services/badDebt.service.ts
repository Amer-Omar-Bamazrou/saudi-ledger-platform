/**
 * BAD DEBTS (2026-09-22) — the Art. 40(7) RELIEF as a structured, posted fact,
 * and the Art. 40(9) RECOVERY as a NEW ZATCA DOCUMENT.
 *
 * Authority (VAT Implementing Regulations, ZATCA English text — the Arabic
 * prevails), read 2026-09-22:
 *
 *   Art. 40(7) — a supplier who does not receive all or part of the
 *   consideration MAY reduce Output Tax by the tax on the unpaid part, in the
 *   return where ALL of these hold: (a) the tax was reported and paid; (b) the
 *   customer is not a related person; (c) at least twelve months have passed
 *   since the supply; (d) a certified accountant's certificate says the
 *   unpaid consideration is WRITTEN OFF in the books; (e) above SAR 100,000
 *   unpaid, formal legal procedures were taken without success.
 *   Art. 40(8) — not on the cash basis (Art. 46).
 *   Art. 40(9) — if consideration is later received, tax on it becomes
 *   payable in the return for the period OF THE PAYMENT and "a new Tax
 *   invoice must be issued to reflect the additional amount received".
 *
 * Accountant (2026-09-22, answer 4): the 40(9) document is a NEW ZATCA
 * document, not a journal-posting rule.
 *
 * What is built, and the accounting (one writer per effect):
 *
 *   WRITE OFF WITH RELIEF (an act on an issued invoice, dated `claimedOn`):
 *     Dr Bad debts                 unpaid × net share      [Art. 40(7)(d): the write-off]
 *     Dr VAT Payable               unpaid × VAT share      [the relief: Output Tax reduced]
 *         Cr Accounts Receivable   unpaid (customer)
 *     `written_off_amount` = unpaid; the relief facts stored on the row; the
 *     return shows the relief in BOX 7 (VAT adjustments) for `claimedOn`'s
 *     period. The invoice stays ISSUED (a tax invoice is never un-issued);
 *     every outstanding reader subtracts `written_off_amount`.
 *
 *   RECOVERY (Art. 40(9) — `recovery_invoice`, ZATCA 388, dated at the TAX
 *   POINT = the receipt's date, KSA-5 = the same, IssueDate real):
 *     Dr Bad debts                 VAT on the amount received
 *         Cr VAT Payable           the same                 [payable again, in the payment's period]
 *     and, when the receivable was written off HERE (the money arrived on
 *     account, on the receipt's liability):
 *     Dr <receipt's liability>     amount received (gross)
 *         Cr Bad debts             amount received (the recovery)
 *     with an allocation receipt → recovery invoice for the gross, so the
 *     receipt's unapplied balance, the recovery's `paid_amount` and the GL
 *     agree from the first day. A MIGRATED receivable (relief claimed in the
 *     previous system, the item open at its outstanding amount here) is
 *     settled by the receipt's own D-4 allocation; the recovery invoice then
 *     carries only the VAT leg, and its amount is bounded by that allocation.
 *
 * The recovery document's BT-115 (PayableAmount) equals its total: the
 * standard ties BT-113 (PrepaidAmount) to advance-invoice adjustment lines
 * (BR-KSA-73), so a 40(9) invoice cannot state "already paid" through it; the
 * document's note says so instead. Reasoned from the text, not verified with
 * ZATCA — recorded in the pack.
 */
import { businessToday, INVOICE_IN_BOOKS_STATUSES, RECOVERY_INVOICE_TYPE } from "@workspace/shared";
import { db, migrationOpenItemsTable, type Invoice } from "@workspace/db";
import { eq } from "drizzle-orm";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../lib/errors";
import { money2, round2 } from "../lib/money";
import { assertDateString } from "../lib/writeGuards";
import { invoiceSettlementRepository, paymentsRepository } from "../repositories/payments.repository";
import { invoicesRepository } from "../repositories/invoices.repository";
import { customersRepository } from "../repositories/customers.repository";
import { checkPeriodOpen } from "./accounting/periodLock";
import { postJournalEntry } from "./accounting/glPosting";
import { resolveDraftSeller } from "./sellerIdentity";
import { auditService } from "./audit.service";
import { buildInvoiceOut } from "./invoices.presenter";
import { splitGross } from "./advanceInvoices.service";
import { assertTaxPointPeriodOpen } from "./advanceInvoices.service";

const TOL = 0.005;
const num = (v: unknown) => (v == null ? 0 : Number(v));
const fmt = (n: number) => money2(n);
/** Art. 40(7)(e): above this unpaid amount, formal legal procedures must be evidenced. */
export const BAD_DEBT_LEGAL_PROCEDURES_THRESHOLD = 100_000;

function outstandingOf(inv: Invoice): number {
  return round2(num(inv.total) - num(inv.paidAmount) - num(inv.creditedAmount) - num(inv.writtenOffAmount));
}

/** Twelve months after `date` (Art. 40(7)(c)), YYYY-MM-DD. */
export function twelveMonthsAfter(date: string): string {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y + 1, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

/**
 * The VAT rate the recovered consideration carries. A receivable issued HERE
 * states it (its own VAT ÷ subtotal, its line's category). A MIGRATED opening
 * item is amount-only (Batch 1C), so the rate is the migration's
 * `historicalVat` (rate, or the category's rate) — or an explicit `vatRate`
 * on the request — and NEVER a silent zero: a recovery whose rate nobody
 * stated is refused (`recovery_rate_unknown`).
 */
async function recoveryRateOf(recovered: Invoice, lineCategory: string | null, bodyRate: unknown): Promise<{ rate: number; category: "S" | "Z" | "E" }> {
  const explicit = bodyRate == null || bodyRate === "" ? null : Number(bodyRate);
  if (explicit != null && (!Number.isFinite(explicit) || explicit < 0 || explicit > 100)) throw new BadRequestError("vatRate must be a percentage between 0 and 100.");
  if (!recovered.isOpening) {
    const rate = num(recovered.subtotal) > 0 ? round2((num(recovered.vatAmount) / num(recovered.subtotal)) * 100) : 0;
    return { rate, category: (lineCategory ?? (rate > 0 ? "S" : "Z")) as "S" | "Z" | "E" };
  }
  let hist: { category?: string | null; rate?: number | null } | null = null;
  if (recovered.migrationOpenItemId != null) {
    const [row] = await db.select({ historicalVat: migrationOpenItemsTable.historicalVat }).from(migrationOpenItemsTable).where(eq(migrationOpenItemsTable.id, recovered.migrationOpenItemId));
    hist = (row?.historicalVat as { category?: string | null; rate?: number | null } | null) ?? null;
  }
  const category = ((hist?.category ?? lineCategory ?? "S") as string).toUpperCase() as "S" | "Z" | "E";
  // 🔴 No default for a standard-rated item: the rate was 5% before 1 July 2020 and 15% after — the migration's record or the user's statement says which, never this code.
  const rate = hist?.rate != null ? Number(hist.rate) : explicit != null ? explicit : category === "Z" || category === "E" ? 0 : null;
  if (rate == null || !Number.isFinite(rate)) {
    throw new BusinessRuleError(422, { code: "recovery_rate_unknown", error: `${recovered.invoiceNumber} is a migrated opening item whose VAT rate the migration did not record; state the rate the original tax invoice carried (vatRate) to declare the recovery.`, field: "vatRate" });
  }
  return { rate: round2(rate), category };
}

export const badDebtService = {
  /**
   * Write off an issued invoice's unpaid consideration and claim the
   * Art. 40(7) relief — ONE act, because the relief presupposes the write-off
   * (40(7)(d)) and the write-off without the relief would leave VAT paid on
   * money never received.
   */
  async writeOffWithRelief(
    invoiceId: number,
    body: { claimedOn?: string | null; certificateRef?: unknown; legalRef?: unknown; returnPeriod?: unknown; note?: unknown; idempotencyKey?: string | null },
    userId: number | null,
  ) {
    const claimedOn = body.claimedOn ? assertDateString(body.claimedOn, "claimedOn") : businessToday();
    const certificateRef = typeof body.certificateRef === "string" ? body.certificateRef.trim() : "";
    const legalRef = typeof body.legalRef === "string" && body.legalRef.trim() ? body.legalRef.trim() : null;
    const returnPeriod = typeof body.returnPeriod === "string" && /^\d{4}-\d{2}$/.test(body.returnPeriod) ? body.returnPeriod : claimedOn.slice(0, 7);

    const [inv] = await invoiceSettlementRepository.lockInvoices([invoiceId]);
    if (!inv) throw new NotFoundError("Invoice not found");
    if (inv.documentType !== "invoice" && inv.documentType !== "debit_note") {
      throw new BusinessRuleError(409, { code: "bad_debt_not_a_receivable", error: `${inv.invoiceNumber} is a ${inv.documentType.replace("_", " ")}; only a tax invoice or debit note carries a receivable that can go bad.`, field: "id" });
    }
    if (!(INVOICE_IN_BOOKS_STATUSES as readonly string[]).includes(inv.status)) {
      throw new BusinessRuleError(409, { code: "bad_debt_not_issued", error: `${inv.invoiceNumber} has not been issued (status: ${inv.status}); only an issued invoice's tax was reported (Art. 40(7)(a)).`, field: "id" });
    }
    if (inv.isOpening) {
      throw new BusinessRuleError(409, { code: "opening_item_relief_is_migration_fact", error: `${inv.invoiceNumber} is a migrated opening item: whether bad-debt relief was claimed on it is the previous system's fact, recorded by the migration (badDebtReliefClaimed) — it is not claimed again here.`, field: "id" });
    }
    if (inv.customerId == null) {
      throw new BusinessRuleError(422, { code: "bad_debt_requires_customer", error: `${inv.invoiceNumber} names no customer; a receivable owed by nobody cannot be written off as a bad debt.`, field: "id" });
    }
    if (num(inv.writtenOffAmount) > 0 || inv.badDebtReliefSource) {
      throw new BusinessRuleError(409, { code: "bad_debt_already_written_off", error: `${inv.invoiceNumber} was already written off on ${inv.badDebtReliefClaimedOn} (${fmt(num(inv.writtenOffAmount))}).`, field: "id" });
    }
    const unpaid = outstandingOf(inv);
    if (unpaid <= TOL) {
      throw new BusinessRuleError(409, { code: "bad_debt_nothing_unpaid", error: `${inv.invoiceNumber} has no unpaid consideration to write off.`, field: "id" });
    }
    // Art. 40(7)(c): twelve months from the supply.
    const earliest = twelveMonthsAfter(inv.date);
    if (claimedOn < earliest) {
      throw new BusinessRuleError(422, { code: "bad_debt_relief_too_early", error: `Bad-debt relief on ${inv.invoiceNumber} (supplied ${inv.date}) needs twelve months to have passed (Art. 40(7)(c)) — the earliest claim date is ${earliest}, not ${claimedOn}.`, field: "claimedOn", earliestClaimDate: earliest });
    }
    // Art. 40(7)(d): the certified accountant's write-off certificate.
    if (!certificateRef) {
      throw new BadRequestError("A reference to the certified accountant's certificate that the unpaid consideration is written off in the books is required (Art. 40(7)(d)).");
    }
    // Art. 40(7)(e): above SAR 100,000 unpaid, legal procedures evidenced.
    if (unpaid > BAD_DEBT_LEGAL_PROCEDURES_THRESHOLD && !legalRef) {
      throw new BusinessRuleError(422, { code: "bad_debt_legal_procedures_required", error: `${fmt(unpaid)} unpaid on ${inv.invoiceNumber} exceeds SAR ${BAD_DEBT_LEGAL_PROCEDURES_THRESHOLD.toLocaleString("en-US")}: the relief needs evidence of formal legal procedures taken without success (Art. 40(7)(e)) — a judicial ruling, a bankruptcy, a court order.`, field: "legalRef" });
    }
    await checkPeriodOpen(claimedOn);

    // The unpaid consideration's VAT share — proportional to the document's own split.
    const total = num(inv.total);
    const vatShare = total > 0 ? num(inv.vatAmount) / total : 0;
    const reliefVat = round2(unpaid * vatShare);
    const netPart = round2(unpaid - reliefVat);
    const party = { type: "customer" as const, customerId: inv.customerId };
    const je = await postJournalEntry({
      entryNumber: `WO-${inv.invoiceNumber}`,
      date: claimedOn,
      description: `Bad debt written off: ${inv.invoiceNumber} (unpaid ${fmt(unpaid)}; VAT relief ${fmt(reliefVat)}, Art. 40(7))`,
      reference: inv.invoiceNumber,
      lines: [
        { systemCode: "BAD_DEBT_EXPENSE", accountName: "Bad debts", description: `Write-off of ${inv.invoiceNumber}`, debitAmount: netPart, creditAmount: 0 },
        ...(reliefVat > TOL ? [{ systemCode: "VAT_OUTPUT" as const, accountName: "VAT Payable", description: `Bad-debt relief on ${inv.invoiceNumber} (Art. 40(7))`, debitAmount: reliefVat, creditAmount: 0 }] : []),
        { systemCode: "AR", accountName: "Accounts Receivable", description: `${inv.invoiceNumber} written off`, debitAmount: 0, creditAmount: unpaid, party },
      ],
    });
    const [updated] = await invoicesRepository.update(inv.id, {
      writtenOffAmount: fmt(unpaid),
      badDebtReliefClaimedOn: claimedOn,
      badDebtReliefVatAmount: fmt(reliefVat),
      badDebtReliefReturnPeriod: returnPeriod,
      badDebtReliefCertificateRef: certificateRef,
      badDebtReliefLegalRef: legalRef,
      badDebtReliefSource: "recorded",
      badDebtReliefJournalEntryId: je.id,
    } as Partial<Invoice>);
    const [cust] = await customersRepository.findById(inv.customerId);
    const out = buildInvoiceOut(updated!, cust ?? null, await invoicesRepository.itemsByInvoice(inv.id));
    await auditService.record({
      action: "write_off",
      entityType: "invoice",
      entityId: inv.id,
      before: { outstanding: unpaid, writtenOffAmount: num(inv.writtenOffAmount) },
      after: { writtenOffAmount: unpaid, badDebtReliefVatAmount: reliefVat, claimedOn, returnPeriod, certificateRef, legalRef, journalEntryId: je.id, note: typeof body.note === "string" ? body.note : null },
    });
    return out;
  },

  /**
   * Σ of ISSUED recovery invoices (gross) against one receivable, optionally
   * from one receipt — what has already been declared under Art. 40(9).
   */
  async recoveredSoFar(recoveredInvoiceId: number, paymentId?: number): Promise<number> {
    const rows = await invoicesRepository.recoveriesOf(recoveredInvoiceId);
    return round2(rows.filter((r) => (INVOICE_IN_BOOKS_STATUSES as readonly string[]).includes(r.status) && (paymentId == null || r.recoveryPaymentId === paymentId)).reduce((s, r) => s + num(r.total), 0));
  },

  /**
   * Create the Art. 40(9) document (a DRAFT; approval issues it): the new tax
   * invoice for consideration received on a receivable whose tax was relieved.
   */
  async createRecovery(
    recoveredInvoiceId: number,
    body: { paymentId: unknown; amount: unknown; vatRate?: unknown; notes?: string | null; idempotencyKey?: string | null },
    userId: number | null,
  ) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestError("A positive recovered amount is required.");
    const gross = round2(amount);
    const paymentId = Number(body.paymentId);
    if (!Number.isInteger(paymentId) || paymentId <= 0) throw new BadRequestError("paymentId must be a positive integer.");
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const [existing] = await invoicesRepository.findByIdempotencyKey(idempotencyKey);
      if (existing) return buildInvoiceOut(existing, null, await invoicesRepository.itemsByInvoice(existing.id));
    }

    const [recovered] = await invoiceSettlementRepository.lockInvoices([recoveredInvoiceId]);
    if (!recovered) throw new NotFoundError("Invoice not found");
    if (!recovered.badDebtReliefSource) {
      throw new BusinessRuleError(409, { code: "recovery_requires_relief", error: `${recovered.invoiceNumber} carries no bad-debt relief; a tax invoice under Art. 40(9) is only for consideration received AFTER the tax on it was relieved (Art. 40(7)). Money received on an ordinary open invoice is allocated to it.`, field: "id" });
    }
    const [payment] = await paymentsRepository.lockPayment(paymentId);
    if (!payment) throw new BusinessRuleError(422, { code: "reference_not_found", error: `Receipt ${paymentId} does not exist for this organization.`, field: "paymentId" });
    if (payment.direction !== "in" || payment.customerId == null || payment.customerId !== recovered.customerId) {
      throw new BusinessRuleError(422, { code: "recovery_payment_customer_mismatch", error: `Receipt ${paymentId} is not a receipt from the customer of ${recovered.invoiceNumber}.`, field: "paymentId" });
    }
    if (recovered.badDebtReliefClaimedOn && payment.paidAt < recovered.badDebtReliefClaimedOn) {
      throw new BusinessRuleError(422, { code: "recovery_before_relief", error: `Receipt ${paymentId} of ${payment.paidAt} precedes the relief claimed on ${recovered.badDebtReliefClaimedOn}; only consideration received AFTER the relief is declared under Art. 40(9).`, field: "paymentId" });
    }
    const declared = await this.recoveredSoFar(recovered.id, paymentId);
    const writtenOffHere = num(recovered.writtenOffAmount) > TOL && recovered.badDebtReliefSource === "recorded";
    if (writtenOffHere) {
      // the money is ON ACCOUNT on the receipt's liability — the recovery applies it
      const allocated = round2((await paymentsRepository.allocatedTotals([payment.id])).get(payment.id) ?? 0);
      const refunded = round2(await paymentsRepository.refundedFrom({ paymentId: payment.id }));
      const available = round2(num(payment.amount) - allocated - refunded);
      if (gross > available + TOL) {
        throw new BusinessRuleError(409, { code: "recovery_exceeds_receipt", error: `Receipt ${paymentId} has ${fmt(available)} not yet applied; a recovery of ${fmt(gross)} cannot be declared from it.`, field: "amount", availableAmount: fmt(available) });
      }
      const remaining = round2(num(recovered.writtenOffAmount) - (await this.recoveredSoFar(recovered.id)));
      if (gross > remaining + TOL) {
        throw new BusinessRuleError(409, { code: "recovery_exceeds_written_off", error: `${fmt(gross)} exceeds the ${fmt(remaining)} of ${recovered.invoiceNumber} written off and not yet recovered (written off ${fmt(num(recovered.writtenOffAmount))}).`, field: "amount", remainingAmount: fmt(remaining) });
      }
    } else {
      // a MIGRATED relief: the open item is settled by the receipt's own allocation; the recovery is bounded by it
      const allocs = (await paymentsRepository.allocationsOfPayment(payment.id)).filter((r) => r.reversal == null && r.alloc.invoiceId === recovered.id);
      const settled = round2(allocs.reduce((s, r) => s + num(r.alloc.amount), 0));
      if (settled <= TOL) {
        throw new BusinessRuleError(409, { code: "recovery_requires_allocation", error: `Receipt ${paymentId} is not allocated to ${recovered.invoiceNumber}. For a migrated receivable, allocate the receipt to the invoice first (that settles it); the Art. 40(9) invoice then declares the VAT on the amount allocated.`, field: "paymentId" });
      }
      if (gross > round2(settled - declared) + TOL) {
        throw new BusinessRuleError(409, { code: "recovery_exceeds_allocation", error: `${fmt(gross)} exceeds the ${fmt(round2(settled - declared))} of receipt ${paymentId} allocated to ${recovered.invoiceNumber} and not yet declared under Art. 40(9).`, field: "amount" });
      }
    }
    // The tax point is the payment: dated there, in an open month — or refused with the Art. 63 explanation.
    const date = payment.paidAt;
    await assertTaxPointPeriodOpen({ id: payment.id, paidAt: payment.paidAt });

    const [line] = await invoicesRepository.itemsByInvoice(recovered.id);
    const { rate, category } = await recoveryRateOf(recovered, line?.taxCategoryCode ?? null, body.vatRate);
    const split = splitGross(gross, rate);
    const [cust] = await customersRepository.findById(recovered.customerId!);
    const invoiceNumber = await invoicesRepository.allocateInvoiceNumber(date);
    const draftSeller = await resolveDraftSeller({});
    const [doc] = await invoicesRepository.insert({
      invoiceNumber,
      date,
      dueDate: date,
      customerId: recovered.customerId,
      documentType: RECOVERY_INVOICE_TYPE,
      recoversInvoiceId: recovered.id,
      recoveryPaymentId: payment.id,
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
        invoiceId: doc!.id,
        description: `Consideration received ${payment.paidAt} on ${recovered.invoiceNumber} after bad-debt relief (Art. 40(9))${line?.description ? ` - ${line.description}` : ""}`,
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
    const items = await invoicesRepository.itemsByInvoice(doc!.id);
    const out = buildInvoiceOut(doc!, cust ?? null, items);
    await auditService.record({ action: "create", entityType: "invoice", entityId: doc!.id, after: { ...out, recoveryOf: { invoiceId: recovered.id, invoiceNumber: recovered.invoiceNumber, paymentId: payment.id, reliefClaimedOn: recovered.badDebtReliefClaimedOn, reliefSource: recovered.badDebtReliefSource, writtenOffAmount: num(recovered.writtenOffAmount), declaredBefore: declared } } });
    return out;
  },

  /** The recovery documents issued against one receivable (for its page). */
  async recoveriesOf(invoiceId: number) {
    const rows = await invoicesRepository.recoveriesOf(invoiceId);
    return rows.map((r) => ({ id: r.id, invoiceNumber: r.invoiceNumber, status: r.status, date: r.date, total: num(r.total), vatAmount: num(r.vatAmount), recoveryPaymentId: r.recoveryPaymentId }));
  },
};
